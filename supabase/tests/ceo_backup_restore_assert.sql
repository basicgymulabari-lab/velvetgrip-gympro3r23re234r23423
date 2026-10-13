-- Rollback-only backup/restore regression test using an isolated QA gym.
-- No customer workspace is read or changed. Every inserted row is rolled back.
-- Run with: npx supabase db query --linked --file supabase/tests/ceo_backup_restore_assert.sql

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_gym uuid := gen_random_uuid();
  v_state jsonb := jsonb_build_object(
    'version', 1, 'auth', jsonb_build_object('email', '', 'passwordHash', ''),
    'staff', '{}'::jsonb,
    'settings', jsonb_build_object('gymName', 'QA Backup Gym', 'adminName', 'QA Backup', 'phoneCountry', 'nepal'),
    'members', jsonb_build_array(jsonb_build_object('id', 'qa-backup-member', 'type', 'member', 'name', 'QA Backup Member',
      'email', 'qa-backup@example.invalid', 'phone', '+977 9800000000', 'gender', 'other', 'dob', null,
      'address', '', 'photo', null, 'joinDate', '2026-01-01T00:00:00.000Z', 'emergencyContact', '',
      'notes', '[]'::jsonb, 'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null)),
    'plans', jsonb_build_array(jsonb_build_object(
      'id', 'qa-backup-plan', 'name', 'Three Month Package', 'price', 7500,
      'joiningFee', 1500, 'durationDays', 90, 'description', 'QA paid-term plan',
      'active', true, 'deletedAt', null
    )),
    'memberships', jsonb_build_array(jsonb_build_object(
      'id', 'qa-backup-membership', 'memberId', 'qa-backup-member', 'planId', 'qa-backup-plan',
      'startDate', '2026-01-01T00:00:00.000Z', 'endDate', '2026-03-31T00:00:00.000Z',
      'price', 7500, 'discount', 0, 'joiningFee', 1500, 'frozen', false,
      'frozenAt', null, 'createdAt', '2026-01-01T00:00:00.000Z'
    )),
    'payments', jsonb_build_array(jsonb_build_object(
      'id', 'qa-backup-payment', 'invoiceNo', 'QA-PAID-001', 'memberId', 'qa-backup-member',
      'membershipId', 'qa-backup-membership', 'kind', 'membership', 'amount', 9000,
      'method', 'upi', 'date', '2026-01-01T00:00:00.000Z', 'note', 'Paid in full at registration'
    )),
    'products', '[]'::jsonb, 'sales', '[]'::jsonb, 'activities', '[]'::jsonb,
    'expenses', '[]'::jsonb, 'inquiries', '[]'::jsonb, 'readNotifications', '[]'::jsonb, 'invoiceSeq', 0
  );
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-backup-admin@example.invalid', '', now(), now(), now()),
    (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-backup-owner@example.invalid', '', now(), now(), now());

  insert into public.platform_admins (user_id, enabled) values (v_admin, true);
  insert into public.gyms (id, owner_user_id, name) values (v_gym, v_owner, 'QA Backup Gym');
  insert into public.gym_workspaces (owner_id, gym_id, revision, state) values (v_owner, v_gym, 1, v_state);

  if (select account_status from public.gyms where id = v_gym) <> 'active' then
    raise exception 'QA backup gym did not receive the expected active status';
  end if;

  perform set_config('qa.backup.admin_id', v_admin::text, true);
  perform set_config('qa.backup.owner_id', v_owner::text, true);
  perform set_config('qa.backup.gym_id', v_gym::text, true);
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.backup.admin_id'), true);
select set_config('qa.backup.create_result', public.platform_create_gym_backup(
  current_setting('qa.backup.gym_id')::uuid
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.backup.create_result')::jsonb;
  v_gym uuid := current_setting('qa.backup.gym_id')::uuid;
  v_backup_id uuid := (v_result ->> 'backup_id')::uuid;
begin
  if v_result ->> 'status' <> 'successful' or v_backup_id is null or (v_result ->> 'size_bytes')::bigint <= 0 then
    raise exception 'manual backup returned unexpected result: %', v_result;
  end if;
  if not exists (select 1 from public.platform_gym_backups
      where id = v_backup_id and gym_id = v_gym and backup_type = 'manual' and status = 'successful') then
    raise exception 'manual backup record was not stored for the expected QA gym';
  end if;
  perform set_config('qa.backup.backup_id', v_backup_id::text, true);
end;
$$;

-- List/download must return the same snapshot that was captured.
set local role authenticated;
select set_config('qa.backup.list_result', (
  select to_jsonb(backups) from public.platform_list_gym_backups(current_setting('qa.backup.gym_id')::uuid) backups
  where backups.backup_id = current_setting('qa.backup.backup_id')::uuid
)::text, true);
select set_config('qa.backup.download_result', public.platform_download_gym_backup(
  current_setting('qa.backup.backup_id')::uuid
)::text, true);
reset role;

do $$
declare
  v_list jsonb := current_setting('qa.backup.list_result')::jsonb;
  v_snapshot jsonb := current_setting('qa.backup.download_result')::jsonb;
  v_gym uuid := current_setting('qa.backup.gym_id')::uuid;
  v_current jsonb;
begin
  if v_list ->> 'backup_type' <> 'manual' or v_list ->> 'status' <> 'successful'
    or (v_list ->> 'gym_id')::uuid <> v_gym then
    raise exception 'backup listing did not expose the expected backup metadata: %', v_list;
  end if;
  if v_snapshot #>> '{gym,id}' <> v_gym::text
    or v_snapshot #>> '{gym,name}' <> 'QA Backup Gym'
    or v_snapshot #>> '{workspace,state,members,0,id}' <> 'qa-backup-member'
    or v_snapshot #>> '{workspace,state,plans,0,id}' <> 'qa-backup-plan'
    or (v_snapshot #>> '{workspace,state,plans,0,price}')::numeric <> 7500
    or v_snapshot #>> '{workspace,state,memberships,0,id}' <> 'qa-backup-membership'
    or v_snapshot #>> '{workspace,state,memberships,0,startDate}' <> '2026-01-01T00:00:00.000Z'
    or v_snapshot #>> '{workspace,state,memberships,0,endDate}' <> '2026-03-31T00:00:00.000Z'
    or v_snapshot #>> '{workspace,state,payments,0,invoiceNo}' <> 'QA-PAID-001'
    or (v_snapshot #>> '{workspace,state,payments,0,amount}')::numeric <> 9000
    or v_snapshot #>> '{workspace,state,payments,0,date}' <> '2026-01-01T00:00:00.000Z' then
    raise exception 'downloaded snapshot did not contain the original QA workspace: %', v_snapshot;
  end if;

  -- Simulate later edits to the disposable workspace before trying a restore.
  update public.gym_workspaces set state = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(state, '{settings,gymName}', '"QA Backup Gym Changed"'::jsonb, true),
          '{members}', '[]'::jsonb, true
        ),
        '{plans}', '[]'::jsonb, true
      ),
      '{memberships}', '[]'::jsonb, true
    ),
    '{payments}', '[]'::jsonb, true
  ), revision = revision + 1 where gym_id = v_gym;
  select state into v_current from public.gym_workspaces where gym_id = v_gym;
  if jsonb_array_length(v_current -> 'members') <> 0
    or jsonb_array_length(v_current -> 'plans') <> 0
    or jsonb_array_length(v_current -> 'memberships') <> 0
    or jsonb_array_length(v_current -> 'payments') <> 0
    or (select name from public.gyms where id = v_gym) <> 'QA Backup Gym Changed' then
    raise exception 'failed to prepare disposable changed-workspace fixture';
  end if;
end;
$$;

-- An incorrect confirmation must fail closed without changing the synthetic gym.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('qa.backup.admin_id'), true);
do $$
begin
  begin
    perform public.platform_restore_gym_backup(
      current_setting('qa.backup.backup_id')::uuid, 'Wrong Gym Name'
    );
    raise exception 'backup restore accepted an incorrect gym-name confirmation';
  exception when raise_exception then
    if sqlerrm <> 'GYM_NAME_CONFIRMATION_MISMATCH' then raise; end if;
  end;
end;
$$;
reset role;

-- Exact confirmation restores the old workspace and writes a pre-restore safety snapshot.
set local role authenticated;
select set_config('qa.backup.restore_result', public.platform_restore_gym_backup(
  current_setting('qa.backup.backup_id')::uuid, 'QA Backup Gym Changed'
)::text, true);
reset role;

do $$
declare
  v_result jsonb := current_setting('qa.backup.restore_result')::jsonb;
  v_gym uuid := current_setting('qa.backup.gym_id')::uuid;
  v_state jsonb;
begin
  select state into v_state from public.gym_workspaces where gym_id = v_gym;
  if v_result ->> 'status' <> 'restored'
    or (v_result ->> 'gym_id')::uuid <> v_gym
    or (v_result ->> 'workspace_revision')::bigint <> 3
    or v_state #>> '{settings,gymName}' <> 'QA Backup Gym'
    or v_state #>> '{members,0,id}' <> 'qa-backup-member'
    or v_state #>> '{plans,0,id}' <> 'qa-backup-plan'
    or (v_state #>> '{plans,0,price}')::numeric <> 7500
    or v_state #>> '{memberships,0,id}' <> 'qa-backup-membership'
    or v_state #>> '{memberships,0,memberId}' <> 'qa-backup-member'
    or v_state #>> '{memberships,0,planId}' <> 'qa-backup-plan'
    or v_state #>> '{memberships,0,startDate}' <> '2026-01-01T00:00:00.000Z'
    or v_state #>> '{memberships,0,endDate}' <> '2026-03-31T00:00:00.000Z'
    or v_state #>> '{payments,0,invoiceNo}' <> 'QA-PAID-001'
    or v_state #>> '{payments,0,membershipId}' <> 'qa-backup-membership'
    or (v_state #>> '{payments,0,amount}')::numeric <> 9000
    or v_state #>> '{payments,0,date}' <> '2026-01-01T00:00:00.000Z'
    or (select name from public.gyms where id = v_gym) <> 'QA Backup Gym' then
    raise exception 'backup restore did not restore original QA data and name: %, %', v_result, v_state;
  end if;
  if not exists (select 1 from public.platform_gym_backups
      where id = (v_result ->> 'pre_restore_backup_id')::uuid
        and gym_id = v_gym and backup_type = 'pre_restore' and status = 'successful'
        and snapshot #>> '{workspace,state,settings,gymName}' = 'QA Backup Gym Changed'
        and snapshot #>> '{workspace,state,members}' = '[]') then
    raise exception 'restore did not preserve the pre-restore QA snapshot';
  end if;
  if (select count(*) from public.platform_admin_audit_logs
      where gym_id = v_gym and action in ('backup_created', 'backup_downloaded', 'backup_restored')) <> 3 then
    raise exception 'backup/restore audit entries are missing or duplicated';
  end if;
end;
$$;

rollback;

select 'CEO backup/restore assertions passed; QA transaction rolled back' as result;
