-- Validate that removing CEO MFA did not weaken role authorization or expose
-- the privileged authorization helper to anonymous/service-role API callers.
do $$
declare
  v_admin_guard text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'platform_admins'
      and column_name = 'mfa_enforced_at'
  ) then
    raise exception 'the retired CEO MFA enforcement field must not remain';
  end if;

  if to_regprocedure('public.iv_platform_admin_security_state()') is not null
    or to_regprocedure('public.platform_complete_admin_mfa_enrollment()') is not null then
    raise exception 'retired CEO MFA RPCs must be removed';
  end if;

  if has_function_privilege('anon', 'public.iv_is_platform_admin()', 'EXECUTE')
    or has_function_privilege('service_role', 'public.iv_is_platform_admin()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.iv_is_platform_admin()', 'EXECUTE') then
    raise exception 'platform-admin helper grants must remain authenticated-only';
  end if;

  select pg_get_functiondef('public.iv_is_platform_admin()'::regprocedure) into v_admin_guard;
  if position('platform_admins' in v_admin_guard) = 0
    or position('auth.uid()' in v_admin_guard) = 0
    or position('enabled' in v_admin_guard) = 0
    or position('aal2' in v_admin_guard) > 0
    or position('mfa_enforced_at' in v_admin_guard) > 0 then
    raise exception 'CEO authorization must require an authenticated enabled platform-admin record only';
  end if;
end;
$$;
