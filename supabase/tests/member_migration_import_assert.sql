-- Rollback-only end-to-end import regression test using an isolated QA gym.
-- No customer workspace is read or changed. Every inserted row is rolled back.
-- Run with: npx supabase db query --linked --file supabase/tests/member_migration_import_assert.sql

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_gym uuid := gen_random_uuid();
  v_operation uuid := gen_random_uuid();
  v_state jsonb;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-import-admin@example.invalid', '', now(), now(), now()),
    (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-import-owner@example.invalid', '', now(), now(), now());

  insert into public.platform_admins (user_id, enabled) values (v_admin, true);
  insert into public.gyms (id, owner_user_id, name, is_member_migration_source)
    values (v_gym, v_owner, 'QA Import Source', true);
  insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions)
    values (v_gym, v_owner, 'owner', 'QA Import Owner', 'qa-import-owner@example.invalid', '{}');

  v_state := jsonb_build_object(
    'version', 1, 'auth', jsonb_build_object('email', '', 'passwordHash', ''), 'staff', '{}'::jsonb,
    'settings', jsonb_build_object('gymName', 'QA Import Source', 'adminName', 'QA Import', 'phoneCountry', 'nepal'),
    'members', '[]'::jsonb, 'plans', '[]'::jsonb, 'memberships', '[]'::jsonb, 'payments', '[]'::jsonb,
    'products', '[]'::jsonb, 'sales', '[]'::jsonb, 'activities', '[]'::jsonb,
    'expenses', '[]'::jsonb, 'inquiries', '[]'::jsonb, 'readNotifications', '[]'::jsonb, 'invoiceSeq', 0
  );
  insert into public.gym_workspaces (owner_id, gym_id, revision, state)
    values (v_owner, v_gym, 1, v_state);

  perform set_config('qa.import.admin_id', v_admin::text, true);
  perform set_config('qa.import.owner_id', v_owner::text, true);
  perform set_config('qa.import.gym_id', v_gym::text, true);
  perform set_config('qa.import.operation_id', v_operation::text, true);
end;
$$;

-- An ordinary gym owner must not be able to call the CEO-only import RPC.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.import.owner_id'), true);
do $$
begin
  begin
    perform public.platform_import_migration_members(
      current_setting('qa.import.operation_id')::uuid,
      current_setting('qa.import.gym_id')::uuid,
      '[]'::jsonb,
      true
    );
    raise exception 'a gym owner invoked the platform-only member import';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.import.admin_id'), true);
select set_config('qa.import.first_result', public.platform_import_migration_members(
  current_setting('qa.import.operation_id')::uuid,
  current_setting('qa.import.gym_id')::uuid,
  jsonb_build_array(
    jsonb_build_object('rowNumber', 1, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', '  Aarati Karki  ', 'email', ' Aarati@Example.com ', 'phone', '9812345678',
      'gender', ' Female ', 'dob', '1995-01-02', 'joinDate', '2026-10-01',
      'address', ' Kathmandu ', 'emergencyContact', '9800000000'))
  ), false
)::text, true);
reset role;

-- Replaying an in-progress batch must not append a second copy of the member.
set local role authenticated;
select set_config('qa.import.retry_result', public.platform_import_migration_members(
  current_setting('qa.import.operation_id')::uuid,
  current_setting('qa.import.gym_id')::uuid,
  jsonb_build_array(
    jsonb_build_object('rowNumber', 1, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', '  Aarati Karki  ', 'email', ' Aarati@Example.com ', 'phone', '9812345678',
      'gender', ' Female ', 'dob', '1995-01-02', 'joinDate', '2026-10-01',
      'address', ' Kathmandu ', 'emergencyContact', '9800000000'))
  ), false
)::text, true);
reset role;

do $$
declare
  v_initial jsonb := current_setting('qa.import.first_result')::jsonb;
  v_result jsonb := current_setting('qa.import.retry_result')::jsonb;
  v_gym uuid := current_setting('qa.import.gym_id')::uuid;
begin
  if v_initial ->> 'status' <> 'processing' or (v_initial ->> 'imported')::integer <> 1
    or v_result ->> 'status' <> 'processing' or (v_result ->> 'imported')::integer <> 1
    or (select jsonb_array_length(state -> 'members') from public.gym_workspaces where gym_id = v_gym) <> 1 then
    raise exception 'in-progress import retry duplicated or changed its result: %', v_result;
  end if;
