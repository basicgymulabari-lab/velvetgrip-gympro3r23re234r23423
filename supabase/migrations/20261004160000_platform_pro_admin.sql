-- Secure owner-operated platform controls for customer Pro access.
-- Platform admin membership is managed only by the Supabase project owner.

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated, service_role;

alter table public.subscription_entitlements
  add column if not exists manual_period_end timestamptz;
alter table public.recharge_codes
  add column if not exists revoked_by uuid references auth.users(id) on delete set null;

create or replace function public.normalize_subscription_entitlement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_provider_active boolean;
  v_recharge_active boolean;
  v_manual_active boolean;
begin
  v_provider_active := new.provider_status = 'active'
    and new.provider_period_end is not null and new.provider_period_end > now();
  v_recharge_active := new.recharge_period_end is not null and new.recharge_period_end > now();
  v_manual_active := new.manual_period_end is not null and new.manual_period_end > now();

  if v_provider_active or v_recharge_active or v_manual_active then
    new.status := 'active';
    new.current_period_end := greatest(
      coalesce(new.provider_period_end, '-infinity'::timestamptz),
      coalesce(new.recharge_period_end, '-infinity'::timestamptz),
      coalesce(new.manual_period_end, '-infinity'::timestamptz)
    );
    if v_manual_active and new.manual_period_end >= greatest(
      coalesce(new.provider_period_end, '-infinity'::timestamptz),
      coalesce(new.recharge_period_end, '-infinity'::timestamptz)
    ) then
      new.source := 'manual';
    elsif v_recharge_active and new.recharge_period_end >= coalesce(new.provider_period_end, '-infinity'::timestamptz) then
      new.source := 'recharge';
    else
      new.source := new.provider_source;
    end if;
  else
    new.status := coalesce(new.provider_status, 'free');
    new.source := new.provider_source;
    new.current_period_end := greatest(
      coalesce(new.provider_period_end, '-infinity'::timestamptz),
      coalesce(new.recharge_period_end, '-infinity'::timestamptz),
      coalesce(new.manual_period_end, '-infinity'::timestamptz)
    );
    if new.current_period_end = '-infinity'::timestamptz then
      new.current_period_end := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Keep a redeemed offer from being shortened by an overlapping manual grant.
create or replace function public.redeem_recharge_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := auth.uid();
  v_gym uuid := public.iv_current_gym_id();
  v_hash text;
  v_code public.recharge_codes%rowtype;
  v_current public.subscription_entitlements%rowtype;
  v_base timestamptz;
  v_end timestamptz;
begin
  if v_owner is null or v_gym is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.iv_is_current_gym_owner() then raise exception 'OWNER_REQUIRED'; end if;
  if p_code is null or length(trim(p_code)) < 8 then raise exception 'INVALID_RECHARGE_CODE'; end if;

  v_hash := encode(digest(upper(trim(p_code)), 'sha256'), 'hex');
  select * into v_code from public.recharge_codes where code_hash = v_hash for update;
  if not found then raise exception 'INVALID_RECHARGE_CODE'; end if;
  if v_code.revoked_at is not null then raise exception 'RECHARGE_CODE_REVOKED'; end if;
  if v_code.valid_until is not null and v_code.valid_until < now() then raise exception 'RECHARGE_CODE_EXPIRED'; end if;
  if (v_code.target_email is not null or v_code.target_user_id is not null) and
      (v_code.target_user_id is null or v_code.target_user_id <> v_owner) then
    raise exception 'RECHARGE_CODE_NOT_ASSIGNED_TO_ACCOUNT';
  end if;

  if v_code.redeemed_at is not null then
    if v_code.redeemed_by = v_owner then
      select * into v_current from public.subscription_entitlements where gym_id = v_gym;
      return jsonb_build_object(
        'status', coalesce(v_current.status, 'free'),
        'source', v_current.source,
        'current_period_end', v_current.current_period_end,
        'already_redeemed', true
      );
    end if;
    raise exception 'RECHARGE_CODE_ALREADY_USED';
  end if;

  select * into v_current from public.subscription_entitlements where gym_id = v_gym for update;
  v_base := greatest(
    now(), coalesce(v_current.recharge_period_end, now()),
    coalesce(v_current.provider_period_end, now()), coalesce(v_current.manual_period_end, now())
  );
  v_end := v_base + make_interval(days => v_code.duration_days);

  insert into public.subscription_entitlements (
    owner_id, gym_id, status, source, recharge_period_end, current_period_end, last_verified_at, updated_at
  ) values (v_owner, v_gym, 'active', 'recharge', v_end, v_end, now(), now())
  on conflict (owner_id) do update set
    gym_id = excluded.gym_id,
    recharge_period_end = excluded.recharge_period_end,
    last_verified_at = now(), updated_at = now();

  update public.recharge_codes set redeemed_by = v_owner, redeemed_at = now() where id = v_code.id;
  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
  values (v_gym, v_owner, 'owner', 'subscription_recharged', 'subscription', v_gym::text,
    jsonb_build_object('days_added', v_code.duration_days, 'current_period_end', v_end));

  return jsonb_build_object(
    'status', 'active', 'source', 'recharge', 'current_period_end', v_end,
    'days_added', v_code.duration_days, 'already_redeemed', false
  );
