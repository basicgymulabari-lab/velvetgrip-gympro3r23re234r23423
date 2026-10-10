-- Supabase/Postgres columns such as auth.users.email are varchar, while these
-- table-returning RPCs promise text. Postgres does not coerce those result
-- columns for PL/pgSQL RETURN QUERY, so cast them explicitly to keep the CEO
-- dashboard's directory, membership, code, backup, and audit lists readable.

create or replace function public.platform_list_owners()
returns table (
  gym_id uuid,
  gym_name text,
  owner_id uuid,
  owner_email text,
  status text,
  source text,
  current_period_end timestamptz,
  days_remaining integer,
  can_revoke_bonus boolean
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select g.id, g.name::text, m.user_id,
    coalesce(u.email::text, m.email::text, '')::text,
    coalesce(e.status::text, 'free'::text)::text, e.source::text, e.current_period_end,
    case when e.status = 'active' and e.current_period_end > now()
      then ceil(extract(epoch from (e.current_period_end - now())) / 86400)::integer else 0 end,
    coalesce(e.recharge_period_end > now(), false) or coalesce(e.manual_period_end > now(), false)
  from public.gyms g
  join public.gym_users m on m.gym_id = g.id and m.role = 'owner' and m.enabled
  left join auth.users u on u.id = m.user_id
  left join public.subscription_entitlements e on e.gym_id = g.id
  order by g.name, coalesce(u.email::text, m.email::text);
end;
$$;

create or replace function public.platform_list_recharge_codes()
returns table (
  code_id uuid,
  batch_label text,
  duration_days integer,
  created_at timestamptz,
  redeem_by timestamptz,
  assigned_owner text,
  issued_by text,
  redeemed_by text,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  code_status text
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select c.id, c.batch_label::text, c.duration_days, c.created_at, c.valid_until,
    c.target_email::text, issuer.email::text, redeemer.email::text,
    c.redeemed_at, c.revoked_at, revoker.email::text,
    (case when c.revoked_at is not null then 'revoked'
      when c.redeemed_at is not null then 'redeemed'
      when c.valid_until is not null and c.valid_until < now() then 'expired unused'
      else 'unused' end)::text
  from public.recharge_codes c
  left join auth.users issuer on issuer.id = c.created_by
  left join auth.users redeemer on redeemer.id = c.redeemed_by
  left join auth.users revoker on revoker.id = c.revoked_by
  order by c.created_at desc
  limit 100;
end;
$$;

create or replace function public.platform_list_gyms(
  p_search text default '', p_status text default 'all', p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  gym_id uuid, gym_name text, owner_id uuid, owner_name text, owner_email text,
  account_status text, created_at timestamptz, last_activity_at timestamptz,
  member_count integer, subscription_status text, subscription_source text,
  subscription_expires_at timestamptz, days_remaining integer, total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_search text := left(lower(btrim(coalesce(p_search, ''))), 200);
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_status not in ('all', 'pending', 'active', 'suspended', 'archived', 'expired', 'expiring') then
    raise exception 'INVALID_STATUS_FILTER';
  end if;
  return query
  with rows as (
    select g.id, g.name, g.owner_user_id,
      coalesce(u.raw_user_meta_data ->> 'full_name', m.display_name, '') as owner_name,
      coalesce(u.email, m.email, '') as owner_email, g.account_status, g.created_at,
      greatest(g.updated_at, coalesce(w.updated_at, g.updated_at)) as last_activity_at,
      (select count(*)::integer from jsonb_array_elements(case
        when jsonb_typeof(w.state -> 'members') = 'array' then w.state -> 'members'
        else '[]'::jsonb end) member
        where nullif(member ->> 'deletedAt', '') is null) as member_count,
      coalesce(e.status, 'free') as sub_status, e.source as sub_source, e.current_period_end,
      case when e.status = 'active' and e.current_period_end > now()
        then greatest(0, ceil(extract(epoch from (e.current_period_end - now())) / 86400))::integer
        else 0 end as days_remaining
    from public.gyms g
    left join public.gym_users m on m.gym_id = g.id and m.user_id = g.owner_user_id and m.role = 'owner'
    left join auth.users u on u.id = g.owner_user_id
    left join public.gym_workspaces w on w.gym_id = g.id
    left join public.subscription_entitlements e on e.gym_id = g.id
  ), filtered as (
    select * from rows r where
      (v_search = '' or lower(r.name) like '%' || v_search || '%'
        or lower(r.owner_name) like '%' || v_search || '%'
        or lower(r.owner_email) like '%' || v_search || '%' or r.id::text like '%' || v_search || '%')
      and (p_status = 'all' or r.account_status = p_status
        or (p_status = 'expired' and r.sub_status = 'active' and r.current_period_end <= now())
        or (p_status = 'expiring' and r.sub_status = 'active' and r.current_period_end > now()
          and r.current_period_end <= now() + interval '30 days'))
  )
  select f.id, f.name::text, f.owner_user_id, f.owner_name::text, f.owner_email::text,
    f.account_status::text, f.created_at, f.last_activity_at, f.member_count,
    f.sub_status::text, f.sub_source::text, f.current_period_end, f.days_remaining,
    count(*) over ()
  from filtered f order by f.created_at desc
  limit least(greatest(coalesce(p_page_size, 25), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;

create or replace function public.platform_list_audit_logs(
  p_page integer default 1, p_page_size integer default 50
)
returns table (
  id bigint, admin_email text, gym_id uuid, gym_name text, action text,
  result text, metadata jsonb, created_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select a.id, coalesce(u.email::text, 'Removed admin')::text, a.gym_id,
    g.name::text, a.action::text, a.result::text, a.metadata, a.created_at, count(*) over ()
  from public.platform_admin_audit_logs a
  left join auth.users u on u.id = a.admin_user_id
  left join public.gyms g on g.id = a.gym_id
  order by a.created_at desc
  limit least(greatest(coalesce(p_page_size, 50), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 50), 1), 100);
end;
$$;

create or replace function public.platform_list_gym_backups(p_gym_id uuid)
returns table (
  backup_id uuid, gym_id uuid, gym_name text, backup_type text,
  status text, size_bytes bigint, created_at timestamptz, created_by_email text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select b.id, b.gym_id, g.name::text, b.backup_type::text, b.status::text,
    b.size_bytes, b.created_at, coalesce(u.email::text, 'Removed admin')::text
  from public.platform_gym_backups b
  join public.gyms g on g.id = b.gym_id
  left join auth.users u on u.id = b.created_by
  where b.gym_id = p_gym_id order by b.created_at desc limit 100;
end;
$$;

create or replace function public.platform_list_gym_invites()
returns table (
  email text, gym_name text, note text, invited_at timestamptz,
  consumed_at timestamptz, revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select i.email::text, i.gym_name::text, i.note::text, i.invited_at, i.consumed_at, i.revoked_at
  from public.platform_signup_allowlist i order by i.invited_at desc limit 500;
end;
$$;
