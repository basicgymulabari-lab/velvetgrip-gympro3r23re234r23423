alter table public.recharge_codes
  add column if not exists revoked_at timestamptz,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

create index if not exists recharge_codes_created_at_idx
  on public.recharge_codes (created_at desc);

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

  if v_code.revoked_at is not null then
    raise exception 'RECHARGE_CODE_REVOKED';
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
