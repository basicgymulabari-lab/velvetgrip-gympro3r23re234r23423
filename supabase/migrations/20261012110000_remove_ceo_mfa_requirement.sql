-- Remove the CEO-specific MFA gate at the platform owner's request.
-- CEO access remains authenticated and every privileged RPC still checks the
-- enabled platform_admins role through iv_is_platform_admin().

create or replace function public.iv_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
      and enabled
  )
$$;
revoke all on function public.iv_is_platform_admin() from public, anon, service_role;
grant execute on function public.iv_is_platform_admin() to authenticated;

drop function if exists public.iv_platform_admin_security_state();
drop function if exists public.platform_complete_admin_mfa_enrollment();

alter table public.platform_admins
  drop column if exists mfa_enforced_at;
