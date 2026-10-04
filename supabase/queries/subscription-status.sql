-- Pro status and remaining days for each gym owner.
select
  gym.name as gym_name,
  coalesce(account.email, membership.email) as owner_email,
  entitlement.source,
  coalesce(entitlement.status, 'free') as status,
  entitlement.current_period_end as pro_expires_at,
  case
    when entitlement.status = 'active' and entitlement.current_period_end > now()
      then ceil(extract(epoch from (entitlement.current_period_end - now())) / 86400)::integer
    else 0
  end as days_remaining
from public.gyms gym
join public.gym_users membership
  on membership.gym_id = gym.id
  and membership.role = 'owner'
  and membership.enabled
left join auth.users account on account.id = membership.user_id
left join public.subscription_entitlements entitlement on entitlement.gym_id = gym.id
order by entitlement.current_period_end desc nulls last;
