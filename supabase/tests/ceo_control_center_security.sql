-- CEO Control Center privilege-boundary assertions.
-- Run after migration 20261005090000_ceo_control_center.sql.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.platform_admin_audit_logs'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.platform_gym_backups'::regclass) then
    raise exception 'CEO audit and backup tables must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.platform_gym_backups', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_gym_backups', 'SELECT')
    or has_table_privilege('service_role', 'public.platform_gym_backups', 'SELECT') then
    raise exception 'backup snapshots must not be directly readable through table grants';
  end if;

  if has_column_privilege('authenticated', 'public.gyms', 'subscription_status', 'UPDATE')
    or has_column_privilege('authenticated', 'public.gyms', 'owner_user_id', 'UPDATE')
    or has_column_privilege('authenticated', 'public.gyms', 'account_status', 'UPDATE') then
    raise exception 'gym owners must not edit plan, owner, or platform account status columns';
  end if;
  if has_column_privilege('authenticated', 'public.gyms', 'name', 'UPDATE') then
    raise exception 'gym profile name changes must pass through the validated workspace RPC';
  end if;

  if has_function_privilege('anon', 'public.platform_dashboard_summary()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.platform_dashboard_summary()', 'EXECUTE')
    or has_function_privilege('anon', 'public.platform_restore_gym_backup(uuid,text)', 'EXECUTE') then
    raise exception 'CEO functions must be authenticated-only and still enforce CEO identity internally';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.platform_restore_gym_backup(uuid,text)'::regprocedure)
    or not (select prosecdef from pg_proc where oid = 'public.platform_create_gym_backup(uuid)'::regprocedure)
    or not (select prosecdef from pg_proc where oid = 'public.platform_list_gyms(text,text,integer,integer)'::regprocedure) then
    raise exception 'privileged CEO operations must run through guarded SECURITY DEFINER functions';
  end if;

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  begin
    perform public.platform_dashboard_summary();
    raise exception 'a normal account could read platform-wide metrics';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;

  begin
    perform public.platform_create_gym_backup('00000000-0000-0000-0000-000000000002'::uuid);
    raise exception 'a normal account could create a platform backup';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;

  if public.iv_can_write_private_object('00000000-0000-0000-0000-000000000002/members/photo.png') then
    raise exception 'an unassociated account can write a private tenant object';
  end if;
end;
$$;
