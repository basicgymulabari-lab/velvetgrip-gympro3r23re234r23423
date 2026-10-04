-- End-to-end recharge generation/redemption regression test.
-- All fixtures, the generated code, and resulting entitlement are rolled back.
-- Run with: npx supabase db query --linked --file supabase/tests/recharge_redemption_assert.sql

begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('68000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-recharge-a@example.invalid', '', now(), now(), now()),
  ('69000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-recharge-b@example.invalid', '', now(), now(), now());

insert into public.gyms (id, owner_user_id, name) values
  ('6a000000-0000-0000-0000-00000000000a', '68000000-0000-0000-0000-000000000008', 'Recharge QA Gym A'),
  ('6b000000-0000-0000-0000-00000000000b', '69000000-0000-0000-0000-000000000009', 'Recharge QA Gym B');

insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions) values
  ('6a000000-0000-0000-0000-00000000000a', '68000000-0000-0000-0000-000000000008', 'owner', 'QA Recharge A', 'qa-recharge-a@example.invalid', '{}'),
  ('6b000000-0000-0000-0000-00000000000b', '69000000-0000-0000-0000-000000000009', 'owner', 'QA Recharge B', 'qa-recharge-b@example.invalid', '{}');

insert into public.platform_admins (user_id, enabled)
values ('68000000-0000-0000-0000-000000000008', true);

-- Exercise the same generator used by the SQL Editor query without revealing its output.
do $$
declare
  v_code text;
  v_assigned_code text;
begin
  select code into v_code
  from public.generate_recharge_codes(30, 1, 30, 'rollback regression test');
  perform set_config('audit.recharge_code', v_code, true);

  select code into v_assigned_code
  from public.generate_recharge_codes(
    p_days := 45,
    p_count := 1,
    p_valid_days := 30,
    p_batch_label := 'assigned rollback regression test',
    p_target_email := 'qa-recharge-a@example.invalid'
  );
  perform set_config('audit.assigned_recharge_code', v_assigned_code, true);
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '68000000-0000-0000-0000-000000000008', true);

do $$
declare
  v_result jsonb;
  v_entitlement public.subscription_entitlements%rowtype;
  v_issued record;
  v_code_id uuid;
begin
  v_result := public.platform_grant_manual_pro('6a000000-0000-0000-0000-00000000000a', 15);
  if v_result ->> 'status' <> 'active' or (v_result ->> 'days_added')::integer <> 15 then
    raise exception 'platform administrator could not grant manual Pro';
  end if;

  select * into v_issued from public.platform_generate_recharge_code(
    '68000000-0000-0000-0000-000000000008', 7, 30, 'manager revoke regression'
  );
  select id into v_code_id from public.recharge_codes
    where code_hash = encode(digest(v_issued.code, 'sha256'), 'hex');
  if v_code_id is null or v_issued.target_email <> 'qa-recharge-a@example.invalid' then
    raise exception 'admin code was not generated for its selected account';
  end if;
  perform set_config('audit.manager_recharge_code', v_issued.code, true);
  perform public.platform_revoke_recharge_code(v_code_id);
  if not exists (select 1 from public.recharge_codes where id = v_code_id and revoked_at is not null and revoked_by = auth.uid()) then
    raise exception 'unused recharge code was not revoked';
  end if;

  v_result := public.redeem_recharge_code(current_setting('audit.recharge_code'));
  if v_result ->> 'status' <> 'active' or v_result ->> 'already_redeemed' <> 'false' then
    raise exception 'fresh code did not activate Pro';
  end if;

  select * into v_entitlement
  from public.subscription_entitlements
  where owner_id = auth.uid();
  if not found
    or v_entitlement.gym_id <> '6a000000-0000-0000-0000-00000000000a'::uuid
    or v_entitlement.source <> 'recharge'
    or v_entitlement.status <> 'active'
    or v_entitlement.recharge_period_end < now() + interval '29 days' then
    raise exception 'recharge entitlement was not attached to the owner gym';
  end if;

  v_result := public.redeem_recharge_code(current_setting('audit.recharge_code'));
  if v_result ->> 'already_redeemed' <> 'true' then
    raise exception 'same-account retry was not idempotent';
  end if;

  begin
    perform public.redeem_recharge_code('IV-202610-DELIBERATELY-INVALID-CODE');
    raise exception 'invalid code was accepted';
  exception
    when raise_exception then
      if sqlerrm <> 'INVALID_RECHARGE_CODE' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '69000000-0000-0000-0000-000000000009', true);
do $$
declare
  v_owner uuid := auth.uid();
begin
  begin
    perform public.platform_list_owners();
    raise exception 'non-admin account read the platform-wide owner list';
  exception
    when raise_exception then
      if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;

  begin
    perform public.redeem_recharge_code(current_setting('audit.recharge_code'));
    raise exception 'code was redeemed by a second account';
  exception
    when raise_exception then
      if sqlerrm <> 'RECHARGE_CODE_ALREADY_USED' then raise; end if;
  end;

  begin
    perform public.redeem_recharge_code(current_setting('audit.assigned_recharge_code'));
    raise exception 'account B redeemed a code assigned to account A';
  exception
    when raise_exception then
      if sqlerrm <> 'RECHARGE_CODE_NOT_ASSIGNED_TO_ACCOUNT' then raise; end if;
  end;
  begin
    perform public.redeem_recharge_code(current_setting('audit.manager_recharge_code'));
    raise exception 'revoked code was redeemed';
  exception
    when raise_exception then
      if sqlerrm <> 'RECHARGE_CODE_REVOKED' then raise; end if;
  end;
  if exists (
    select 1 from public.subscription_entitlements where owner_id = v_owner
  ) then
    raise exception 'second account received an entitlement';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '68000000-0000-0000-0000-000000000008', true);
do $$
declare
  v_result jsonb;
  v_entitlement public.subscription_entitlements%rowtype;
begin
  perform public.platform_grant_manual_pro('6a000000-0000-0000-0000-00000000000a', 15);
  v_result := public.redeem_recharge_code(current_setting('audit.assigned_recharge_code'));
  if v_result ->> 'status' <> 'active' or (v_result ->> 'days_added')::integer <> 45 then
    raise exception 'assigned code did not grant its configured duration';
  end if;
  select * into v_entitlement
  from public.subscription_entitlements
  where owner_id = auth.uid();
  if v_entitlement.recharge_period_end < now() + interval '104 days' then
    raise exception 'assigned code duration was not added to current Pro access';
  end if;

  perform public.platform_revoke_pro('6a000000-0000-0000-0000-00000000000a');
  select * into v_entitlement from public.subscription_entitlements where owner_id = auth.uid();
  if v_entitlement.status = 'active' and v_entitlement.current_period_end > now() then
    raise exception 'platform administrator could not revoke recharge/manual Pro access';
  end if;
end;
$$;

reset role;
rollback;

select 'recharge generation/redemption assertions passed' as result;