end;
$$;

set local role authenticated;
select set_config('qa.import.result', public.platform_import_migration_members(
  current_setting('qa.import.operation_id')::uuid,
  current_setting('qa.import.gym_id')::uuid,
  jsonb_build_array(
    jsonb_build_object('rowNumber', 2, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', 'Duplicate Member', 'email', 'other@example.com', 'phone', '9812345678',
      'gender', 'male', 'dob', '1994-01-02', 'joinDate', '2026-10-02')),
    jsonb_build_object('rowNumber', 3, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', 'Invalid Date Member', 'email', '', 'phone', '9812345679',
      'gender', 'other', 'dob', '2026-02-30', 'joinDate', '2026-10-03'))
  ), true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.import.result')::jsonb;
  v_gym uuid := current_setting('qa.import.gym_id')::uuid;
  v_operation uuid := current_setting('qa.import.operation_id')::uuid;
  v_state jsonb;
  v_member jsonb;
begin
  select state into v_state from public.gym_workspaces where gym_id = v_gym;
  if v_result ->> 'status' <> 'partial'
    or (v_result ->> 'total')::integer <> 3
    or (v_result ->> 'imported')::integer <> 1
    or (v_result ->> 'skipped')::integer <> 1
    or (v_result ->> 'failed')::integer <> 1 then
    raise exception 'import validation returned unexpected counts: %', v_result;
  end if;
  if jsonb_array_length(v_state -> 'members') <> 1 then
    raise exception 'invalid or duplicate import rows were unexpectedly written';
  end if;
  select value into v_member from jsonb_array_elements(v_state -> 'members') value;
  if v_member ->> 'name' <> 'Aarati Karki'
    or v_member ->> 'email' <> 'aarati@example.com'
    or v_member ->> 'phone' <> '+977 9812345678'
    or v_member ->> 'emergencyContact' <> '+977 9800000000'
    or v_member ->> 'dob' <> '1995-01-02'
    or v_member ->> 'joinDate' <> '2026-10-01' then
    raise exception 'valid imported member was not normalized and stored correctly: %', v_member;
  end if;
  if not exists (select 1 from public.platform_member_migration_items
    where operation_id = v_operation and row_number = 1 and outcome = 'imported')
    or not exists (select 1 from public.platform_member_migration_items
    where operation_id = v_operation and row_number = 2 and outcome = 'skipped')
    or not exists (select 1 from public.platform_member_migration_items
    where operation_id = v_operation and row_number = 3 and outcome = 'failed') then
    raise exception 'import history is missing a row-level outcome';
  end if;
end;
$$;

-- Replaying the same completed import must not append a duplicate member.
set local role authenticated;
select set_config('qa.import.replay_result', public.platform_import_migration_members(
  current_setting('qa.import.operation_id')::uuid,
  current_setting('qa.import.gym_id')::uuid,
  jsonb_build_array(
    jsonb_build_object('rowNumber', 1, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', '  Aarati Karki  ', 'email', ' Aarati@Example.com ', 'phone', '9812345678',
      'gender', ' Female ', 'dob', '1995-01-02', 'joinDate', '2026-10-01',
      'address', ' Kathmandu ', 'emergencyContact', '9800000000')),
    jsonb_build_object('rowNumber', 2, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', 'Duplicate Member', 'email', 'other@example.com', 'phone', '9812345678',
      'gender', 'male', 'dob', '1994-01-02', 'joinDate', '2026-10-02')),
    jsonb_build_object('rowNumber', 3, 'allowDuplicate', false, 'member', jsonb_build_object(
      'name', 'Invalid Date Member', 'email', '', 'phone', '9812345679',
      'gender', 'other', 'dob', '2026-02-30', 'joinDate', '2026-10-03'))
  ), true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.import.replay_result')::jsonb;
  v_gym uuid := current_setting('qa.import.gym_id')::uuid;
begin
  if v_result ->> 'status' <> 'partial' or (v_result ->> 'imported')::integer <> 1 then
    raise exception 'completed import replay returned unexpected result: %', v_result;
  end if;
  if (select jsonb_array_length(state -> 'members') from public.gym_workspaces where gym_id = v_gym) <> 1 then
    raise exception 'replaying import duplicated a member';
  end if;
end;
$$;

rollback;

select 'member migration import assertions passed; QA transaction rolled back' as result;