end;
$$;
revoke all on function public.redeem_recharge_code(text) from public, anon;
grant execute on function public.redeem_recharge_code(text) to authenticated;

create or replace function public.iv_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and enabled
  )
$$;
revoke all on function public.iv_is_platform_admin() from public, anon, service_role;
grant execute on function public.iv_is_platform_admin() to authenticated;

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
  select g.id, g.name, m.user_id, coalesce(u.email, m.email),
    coalesce(e.status, 'free'), e.source, e.current_period_end,
    case when e.status = 'active' and e.current_period_end > now()
      then ceil(extract(epoch from (e.current_period_end - now())) / 86400)::integer else 0 end,
    coalesce(e.recharge_period_end > now(), false) or coalesce(e.manual_period_end > now(), false)
  from public.gyms g
  join public.gym_users m on m.gym_id = g.id and m.role = 'owner' and m.enabled
  left join auth.users u on u.id = m.user_id
  left join public.subscription_entitlements e on e.gym_id = g.id
  order by g.name, coalesce(u.email, m.email);
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
  select c.id, c.batch_label, c.duration_days, c.created_at, c.valid_until,
    c.target_email, issuer.email, redeemer.email, c.redeemed_at, c.revoked_at, revoker.email,
    case when c.revoked_at is not null then 'revoked'
      when c.redeemed_at is not null then 'redeemed'
      when c.valid_until is not null and c.valid_until < now() then 'expired unused'
      else 'unused' end
  from public.recharge_codes c
  left join auth.users issuer on issuer.id = c.created_by
  left join auth.users redeemer on redeemer.id = c.redeemed_by
  left join auth.users revoker on revoker.id = c.revoked_by
  order by c.created_at desc
  limit 100;
end;
$$;

create or replace function public.platform_generate_recharge_code(
  p_owner_id uuid,
  p_days integer,
  p_valid_days integer,
  p_batch_label text default null
)
returns table (code text, duration_days integer, redeem_by timestamptz, batch_label text, target_email text)
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_email text;
  v_gym_id uuid;
  v_code_id uuid;
  v_generated record;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_owner_id is null then raise exception 'OWNER_REQUIRED'; end if;
  select lower(u.email), m.gym_id into v_email, v_gym_id
  from auth.users u
  join public.gym_users m on m.user_id = u.id and m.role = 'owner' and m.enabled
  where u.id = p_owner_id;
  if v_email is null then raise exception 'OWNER_NOT_FOUND'; end if;
  for v_generated in
    select * from public.generate_recharge_codes(
      p_days := p_days,
      p_count := 1,
      p_valid_days := p_valid_days,
      p_batch_label := p_batch_label,
      p_target_email := v_email
    )
  loop
    update public.recharge_codes
      set created_by = auth.uid()
      where code_hash = encode(digest(v_generated.code, 'sha256'), 'hex');
    select c.id into v_code_id from public.recharge_codes c
      where c.code_hash = encode(digest(v_generated.code, 'sha256'), 'hex');
    insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
      values (v_gym_id, auth.uid(), 'system', 'recharge_code_issued', 'recharge_code', v_code_id::text,
        jsonb_build_object('duration_days', v_generated.duration_days, 'redeem_by', v_generated.redeem_by));
    code := v_generated.code;
    duration_days := v_generated.duration_days;
    redeem_by := v_generated.redeem_by;
    batch_label := v_generated.batch_label;
    target_email := v_generated.target_email;
    return next;
  end loop;
