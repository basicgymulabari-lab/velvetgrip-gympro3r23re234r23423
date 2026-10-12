-- Rollback-only end-to-end migration regression test using isolated QA gyms.
-- No customer workspace is read or changed. Every inserted row is rolled back.
-- Run with: npx supabase db query --linked --file supabase/tests/member_migration_transfer_assert.sql

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_source_owner uuid := gen_random_uuid();
  v_destination_owner uuid := gen_random_uuid();
  v_source_gym uuid := gen_random_uuid();
  v_destination_gym uuid := gen_random_uuid();
  v_operation uuid := gen_random_uuid();
  v_payment_operation uuid := gen_random_uuid();
  v_unmapped_operation uuid := gen_random_uuid();
  v_free_limit_operation uuid := gen_random_uuid();
  v_free_limit_retry_operation uuid := gen_random_uuid();
  v_free_limit_replay_operation uuid := gen_random_uuid();
  v_pre_pro_operation uuid := gen_random_uuid();
  v_already_transferred_operation uuid := gen_random_uuid();
  v_stress_operation uuid := gen_random_uuid();
  v_start text := to_char((now() - interval '5 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_end text := to_char((now() + interval '25 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_state_source jsonb;
  v_state_destination jsonb;
  v_empty_state jsonb;
  v_members jsonb;
  v_memberships jsonb;
  v_payments jsonb;
  v_plans jsonb;
begin
  if exists (select 1 from public.gyms where is_member_migration_source) then
    raise exception 'QA transfer test requires no currently designated source gym';
  end if;

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-migration-admin@example.invalid', '', now(), now(), now()),
    (v_source_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-migration-source@example.invalid', '', now(), now(), now()),
    (v_destination_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-migration-destination@example.invalid', '', now(), now(), now());

  insert into public.platform_admins (user_id, enabled) values (v_admin, true);
  insert into public.gyms (id, owner_user_id, name, is_member_migration_source) values
    (v_source_gym, v_source_owner, 'QA Migration Source', true),
    (v_destination_gym, v_destination_owner, 'QA Migration Destination', false);
  insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions) values
    (v_source_gym, v_source_owner, 'owner', 'QA Source Owner', 'qa-migration-source@example.invalid', '{}'),
    (v_destination_gym, v_destination_owner, 'owner', 'QA Destination Owner', 'qa-migration-destination@example.invalid', '{}');

  v_members := jsonb_build_array(
    jsonb_build_object('id', 'qa-member-profile', 'type', 'member', 'name', 'QA Profile Member',
      'email', 'qa-profile@example.invalid', 'phone', '+977 9800000001', 'gender', 'female',
      'dob', '1995-01-02T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-02T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
    jsonb_build_object('id', 'qa-member-duplicate', 'type', 'member', 'name', 'QA Duplicate Member',
      'email', 'qa-duplicate@example.invalid', 'phone', '+977 9800000002', 'gender', 'male',
      'dob', '1994-01-02T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-03T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
    jsonb_build_object('id', 'qa-member-payments', 'type', 'member', 'name', 'QA Payments Member',
      'email', 'qa-payments@example.invalid', 'phone', '+977 9800000003', 'gender', 'other',
      'dob', '1993-01-02T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-04T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
    jsonb_build_object('id', 'qa-member-unmapped', 'type', 'member', 'name', 'QA Unmapped Member',
      'email', 'qa-unmapped@example.invalid', 'phone', '+977 9800000004', 'gender', 'female',
      'dob', '1992-01-02T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-05T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
    jsonb_build_object('id', 'qa-member-free-limit', 'type', 'member', 'name', 'QA Free Limit Member',
      'email', 'qa-free-limit@example.invalid', 'phone', '+977 9800000005', 'gender', 'female',
      'dob', '1991-01-02T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-06T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
    jsonb_build_object('id', 'qa-member-pre-pro', 'type', 'member', 'name', 'QA Pre-Pro Member',
      'email', 'qa-pre-pro@example.invalid', 'phone', '+977 9800000006', 'gender', 'other',
      'dob', '1990-01-07T00:00:00.000Z', 'address', 'QA address', 'photo', null,
      'joinDate', '2024-01-07T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null)
  );
  v_plans := jsonb_build_array(jsonb_build_object(
    'id', 'qa-source-plan', 'name', 'QA Source Plan', 'price', 1500,
    'joiningFee', 200, 'durationDays', 30, 'description', '', 'active', true, 'locked', false
  ), jsonb_build_object(
    'id', 'qa-source-legacy-plan', 'name', 'QA Archived Plan', 'price', 900,
    'joiningFee', 50, 'durationDays', 14, 'description', 'Legacy term', 'active', false, 'locked', false
  ));
  v_memberships := jsonb_build_array(
    jsonb_build_object('id', 'qa-membership-profile', 'memberId', 'qa-member-profile',
      'planId', 'qa-source-plan', 'startDate', v_start, 'endDate', v_end, 'price', 1500,
      'discount', 100, 'joiningFee', 200, 'frozen', false, 'createdAt', v_start),
    jsonb_build_object('id', 'qa-membership-duplicate', 'memberId', 'qa-member-duplicate',
      'planId', 'qa-source-plan', 'startDate', v_start, 'endDate', v_end, 'price', 1500,
      'discount', 0, 'joiningFee', 0, 'frozen', false, 'createdAt', v_start),
    jsonb_build_object('id', 'qa-membership-payments', 'memberId', 'qa-member-payments',
      'planId', 'qa-source-plan', 'startDate', v_start, 'endDate', v_end, 'price', 1500,
      'discount', 0, 'joiningFee', 0, 'frozen', false, 'createdAt', v_start),
    jsonb_build_object('id', 'qa-membership-payments-old', 'memberId', 'qa-member-payments',
      'planId', 'qa-source-legacy-plan', 'startDate', '2023-01-01T00:00:00.000Z',
      'endDate', '2023-01-14T00:00:00.000Z', 'price', 900, 'discount', 100,
      'joiningFee', 50, 'frozen', true, 'frozenAt', '2023-01-05T00:00:00.000Z',
      'createdAt', '2023-01-01T00:00:00.000Z'),
    jsonb_build_object('id', 'qa-membership-unmapped', 'memberId', 'qa-member-unmapped',
      'planId', 'qa-source-plan', 'startDate', v_start, 'endDate', v_end, 'price', 1500,
      'discount', 0, 'joiningFee', 0, 'frozen', false, 'createdAt', v_start),
    jsonb_build_object('id', 'qa-membership-pre-pro', 'memberId', 'qa-member-pre-pro',
      'planId', 'qa-source-plan', 'startDate', v_start, 'endDate', v_end, 'price', 1500,
      'discount', 0, 'joiningFee', 0, 'frozen', false, 'createdAt', v_start)
  );
  v_payments := jsonb_build_array(
    jsonb_build_object('id', 'qa-payment-profile', 'invoiceNo', 'SRC-001', 'memberId', 'qa-member-profile',
      'membershipId', 'qa-membership-profile', 'kind', 'membership', 'amount', 300, 'method', 'cash',
      'date', v_start, 'note', 'QA retained payment'),
    jsonb_build_object('id', 'qa-payment-duplicate', 'invoiceNo', 'SRC-002', 'memberId', 'qa-member-duplicate',
      'membershipId', 'qa-membership-duplicate', 'kind', 'membership', 'amount', 400, 'method', 'cash',
      'date', v_start, 'note', 'QA duplicate payment'),
    jsonb_build_object('id', 'qa-payment-moved', 'invoiceNo', 'SRC-003', 'memberId', 'qa-member-payments',
      'membershipId', 'qa-membership-payments', 'kind', 'membership', 'amount', 700, 'method', 'upi',
      'date', v_start, 'note', 'QA moved payment'),
    jsonb_build_object('id', 'qa-payment-old-moved', 'invoiceNo', 'SRC-004', 'memberId', 'qa-member-payments',
      'membershipId', 'qa-membership-payments-old', 'kind', 'membership', 'amount', 300, 'method', 'cash',
      'date', '2023-01-05T00:00:00.000Z', 'note', 'QA historical payment')
  );
  v_state_source := jsonb_build_object(
    'version', 1, 'auth', jsonb_build_object('email', '', 'passwordHash', ''), 'staff', '{}'::jsonb,
    'settings', jsonb_build_object('gymName', 'QA Migration Source', 'adminName', 'QA Source',
      'phoneCountry', 'nepal', 'invoicePrefix', 'SRC'),
    'members', v_members, 'plans', v_plans, 'memberships', v_memberships, 'payments', v_payments,
    'products', '[]'::jsonb, 'sales', '[]'::jsonb, 'activities', '[]'::jsonb,
    'expenses', '[]'::jsonb, 'inquiries', '[]'::jsonb, 'readNotifications', '[]'::jsonb, 'invoiceSeq', 3
  );
  v_state_destination := jsonb_build_object(
    'version', 1, 'auth', jsonb_build_object('email', '', 'passwordHash', ''), 'staff', '{}'::jsonb,
    'settings', jsonb_build_object('gymName', 'QA Migration Destination', 'adminName', 'QA Destination',
      'phoneCountry', 'nepal', 'invoicePrefix', 'QA'),
    'members', jsonb_build_array(jsonb_build_object('id', 'qa-destination-duplicate', 'type', 'member',
      'name', 'Existing QA Duplicate', 'email', 'qa-duplicate@example.invalid', 'phone', '+977 9800000002',
      'gender', 'male', 'dob', '1990-01-01T00:00:00.000Z', 'address', '', 'photo', null,
      'joinDate', '2024-01-01T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
      'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null)) ||
      (select jsonb_agg(jsonb_build_object('id', 'qa-destination-limit-' || n, 'type', 'member',
        'name', 'QA Destination Member ' || n, 'email', 'qa-destination-' || n || '@example.invalid',
        'phone', '+977 981000' || lpad(n::text, 4, '0'), 'gender', 'other', 'dob', '1990-01-01',
        'address', '', 'photo', null, 'joinDate', '2024-01-01', 'emergencyContact', '',
        'notes', '[]'::jsonb, 'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null))
        from generate_series(1, 8) as rows(n)),
    'plans', jsonb_build_array(jsonb_build_object('id', 'qa-destination-plan', 'name', 'QA Destination Plan',
      'price', 1500, 'joiningFee', 0, 'durationDays', 30, 'description', '', 'active', true, 'locked', false)),
    'memberships', '[]'::jsonb, 'payments', '[]'::jsonb, 'products', '[]'::jsonb, 'sales', '[]'::jsonb,
    'activities', '[]'::jsonb, 'expenses', '[]'::jsonb, 'inquiries', '[]'::jsonb,
    'readNotifications', '[]'::jsonb, 'invoiceSeq', 42
  );
  insert into public.gym_workspaces (owner_id, gym_id, revision, state) values
    (v_source_owner, v_source_gym, 1, v_state_source),
    (v_destination_owner, v_destination_gym, 1, v_state_destination);

  perform set_config('qa.migration.admin_id', v_admin::text, true);
  perform set_config('qa.migration.source_owner_id', v_source_owner::text, true);
  perform set_config('qa.migration.source_gym_id', v_source_gym::text, true);
  perform set_config('qa.migration.destination_gym_id', v_destination_gym::text, true);
  perform set_config('qa.migration.destination_owner_id', v_destination_owner::text, true);
  perform set_config('qa.migration.operation_id', v_operation::text, true);
  perform set_config('qa.migration.payment_operation_id', v_payment_operation::text, true);
  perform set_config('qa.migration.unmapped_operation_id', v_unmapped_operation::text, true);
  perform set_config('qa.migration.free_limit_operation_id', v_free_limit_operation::text, true);
  perform set_config('qa.migration.free_limit_retry_operation_id', v_free_limit_retry_operation::text, true);
  perform set_config('qa.migration.free_limit_replay_operation_id', v_free_limit_replay_operation::text, true);
  perform set_config('qa.migration.pre_pro_operation_id', v_pre_pro_operation::text, true);
  perform set_config('qa.migration.already_transferred_operation_id', v_already_transferred_operation::text, true);
  perform set_config('qa.migration.stress_operation_id', v_stress_operation::text, true);
  perform set_config('qa.migration.pre_pro_end_date', v_end, true);
end;
$$;

-- Preview counts must be scoped to a member, not the full source roster.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.admin_id'), true);
select set_config('qa.migration.preview_membership_counts', (
  select current_membership::text
  from public.platform_list_member_migration_members(
    current_setting('qa.migration.source_gym_id')::uuid,
    current_setting('qa.migration.destination_gym_id')::uuid,
    '', 1, 100
  )
  where member ->> 'id' = 'qa-member-payments'
), true);
reset role;

do $$
declare
  v_preview jsonb := current_setting('qa.migration.preview_membership_counts')::jsonb;
begin
  if (v_preview ->> 'membership_count')::integer <> 2
    or (v_preview ->> 'active_membership_count')::integer <> 1 then
    raise exception 'Per-member migration preview should show 2 terms (1 active), got: %', v_preview;
  end if;
end;
$$;

-- The CEO preflight must show the same free quota enforced by the workspace
-- trigger, before a transfer is attempted.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.admin_id'), true);
select set_config('qa.migration.free_context', public.platform_get_member_migration_context(
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid
)::text, true);
reset role;

do $$
declare
  v_context jsonb := current_setting('qa.migration.free_context')::jsonb;
begin
  if coalesce((v_context #>> '{destination,has_pro}')::boolean, true)
    or (v_context #>> '{destination,member_count}')::integer <> 9
    or (v_context #>> '{destination,remaining_free_slots}')::integer <> 1 then
    raise exception 'CEO migration preflight did not report the free gym quota accurately: %', v_context;
  end if;
end;
$$;

-- A free gym may accept a member while it remains at or below the 10-member
-- cap. Granting Pro later must not make a safe retry duplicate that member.
set local role authenticated;
select set_config('qa.migration.pre_pro_result', public.platform_transfer_members(
  current_setting('qa.migration.pre_pro_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-pre-pro'], 0, array['qa-member-pre-pro'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  true, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.pre_pro_result')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
  v_pre_pro_destination_member_id text;
begin
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if exists (select 1 from public.subscription_entitlements where gym_id = v_destination
      and status = 'active' and current_period_end > now())
    or v_result ->> 'status' <> 'completed'
    or (v_result ->> 'transferred')::integer <> 1
    or jsonb_array_length(v_destination_state -> 'members') <> 10
    or v_source_state #>> '{members,5,deletedAt}' is null
    or jsonb_array_length(v_destination_state -> 'memberships') <> 1 then
    raise exception 'below-cap member migration should succeed without Pro and appear once: %', v_result;
  end if;
  select member ->> 'id' into v_pre_pro_destination_member_id
  from jsonb_array_elements(v_destination_state -> 'members') member
  where member ->> 'email' = 'qa-pre-pro@example.invalid';
  if v_pre_pro_destination_member_id is null
    or v_destination_state #>> '{memberships,0,memberId}' <> v_pre_pro_destination_member_id
    or v_destination_state #>> '{memberships,0,planId}' <> 'qa-destination-plan'
    or v_destination_state #>> '{memberships,0,endDate}' <> current_setting('qa.migration.pre_pro_end_date') then
    raise exception 'pre-Pro active membership was not mapped with its original expiry date';
  end if;
  perform set_config('qa.migration.pre_pro_destination_member_id', v_pre_pro_destination_member_id, true);
end;
$$;

-- A free destination at its 10-member cap must reject atomically. After Pro is
-- activated, the same source member must remain eligible under a fresh retry.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.admin_id'), true);
do $$
begin
  begin
    perform public.platform_transfer_members(
      current_setting('qa.migration.free_limit_operation_id')::uuid,
      current_setting('qa.migration.source_gym_id')::uuid,
      current_setting('qa.migration.destination_gym_id')::uuid,
      array['qa-member-free-limit'], 0, array['qa-member-free-limit'],
      '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
      false, '{}'::text[], true);
    raise exception 'QA_EXPECTED_FREE_MEMBER_LIMIT';
  exception when others then
    if sqlerrm <> 'SUBSCRIPTION_REQUIRED_MEMBER_LIMIT' then raise; end if;
  end;
end;
$$;
reset role;

do $$
declare
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
begin
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_source_state #>> '{members,4,deletedAt}' is not null
    or jsonb_array_length(v_destination_state -> 'members') <> 10
    or exists (select 1 from public.platform_member_migration_links
      where source_gym_id = v_source and source_member_id = 'qa-member-free-limit')
    or exists (select 1 from public.platform_member_migration_operations
      where id = current_setting('qa.migration.free_limit_operation_id')::uuid) then
    raise exception 'free-limit rejection left partial migration data or an idempotency marker';
  end if;
end;
$$;

insert into public.subscription_entitlements (
  owner_id, gym_id, status, source, manual_period_end, current_period_end, last_verified_at
) values (
  current_setting('qa.migration.destination_owner_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  'active', 'manual', now() + interval '30 days', now() + interval '30 days', now()
)
on conflict (owner_id) do update set gym_id = excluded.gym_id,
  manual_period_end = excluded.manual_period_end, updated_at = now();

set local role authenticated;
select set_config('qa.migration.pro_context', public.platform_get_member_migration_context(
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid
)::text, true);
select set_config('qa.migration.free_limit_retry_result', public.platform_transfer_members(
  current_setting('qa.migration.free_limit_retry_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-free-limit'], 0, array['qa-member-free-limit'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  false, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_context jsonb := current_setting('qa.migration.pro_context')::jsonb;
begin
  if not coalesce((v_context #>> '{destination,has_pro}')::boolean, false)
    or v_context #>> '{destination,remaining_free_slots}' is not null then
    raise exception 'CEO migration preflight did not reflect the activated Pro entitlement: %', v_context;
  end if;
end;
$$;

do $$
declare
  v_result jsonb := current_setting('qa.migration.free_limit_retry_result')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
begin
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_result ->> 'status' <> 'completed' or (v_result ->> 'transferred')::integer <> 1
    or v_source_state #>> '{members,4,deletedAt}' is null
    or jsonb_array_length(v_destination_state -> 'members') <> 11
    or not exists (select 1 from public.platform_member_migration_links
      where source_gym_id = v_source and source_member_id = 'qa-member-free-limit'
        and destination_gym_id = v_destination) then
    raise exception 'retry after activation failed or did not record a confirmed transfer: %', v_result;
  end if;
end;
$$;

-- The pre-Pro transfer already fit the free cap. After Pro is activated, a
-- retry must explain that earlier destination and keep the profile/link singular.
set local role authenticated;
select set_config('qa.migration.free_limit_replay_result', public.platform_transfer_members(
  current_setting('qa.migration.free_limit_replay_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-pre-pro'], 0, array['qa-member-pre-pro'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  false, '{}'::text[], true
)::text, true);
select set_config('qa.migration.free_limit_replay_items', (
  select coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb)::text
  from public.platform_list_member_migration_items(
    current_setting('qa.migration.free_limit_replay_operation_id')::uuid
  ) item
), true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.free_limit_replay_result')::jsonb;
  v_items jsonb := current_setting('qa.migration.free_limit_replay_items')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_destination_state jsonb;
begin
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'transferred')::integer <> 0
    or (v_result ->> 'skipped')::integer <> 1
    or (v_result ->> 'failed')::integer <> 0
    or v_items #>> '{0,outcome}' <> 'skipped'
    or v_items #>> '{0,destination_member_id}' is null
    or coalesce(position('QA Migration Destination' in (v_items #>> '{0,message}')), 0) = 0
    or coalesce(position('No duplicate was created' in (v_items #>> '{0,message}')), 0) = 0
    or jsonb_array_length(v_destination_state -> 'members') <> 11
    or jsonb_array_length(v_destination_state -> 'memberships') <> 1
    or (select count(*) from public.platform_member_migration_links
      where source_gym_id = v_source and source_member_id = 'qa-member-pre-pro') <> 1 then
    raise exception 'retry after Pro activation did not safely report the prior pre-Pro destination: result %, rows %', v_result, v_items;
  end if;
end;
$$;

-- The regular Gym Management workspace loader must expose the previously
-- transferred profile and mapped active membership after the owner receives Pro.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.destination_owner_id'), true);
select set_config('qa.migration.pre_pro_destination_app_load', public.load_current_gym_workspace()::text, true);
reset role;

do $$
declare
  v_state jsonb := current_setting('qa.migration.pre_pro_destination_app_load')::jsonb -> 'state';
  v_member_id text := current_setting('qa.migration.pre_pro_destination_member_id');
begin
  if not exists (select 1 from jsonb_array_elements(v_state -> 'members') member
      where member ->> 'id' = v_member_id and member ->> 'email' = 'qa-pre-pro@example.invalid')
    or not exists (select 1 from jsonb_array_elements(v_state -> 'memberships') membership
      where membership ->> 'memberId' = v_member_id
        and membership ->> 'planId' = 'qa-destination-plan'
        and membership ->> 'endDate' = current_setting('qa.migration.pre_pro_end_date')) then
    raise exception 'destination Gym Management app did not read the original Pro-independent member and active plan';
  end if;
end;
$$;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.admin_id'), true);

set local role authenticated;
select set_config('qa.migration.profile_result', public.platform_transfer_members(
  current_setting('qa.migration.operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-profile', 'qa-member-duplicate'], 0,
  array['qa-member-profile', 'qa-member-duplicate'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  false, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.profile_result')::jsonb;
  v_operation uuid := current_setting('qa.migration.operation_id')::uuid;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
  v_destination_member_id text;
  v_destination_membership_id text;
begin
  if v_result ->> 'status' <> 'partial'
    or (v_result ->> 'transferred')::integer <> 1
    or (v_result ->> 'skipped')::integer <> 1
    or (v_result ->> 'failed')::integer <> 0 then
    raise exception 'profile transfer or duplicate review returned unexpected result: %', v_result;
  end if;

  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_source_state #>> '{members,0,deletedAt}' is null then
    raise exception 'successfully transferred source member was not retained in source Trash';
  end if;
  if v_source_state #>> '{members,1,deletedAt}' is not null then
    raise exception 'duplicate source member was changed instead of skipped';
  end if;
  if jsonb_array_length(v_source_state -> 'memberships') <> 5
    or jsonb_array_length(v_source_state -> 'payments') <> 4 then
    raise exception 'default transfer unexpectedly moved membership or payment history';
  end if;
  if jsonb_array_length(v_destination_state -> 'members') <> 12
    or jsonb_array_length(v_destination_state -> 'memberships') <> 2
    or jsonb_array_length(v_destination_state -> 'payments') <> 0 then
    raise exception 'destination profile or mapped membership was not written as expected';
  end if;
  select member ->> 'id' into v_destination_member_id
    from jsonb_array_elements(v_destination_state -> 'members') member
    where member ->> 'email' = 'qa-profile@example.invalid';
  select membership ->> 'id' into v_destination_membership_id
    from jsonb_array_elements(v_destination_state -> 'memberships') membership
    where membership ->> 'memberId' = v_destination_member_id;
  if v_destination_member_id is null
    or v_destination_member_id = 'qa-member-profile'
    or v_destination_state #>> '{memberships,0,planId}' <> 'qa-destination-plan'
    or v_destination_state #>> '{memberships,0,startDate}' <> v_source_state #>> '{memberships,0,startDate}'
    or v_destination_state #>> '{memberships,0,endDate}' <> v_source_state #>> '{memberships,0,endDate}' then
    raise exception 'destination member ID, plan mapping, or membership dates are incorrect';
  end if;
  if not exists (select 1 from public.platform_member_migration_links
    where source_gym_id = v_source and source_member_id = 'qa-member-profile'
      and destination_gym_id = v_destination and destination_member_id = v_destination_member_id) then
    raise exception 'migration link/idempotency record was not created';
  end if;
  perform set_config('qa.migration.destination_member_id', v_destination_member_id, true);
  perform set_config('qa.migration.destination_membership_id', v_destination_membership_id, true);
end;
$$;

-- Verify the destination gym's normal Gym Management workspace loader returns
-- the moved profile and its plan-mapped active term to the destination owner.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.migration.destination_owner_id'), true);
select set_config('qa.migration.destination_gym_app_load', public.load_current_gym_workspace()::text, true);
reset role;

do $$
declare
  v_state jsonb := current_setting('qa.migration.destination_gym_app_load')::jsonb -> 'state';
  v_member_id text := current_setting('qa.migration.destination_member_id');
begin
  if not exists (select 1 from jsonb_array_elements(v_state -> 'members') member
    where member ->> 'id' = v_member_id and member ->> 'email' = 'qa-profile@example.invalid')
    or not exists (select 1 from jsonb_array_elements(v_state -> 'memberships') membership
      where membership ->> 'memberId' = v_member_id and membership ->> 'planId' = 'qa-destination-plan') then
    raise exception 'Gym Management workspace loader did not return the migrated member and mapped active plan';
  end if;
end;
$$;

-- A replay after an acknowledged result must not duplicate any related row.
set local role authenticated;
select set_config('qa.migration.replay_result', public.platform_transfer_members(
  current_setting('qa.migration.operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-profile', 'qa-member-duplicate'], 0,
  array['qa-member-profile', 'qa-member-duplicate'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  false, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.replay_result')::jsonb;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_destination_state jsonb;
begin
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_result ->> 'status' <> 'partial'
    or jsonb_array_length(v_destination_state -> 'members') <> 12
    or jsonb_array_length(v_destination_state -> 'memberships') <> 2 then
    raise exception 'same-operation retry duplicated or changed transferred records';
  end if;
end;
$$;

-- A fresh retry of an already-linked member must explain where it went.
set local role authenticated;
select set_config('qa.migration.already_transferred_result', public.platform_transfer_members(
  current_setting('qa.migration.already_transferred_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-profile'], 0, array['qa-member-profile'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  false, '{}'::text[], true
)::text, true);
select set_config('qa.migration.already_transferred_items', (
  select coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb)::text
  from public.platform_list_member_migration_items(
    current_setting('qa.migration.already_transferred_operation_id')::uuid
  ) item
), true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.already_transferred_result')::jsonb;
  v_items jsonb := current_setting('qa.migration.already_transferred_items')::jsonb;
  v_destination_member_id text := current_setting('qa.migration.destination_member_id');
begin
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'transferred')::integer <> 0
    or (v_result ->> 'skipped')::integer <> 1
    or (v_result ->> 'failed')::integer <> 0
    or v_items #>> '{0,outcome}' <> 'skipped'
    or v_items #>> '{0,destination_member_id}' <> v_destination_member_id
    or coalesce(position('QA Migration Destination' in (v_items #>> '{0,message}')), 0) = 0
    or coalesce(position('qa-migration-destination@example.invalid' in (v_items #>> '{0,message}')), 0) = 0
    or coalesce(position('No duplicate was created' in (v_items #>> '{0,message}')), 0) = 0 then
    raise exception 'already-transferred retry did not identify the confirmed destination safely: result %, rows %', v_result, v_items;
  end if;
end;
$$;

-- Explicit financial opt-in moves only the selected active membership's payments.
set local role authenticated;
select set_config('qa.migration.payment_result', public.platform_transfer_members(
  current_setting('qa.migration.payment_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-payments'], 0, array['qa-member-payments'],
  '{"qa-source-plan":"qa-destination-plan"}'::jsonb,
  true, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.payment_result')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
  v_moved_invoice text;
  v_payment_member_id text;
  v_payment_membership_id text;
begin
  if v_result ->> 'status' <> 'completed' or (v_result ->> 'transferred')::integer <> 1 then
    raise exception 'explicit active-payment transfer did not complete: %', v_result;
  end if;
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if jsonb_array_length(v_source_state -> 'memberships') <> 3
    or jsonb_array_length(v_source_state -> 'payments') <> 2
    or jsonb_array_length(v_destination_state -> 'memberships') <> 4
    or jsonb_array_length(v_destination_state -> 'payments') <> 2
    or (v_destination_state #>> '{invoiceSeq}')::integer <> 44 then
    raise exception 'explicit payment transfer did not preserve source/destination relationships and invoice sequence';
  end if;
  if (select count(*) from jsonb_array_elements(v_destination_state -> 'memberships') membership
      where membership ->> 'memberId' = (
        select member ->> 'id' from jsonb_array_elements(v_destination_state -> 'members') member
        where member ->> 'email' = 'qa-payments@example.invalid')
        and membership ->> 'frozen' = 'true'
        and membership ->> 'startDate' = '2023-01-01T00:00:00.000Z'
        and membership ->> 'price' = '900') <> 1
    or not exists (select 1 from jsonb_array_elements(v_destination_state -> 'plans') plan
      where plan ->> 'name' = 'QA Archived Plan' and plan ->> 'active' = 'false'
        and plan ->> 'price' = '900' and plan ->> 'durationDays' = '14')
    or (select count(*) from jsonb_array_elements(v_destination_state -> 'payments') payment
      where payment ->> 'memberId' = (
        select member ->> 'id' from jsonb_array_elements(v_destination_state -> 'members') member
        where member ->> 'email' = 'qa-payments@example.invalid')
        and payment ->> 'kind' = 'membership'
        and exists (select 1 from jsonb_array_elements(v_destination_state -> 'memberships') membership
          where membership ->> 'id' = payment ->> 'membershipId'
            and membership ->> 'memberId' = payment ->> 'memberId')) <> 2 then
    raise exception 'historical membership, frozen status, source plan, or linked payment history was not fully transferred';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_destination_state -> 'payments') payment
      where payment ->> 'invoiceNo' in ('QA-000043', 'QA-000044')
        and payment ->> 'note' like '%SRC-%') then
    raise exception 'moved payments did not receive destination invoice numbers and retain source invoice references';
  end if;
end;
$$;

-- No manual plan map is required: the source plan catalog is cloned and the
-- original membership remains available with its dates and price snapshot.
set local role authenticated;
select set_config('qa.migration.unmapped_result', public.platform_transfer_members(
  current_setting('qa.migration.unmapped_operation_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  current_setting('qa.migration.destination_gym_id')::uuid,
  array['qa-member-unmapped'], 0, array['qa-member-unmapped'],
  '{}'::jsonb, false, '{}'::text[], true
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.unmapped_result')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_source_state jsonb;
  v_destination_state jsonb;
begin
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'transferred')::integer <> 1
    or (v_result ->> 'failed')::integer <> 0
    or v_source_state #>> '{members,3,deletedAt}' is null
    or jsonb_array_length(v_destination_state -> 'members') <> 14
    or not exists (select 1 from jsonb_array_elements(v_destination_state -> 'plans') plan
      where plan ->> 'name' = 'QA Source Plan' and plan ->> 'price' = '1500'
        and plan ->> 'durationDays' = '30') then
    raise exception 'automatic plan-catalog copy did not safely transfer a member without a manual map: %', v_result;
  end if;

  if (select count(*) from public.platform_member_migration_items
      where operation_id in (
        current_setting('qa.migration.operation_id')::uuid,
        current_setting('qa.migration.payment_operation_id')::uuid,
        current_setting('qa.migration.unmapped_operation_id')::uuid
      )) <> 4 then
    raise exception 'migration history does not contain one result per processed member';
  end if;
end;
$$;

-- Cross the UI's 100-member RPC batch boundary using disposable QA profiles.
-- The source workspace itself must be entitled before seeding more than 10
-- active records, because the normal member-limit trigger also guards fixtures.
insert into public.subscription_entitlements (
  owner_id, gym_id, status, source, manual_period_end, current_period_end, last_verified_at
) values (
  current_setting('qa.migration.source_owner_id')::uuid,
  current_setting('qa.migration.source_gym_id')::uuid,
  'active', 'manual', now() + interval '30 days', now() + interval '30 days', now()
)
on conflict (owner_id) do update set gym_id = excluded.gym_id,
  manual_period_end = excluded.manual_period_end, current_period_end = excluded.current_period_end,
  updated_at = now();

update public.gym_workspaces w
set state = jsonb_set(w.state, '{members}', coalesce(w.state -> 'members', '[]'::jsonb) || (
  select jsonb_agg(jsonb_build_object(
    'id', 'qa-stress-member-' || lpad(n::text, 4, '0'), 'type', 'member',
    'name', 'QA Stress Member ' || n,
    'email', 'qa-stress-' || n || '@example.invalid',
    -- Shared, otherwise valid contact value verifies that members inside one
    -- source migration do not block one another as false destination matches.
    'phone', '+977 9822222222',
    'gender', 'other', 'dob', '1990-01-01T00:00:00.000Z', 'address', '',
    'photo', null, 'joinDate', '2024-01-01T00:00:00.000Z',
    'emergencyContact', '', 'notes', '[]'::jsonb, 'measurements', '[]'::jsonb,
    'deletedAt', null, 'deletedBy', null
  ) order by n)
  from generate_series(1, 205) as stress(n)
), true)
where w.gym_id = current_setting('qa.migration.source_gym_id')::uuid;

do $$
declare
  v_ids text[];
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
begin
  select array_agg(member ->> 'id' order by member ->> 'id') into v_ids
  from public.gym_workspaces w, jsonb_array_elements(w.state -> 'members') member
  where w.gym_id = v_source and member ->> 'id' like 'qa-stress-member-%';
  if cardinality(v_ids) <> 205 then raise exception 'QA stress set did not contain exactly 205 source profiles'; end if;
  perform set_config('qa.migration.stress_member_ids', to_jsonb(v_ids)::text, true);
end;
$$;

set local role authenticated;
do $$
declare
  v_ids text[];
  v_batch text[];
  v_offset integer;
  v_result jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
begin
  select array_agg(member_id order by ordinality) into v_ids
  from jsonb_array_elements_text(current_setting('qa.migration.stress_member_ids')::jsonb)
    with ordinality as stress(member_id, ordinality);

  for v_offset in 0..204 by 100 loop
    v_batch := v_ids[(v_offset + 1):least(v_offset + 100, cardinality(v_ids))];
    v_result := public.platform_transfer_members(
      current_setting('qa.migration.stress_operation_id')::uuid,
      v_source, v_destination, v_batch, v_offset, v_ids, '{}'::jsonb,
      false, '{}'::text[], v_offset + cardinality(v_batch) >= cardinality(v_ids));
  end loop;
  perform set_config('qa.migration.stress_result', v_result::text, true);
end;
$$;
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.migration.stress_result')::jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_destination_state jsonb;
  v_source_state jsonb;
begin
  select state into v_source_state from public.gym_workspaces where gym_id = v_source;
  select state into v_destination_state from public.gym_workspaces where gym_id = v_destination;
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'transferred')::integer <> 205
    or (select count(*) from jsonb_array_elements(v_destination_state -> 'members') member
      where member ->> 'email' like 'qa-stress-%@example.invalid') <> 205
    or (select count(*) from public.platform_member_migration_links
      where source_gym_id = v_source and destination_gym_id = v_destination
        and source_member_id like 'qa-stress-member-%') <> 205
    or (select count(*) from jsonb_array_elements(v_source_state -> 'members') member
      where member ->> 'id' like 'qa-stress-member-%' and nullif(member ->> 'deletedAt', '') is null) <> 0 then
    raise exception '205-member, three-batch transfer did not persist consistently: %', v_result;
  end if;
end;
$$;

-- Regression: the real template roster uses the repeated placeholder phone
-- 0000000000. It must not make later members look like duplicates, including
-- when those members are sent in a subsequent RPC batch.
update public.gym_workspaces w
set state = jsonb_set(w.state, '{members}', coalesce(w.state -> 'members', '[]'::jsonb) || jsonb_build_array(
  jsonb_build_object('id', 'qa-placeholder-member-1', 'type', 'member', 'name', 'QA Placeholder One',
    'email', 'qa-placeholder-one@example.invalid', 'phone', '+977 0000000000', 'gender', 'other',
    'dob', '1990-01-01T00:00:00.000Z', 'address', '', 'photo', null,
    'joinDate', '2024-01-01T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
    'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
  jsonb_build_object('id', 'qa-placeholder-member-2', 'type', 'member', 'name', 'QA Placeholder Two',
    'email', 'qa-placeholder-two@example.invalid', 'phone', '+977 0000000000', 'gender', 'other',
    'dob', '1990-01-01T00:00:00.000Z', 'address', '', 'photo', null,
    'joinDate', '2024-01-01T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
    'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null),
  jsonb_build_object('id', 'qa-placeholder-member-3', 'type', 'member', 'name', 'QA Placeholder Three',
    'email', 'qa-placeholder-three@example.invalid', 'phone', '+977 0000000000', 'gender', 'other',
    'dob', '1990-01-01T00:00:00.000Z', 'address', '', 'photo', null,
    'joinDate', '2024-01-01T00:00:00.000Z', 'emergencyContact', '', 'notes', '[]'::jsonb,
    'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null)
), true)
where w.gym_id = current_setting('qa.migration.source_gym_id')::uuid;

set local role authenticated;
do $$
declare
  v_first jsonb;
  v_last jsonb;
  v_source uuid := current_setting('qa.migration.source_gym_id')::uuid;
  v_destination uuid := current_setting('qa.migration.destination_gym_id')::uuid;
  v_operation uuid := gen_random_uuid();
  v_ids text[] := array['qa-placeholder-member-1', 'qa-placeholder-member-2', 'qa-placeholder-member-3'];
begin
  v_first := public.platform_transfer_members(v_operation, v_source, v_destination,
    v_ids[1:2], 0, v_ids, '{}'::jsonb, false, '{}'::text[], false);
  v_last := public.platform_transfer_members(v_operation, v_source, v_destination,
    v_ids[3:3], 2, v_ids, '{}'::jsonb, false, '{}'::text[], true);
  if (v_last ->> 'status') <> 'completed'
    or (v_last ->> 'transferred')::integer <> 3
    or (v_last ->> 'skipped')::integer <> 0
    or (v_last ->> 'failed')::integer <> 0 then
    raise exception 'repeated placeholder phone incorrectly blocked migration members: %', v_last;
  end if;
  if (select count(*) from public.platform_member_migration_links
      where source_gym_id = v_source and destination_gym_id = v_destination
        and source_member_id = any(v_ids)) <> 3 then
    raise exception 'placeholder-phone transfer links were not recorded for every member';
  end if;
end;
$$;
reset role;
rollback;

select 'member migration transfer assertions passed; QA transaction rolled back' as result;
