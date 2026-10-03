create extension if not exists pgcrypto with schema extensions;

create table if not exists public.subscription_entitlements (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'free' check (status in ('free', 'active', 'past_due', 'canceled', 'expired')),
  source text check (source is null or source in ('stripe', 'razorpay', 'recharge', 'manual')),
  provider_status text check (
    provider_status is null or provider_status in ('free', 'active', 'past_due', 'canceled', 'expired')
  ),
  provider_source text check (provider_source is null or provider_source in ('stripe', 'razorpay')),
  provider_customer_id text,
  provider_subscription_id text,
  provider_period_end timestamptz,
  recharge_period_end timestamptz,
  current_period_end timestamptz,
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists subscription_entitlements_provider_subscription_idx
  on public.subscription_entitlements (provider_source, provider_subscription_id)
  where provider_subscription_id is not null;

alter table public.subscription_entitlements enable row level security;

drop policy if exists "Owners can read their own subscription" on public.subscription_entitlements;
create policy "Owners can read their own subscription"
  on public.subscription_entitlements for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create or replace function public.normalize_subscription_entitlement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_provider_active boolean := false;
  v_recharge_active boolean := false;
begin
  v_provider_active :=
    new.provider_status = 'active'
    and new.provider_period_end is not null
    and new.provider_period_end > now();
  v_recharge_active :=
    new.recharge_period_end is not null
    and new.recharge_period_end > now();

  if v_provider_active or v_recharge_active then
    new.status := 'active';
    new.current_period_end := greatest(
      coalesce(new.provider_period_end, '-infinity'::timestamptz),
      coalesce(new.recharge_period_end, '-infinity'::timestamptz)
    );
    if v_recharge_active and (
      not v_provider_active
      or new.recharge_period_end >= coalesce(new.provider_period_end, '-infinity'::timestamptz)
    ) then
      new.source := 'recharge';
    else
      new.source := new.provider_source;
    end if;
  else
    new.status := coalesce(new.provider_status, 'free');
    new.source := new.provider_source;
    new.current_period_end := greatest(
      coalesce(new.provider_period_end, '-infinity'::timestamptz),
      coalesce(new.recharge_period_end, '-infinity'::timestamptz)
    );
    if new.current_period_end = '-infinity'::timestamptz then
      new.current_period_end := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists normalize_subscription_entitlement on public.subscription_entitlements;
create trigger normalize_subscription_entitlement
before insert or update on public.subscription_entitlements
for each row execute function public.normalize_subscription_entitlement();

create table if not exists public.recharge_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  duration_days integer not null default 30 check (duration_days between 1 and 366),
  batch_label text,
  valid_until timestamptz,
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.recharge_codes enable row level security;

-- Recharge cards are intentionally invisible to normal app users. They are
-- created by the founder with the service-role key and consumed only through
-- the SECURITY DEFINER function below.
revoke all on public.recharge_codes from anon, authenticated;

create or replace function public.redeem_recharge_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := auth.uid();
  v_hash text;
  v_code public.recharge_codes%rowtype;
  v_current public.subscription_entitlements%rowtype;
  v_base timestamptz;
  v_end timestamptz;
begin
  if v_owner is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_code is null or length(trim(p_code)) < 8 then
    raise exception 'INVALID_RECHARGE_CODE';
  end if;

  v_hash := encode(digest(upper(trim(p_code)), 'sha256'), 'hex');

  select * into v_code
  from public.recharge_codes
  where code_hash = v_hash
  for update;

  if not found then
    raise exception 'INVALID_RECHARGE_CODE';
  end if;

  if v_code.valid_until is not null and v_code.valid_until < now() then
    raise exception 'RECHARGE_CODE_EXPIRED';
  end if;

  if v_code.redeemed_at is not null then
    if v_code.redeemed_by = v_owner then
      select * into v_current
      from public.subscription_entitlements
      where owner_id = v_owner;

      return jsonb_build_object(
        'status', coalesce(v_current.status, 'free'),
        'source', v_current.source,
        'current_period_end', v_current.current_period_end,
        'already_redeemed', true
      );
    end if;
    raise exception 'RECHARGE_CODE_ALREADY_USED';
  end if;

  select * into v_current
  from public.subscription_entitlements
  where owner_id = v_owner
  for update;

  v_base := greatest(
    now(),
    coalesce(v_current.recharge_period_end, now()),
    coalesce(v_current.provider_period_end, now())
  );
  v_end := v_base + make_interval(days => v_code.duration_days);

  insert into public.subscription_entitlements (
    owner_id,
    status,
    source,
    recharge_period_end,
    current_period_end,
    last_verified_at,
    updated_at
  ) values (
    v_owner,
    'active',
    'recharge',
    v_end,
    v_end,
    now(),
    now()
  )
  on conflict (owner_id) do update set
    recharge_period_end = excluded.recharge_period_end,
    last_verified_at = now(),
    updated_at = now();

  update public.recharge_codes
  set redeemed_by = v_owner,
      redeemed_at = now()
  where id = v_code.id;

  return jsonb_build_object(
    'status', 'active',
    'source', 'recharge',
    'current_period_end', v_end,
    'days_added', v_code.duration_days,
    'already_redeemed', false
  );
end;
$$;

revoke all on function public.redeem_recharge_code(text) from public, anon;
grant execute on function public.redeem_recharge_code(text) to authenticated;

create or replace function public.enforce_gym_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_count integer := 0;
  v_old_member_count integer := 0;
  v_paid boolean := false;
begin
  select count(*) into v_member_count
  from jsonb_array_elements(coalesce(new.state -> 'members', '[]'::jsonb)) as member
  where coalesce(member ->> 'type', 'member') <> 'walk_in'
    and nullif(member ->> 'deletedAt', '') is null;

  if tg_op = 'UPDATE' then
    select count(*) into v_old_member_count
    from jsonb_array_elements(coalesce(old.state -> 'members', '[]'::jsonb)) as member
    where coalesce(member ->> 'type', 'member') <> 'walk_in'
      and nullif(member ->> 'deletedAt', '') is null;
  end if;

  if v_member_count <= 10 or v_member_count <= v_old_member_count then
    return new;
  end if;

  select exists (
    select 1
    from public.subscription_entitlements entitlement
    where entitlement.owner_id = new.owner_id
      and entitlement.status = 'active'
      and entitlement.current_period_end > now()
  ) into v_paid;

  if not v_paid then
    raise exception 'SUBSCRIPTION_REQUIRED_MEMBER_LIMIT';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_gym_member_limit on public.gym_workspaces;
create trigger enforce_gym_member_limit
before insert or update of state on public.gym_workspaces
for each row execute function public.enforce_gym_member_limit();