end;
$$;

create or replace function public.platform_grant_manual_pro(p_gym_id uuid, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_admin uuid := auth.uid();
  v_owner uuid;
  v_end timestamptz;
  v_entitlement public.subscription_entitlements%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'DURATION_DAYS_MUST_BE_1_TO_366'; end if;
  select m.user_id into v_owner from public.gym_users m
    where m.gym_id = p_gym_id and m.role = 'owner' and m.enabled;
  if v_owner is null then raise exception 'OWNER_NOT_FOUND'; end if;

  select * into v_entitlement from public.subscription_entitlements where gym_id = p_gym_id for update;
  v_end := greatest(
    now(), coalesce(v_entitlement.provider_period_end, now()),
    coalesce(v_entitlement.recharge_period_end, now()),
    coalesce(v_entitlement.manual_period_end, now())
  ) + make_interval(days => p_days);

  insert into public.subscription_entitlements (
    owner_id, gym_id, manual_period_end, last_verified_at, updated_at
  ) values (v_owner, p_gym_id, v_end, now(), now())
  on conflict (owner_id) do update set
    gym_id = excluded.gym_id,
    manual_period_end = excluded.manual_period_end,
    last_verified_at = now(), updated_at = now();

  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
  values (p_gym_id, v_admin, 'system', 'manual_pro_granted', 'subscription', p_gym_id::text,
    jsonb_build_object('days_added', p_days, 'new_manual_expiry', v_end));

  return jsonb_build_object('status', 'active', 'current_period_end', v_end, 'days_added', p_days);
end;
$$;

create or replace function public.platform_revoke_pro(p_gym_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_admin uuid := auth.uid();
  v_entitlement public.subscription_entitlements%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  update public.subscription_entitlements
  set recharge_period_end = null,
      manual_period_end = null,
      last_verified_at = now(), updated_at = now()
  where gym_id = p_gym_id and (recharge_period_end is not null or manual_period_end is not null)
  returning * into v_entitlement;
  if not found then raise exception 'NO_REVOCABLE_PRO_ACCESS'; end if;

  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
  values (p_gym_id, v_admin, 'system', 'manual_pro_revoked', 'subscription', p_gym_id::text,
    jsonb_build_object('remaining_provider_period_end', v_entitlement.provider_period_end));

  return jsonb_build_object(
    'status', v_entitlement.status,
    'source', v_entitlement.source,
    'current_period_end', v_entitlement.current_period_end,
    'provider_still_active', v_entitlement.provider_status = 'active'
      and v_entitlement.provider_period_end > now()
  );
end;
$$;

create or replace function public.platform_revoke_recharge_code(p_code_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  update public.recharge_codes
  set revoked_at = now(), revoked_by = auth.uid()
  where id = p_code_id and redeemed_at is null and revoked_at is null;
  if not found then raise exception 'CODE_NOT_UNUSED'; end if;
end;
$$;

revoke all on function public.platform_list_owners() from public, anon, service_role;
revoke all on function public.platform_list_recharge_codes() from public, anon, service_role;
revoke all on function public.platform_generate_recharge_code(uuid, integer, integer, text) from public, anon, service_role;
revoke all on function public.platform_grant_manual_pro(uuid, integer) from public, anon, service_role;
revoke all on function public.platform_revoke_pro(uuid) from public, anon, service_role;
revoke all on function public.platform_revoke_recharge_code(uuid) from public, anon, service_role;
grant execute on function public.platform_list_owners() to authenticated;
grant execute on function public.platform_list_recharge_codes() to authenticated;
grant execute on function public.platform_generate_recharge_code(uuid, integer, integer, text) to authenticated;
grant execute on function public.platform_grant_manual_pro(uuid, integer) to authenticated;
grant execute on function public.platform_revoke_pro(uuid) to authenticated;
grant execute on function public.platform_revoke_recharge_code(uuid) to authenticated;
