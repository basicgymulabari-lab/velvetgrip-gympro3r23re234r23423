-- Receptionists share the gym's Pro feature entitlement, but billing details
-- and subscription_entitlements remain owner-only under RLS. Expose only the
-- minimal read-only summary through the authenticated gym-context RPC, which
-- already verifies that the caller belongs to the gym.

create or replace function public.get_current_gym_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_membership public.gym_users%rowtype;
  v_gym public.gyms%rowtype;
  v_entitlement public.subscription_entitlements%rowtype;
begin
  if v_user is null then
    return null;
  end if;

  select * into v_membership
  from public.gym_users
  where user_id = v_user
  limit 1;
  if not found then
    return null;
  end if;

  select * into v_gym
  from public.gyms
  where id = v_membership.gym_id;

  select * into v_entitlement
  from public.subscription_entitlements
  where gym_id = v_membership.gym_id;

  return jsonb_build_object(
    'gym_id', v_membership.gym_id,
    'role', v_membership.role,
    'permissions', coalesce(v_membership.permissions, '{}'::jsonb),
    'display_name', v_membership.display_name,
    'email', v_membership.email,
    'enabled', v_membership.enabled,
    'gym_name', v_gym.name,
    'account_status', v_gym.account_status,
    'subscription_status', coalesce(v_entitlement.status, 'free'),
    'subscription_source', v_entitlement.source,
    'subscription_current_period_end', v_entitlement.current_period_end,
    -- Preserve the existing keys for already-released clients.
    'subscription_expires_at', v_entitlement.current_period_end,
    'subscription_expired', v_entitlement.current_period_end is not null
      and v_entitlement.current_period_end <= now()
      and (
        v_entitlement.provider_period_end is not null
        or v_entitlement.recharge_period_end is not null
        or v_entitlement.manual_period_end is not null
      )
  );
end;
$$;

revoke all on function public.get_current_gym_context()
  from public, anon, service_role;
grant execute on function public.get_current_gym_context() to authenticated;
