-- Read-only assertions for CEO-only live refresh authorization.
do $$
declare
  v_rls boolean;
  v_trigger_count integer;
  v_policy_count integer;
  v_definition text;
begin
  select c.relrowsecurity into v_rls
  from pg_class c
  where c.oid = 'realtime.messages'::regclass;
  if v_rls is distinct from true then
    raise exception 'Realtime message RLS is not enabled';
  end if;

  select count(*) into v_policy_count
  from pg_policies p
  where p.schemaname = 'realtime'
    and p.tablename = 'messages'
    and p.policyname = 'Platform admins can receive platform refresh events'
    and p.cmd = 'SELECT'
    and p.qual ilike '%iv_is_platform_admin%'
    and p.qual ilike '%platform-admin-live%';
  if v_policy_count <> 1 then
    raise exception 'CEO refresh topic is not restricted to platform admins';
  end if;

  select count(*) into v_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (array[
      'gyms', 'gym_users', 'gym_workspaces', 'subscription_entitlements',
      'platform_signup_allowlist', 'recharge_codes',
      'platform_admin_audit_logs', 'platform_gym_backups'
    ])
    and t.tgname = 'platform_admin_live_refresh'
    and not t.tgisinternal;
  if v_trigger_count <> 8 then
    raise exception 'Expected 8 platform refresh triggers, found %', v_trigger_count;
  end if;

  select pg_get_functiondef('public.iv_broadcast_platform_refresh()'::regprocedure)
    into v_definition;
  if v_definition not ilike '%realtime.send%'
    or v_definition not ilike '%platform_data_changed%'
    or v_definition ilike '%new.%'
    or v_definition ilike '%old.%' then
    raise exception 'Platform broadcast must contain refresh metadata only, not row values';
  end if;
end;
$$;
