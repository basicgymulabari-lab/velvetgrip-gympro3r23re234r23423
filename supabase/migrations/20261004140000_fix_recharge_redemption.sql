-- Preserve the tenant-aware redemption rules after the code-manager migrations.
-- The prior migration replaced this function with an older owner-only version,
-- which created entitlements without gym_id and made the app continue to show Free.
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
  if v_owner is null or v_gym is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if not public.iv_is_current_gym_owner() then
    raise exception 'OWNER_REQUIRED';
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

  -- A retry by the same account is idempotent; another account can never claim it.
  if v_code.redeemed_at is not null then
    if v_code.redeemed_by <> v_owner then
      raise exception 'RECHARGE_CODE_ALREADY_USED';
    end if;

    select * into v_current
    from public.subscription_entitlements
    where owner_id = v_owner
    for update;

    if found then
      if v_current.gym_id is not null and v_current.gym_id <> v_gym then
        raise exception 'OWNER_GYM_MISMATCH';
      end if;
      if v_current.gym_id is null then
        update public.subscription_entitlements
        set gym_id = v_gym
        where owner_id = v_owner;
        select * into v_current
        from public.subscription_entitlements
        where owner_id = v_owner;
      end if;
    end if;

    return jsonb_build_object(
      'status', coalesce(v_current.status, 'free'),
      'source', v_current.source,
      'current_period_end', v_current.current_period_end,
      'already_redeemed', true
    );
  end if;

  if v_code.valid_until is not null and v_code.valid_until < now() then
    raise exception 'RECHARGE_CODE_EXPIRED';
  end if;

  select * into v_current
  from public.subscription_entitlements
  where owner_id = v_owner
  for update;

  if found and v_current.gym_id is not null and v_current.gym_id <> v_gym then
    raise exception 'OWNER_GYM_MISMATCH';
  end if;

  v_base := greatest(
    now(),
    coalesce(v_current.recharge_period_end, now()),
    coalesce(v_current.provider_period_end, now())
  );
  v_end := v_base + make_interval(days => v_code.duration_days);

  insert into public.subscription_entitlements (
    owner_id,
    gym_id,
    status,
    source,
    recharge_period_end,
    current_period_end,
    last_verified_at,
    updated_at
  ) values (
    v_owner,
    v_gym,
    'active',
    'recharge',
    v_end,
    v_end,
    now(),
    now()
  )
  on conflict (owner_id) do update set
    gym_id = excluded.gym_id,
    recharge_period_end = excluded.recharge_period_end,
    last_verified_at = now(),
    updated_at = now();

  update public.recharge_codes
  set redeemed_by = v_owner,
      redeemed_at = now()
  where id = v_code.id;

  insert into public.audit_logs (
    gym_id, user_id, role, action, entity_type, entity_id, metadata
  ) values (
    v_gym,
    v_owner,
    'owner',
    'subscription_recharged',
    'subscription',
    v_gym::text,
    jsonb_build_object('days_added', v_code.duration_days, 'current_period_end', v_end)
  );

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
