-- Enable an enrollment-first MFA rollout for CEO/platform administrators.
-- The first verified TOTP marks the account as MFA-required; every existing
-- platform RPC guarded by iv_is_platform_admin() then requires an AAL2 JWT.

alter table public.platform_admins
  add column if not exists mfa_enforced_at timestamptz;

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
      and (mfa_enforced_at is null or auth.jwt() ->> 'aal' = 'aal2')
  )
$$;
revoke all on function public.iv_is_platform_admin() from public, anon, service_role;
grant execute on function public.iv_is_platform_admin() to authenticated;

-- This bootstrap status reveals only the caller's own admin/MFA state. It lets
-- an AAL1 CEO session reach enrollment/challenge UI without granting console
-- data access or bypassing any privileged RPC guard.
create or replace function public.iv_platform_admin_security_state()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'is_admin', coalesce(bool_or(enabled), false),
    'mfa_enforced', coalesce(bool_or(enabled and mfa_enforced_at is not null), false)
  )
  from public.platform_admins
  where user_id = auth.uid()
$$;
revoke all on function public.iv_platform_admin_security_state() from public, anon, service_role;
grant execute on function public.iv_platform_admin_security_state() to authenticated;

-- Only an authenticated, already-MFA-verified platform administrator can turn
-- enforcement on. It is idempotent and writes a minimal audit record.
create or replace function public.platform_complete_admin_mfa_enrollment()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'AUTH_REQUIRED'; end if;
  if auth.jwt() ->> 'aal' is distinct from 'aal2' then
    raise exception 'PLATFORM_ADMIN_MFA_REQUIRED';
  end if;

  update public.platform_admins
    set mfa_enforced_at = coalesce(mfa_enforced_at, now())
    where user_id = v_user and enabled;
  if not found then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;

  insert into public.platform_admin_audit_logs (admin_user_id, action, result, metadata)
  values (v_user, 'mfa_enforcement_enabled', 'success', jsonb_build_object('factor', 'totp'));
end;
$$;
revoke all on function public.platform_complete_admin_mfa_enrollment() from public, anon, service_role;
grant execute on function public.platform_complete_admin_mfa_enrollment() to authenticated;
