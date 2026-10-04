-- Run after 20261004170000_ceo_hub.sql.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.platform_signup_allowlist'::regclass) then
    raise exception 'platform signup allowlist must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.platform_signup_allowlist', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_signup_allowlist', 'SELECT')
    or has_table_privilege('service_role', 'public.platform_signup_allowlist', 'SELECT') then
    raise exception 'direct access to the signup allowlist must be denied';
  end if;

  if has_function_privilege('anon', 'public.platform_add_signup_invite(text,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.platform_add_signup_invite(text,text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.platform_add_signup_invite(text,text)', 'EXECUTE') then
    raise exception 'invite-management RPC grants are too broad or missing';
  end if;

  if has_function_privilege('anon', 'public.platform_export_gym_backup(uuid)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.platform_export_gym_backup(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.platform_export_gym_backup(uuid)', 'EXECUTE') then
    raise exception 'workspace-export RPC grants are too broad or missing';
  end if;

  if has_function_privilege('authenticated', 'public.iv_before_user_created(jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.iv_before_user_created(jsonb)', 'EXECUTE')
    or not has_function_privilege('supabase_auth_admin', 'public.iv_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'signup hook execution grants are too broad or missing';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.platform_export_gym_backup(uuid)'::regprocedure) then
    raise exception 'workspace export must run as a guarded SECURITY DEFINER RPC';
  end if;

  -- A signed-in but non-admin caller can execute the wrapper, but must be
  -- rejected inside Postgres. This simulates a direct API request, not the UI.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  begin
    perform public.platform_list_signup_invites();
    raise exception 'non-admin could list signup invitations';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;

  begin
    perform public.platform_export_gym_backup('00000000-0000-0000-0000-000000000002'::uuid);
    raise exception 'non-admin could export a workspace';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
end;
$$;
