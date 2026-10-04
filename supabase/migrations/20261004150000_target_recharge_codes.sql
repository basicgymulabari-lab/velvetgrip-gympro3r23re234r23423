-- Allow an operator to optionally bind a single-use recharge code to a gym
-- owner's existing Supabase account. Unassigned codes remain first-come,
-- single-account codes. Plaintext is returned only at generation time in SQL
-- Editor; the database stores only its digest.
alter table public.recharge_codes
  add column if not exists target_user_id uuid references auth.users(id) on delete set null,
  add column if not exists target_email text;

drop function if exists public.generate_recharge_codes(integer, integer, integer, text);

create function public.generate_recharge_codes(
  p_days integer default 30,
  p_count integer default 1,
  p_valid_days integer default 30,
  p_batch_label text default null,
  p_target_email text default null
)
returns table (
  code text,
  duration_days integer,
  redeem_by timestamptz,
  batch_label text,
  target_email text
)
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_random bytea;
  v_chunk text;
  v_code text;
  v_hash text;
  v_id uuid;
  v_valid_until timestamptz;
  v_label text;
  v_index integer;
  v_code_no integer;
  v_target_user_id uuid;
  v_target_email text;
begin
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'DURATION_DAYS_MUST_BE_1_TO_366';
  end if;
  if p_count is null or p_count < 1 or p_count > 50 then
    raise exception 'CODE_COUNT_MUST_BE_1_TO_50';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 366 then
    raise exception 'REDEEM_WINDOW_MUST_BE_1_TO_366';
  end if;

  v_target_email := nullif(lower(trim(coalesce(p_target_email, ''))), '');
  if v_target_email is not null then
    select account.id, lower(account.email)
      into v_target_user_id, v_target_email
    from auth.users account
    where lower(account.email) = v_target_email
      and exists (
        select 1
        from public.gym_users membership
        where membership.user_id = account.id
          and membership.role = 'owner'
          and membership.enabled
      )
    limit 1;

    if v_target_user_id is null then
      raise exception 'TARGET_GYM_OWNER_NOT_FOUND';
    end if;
  end if;

  v_label := nullif(left(trim(coalesce(p_batch_label, '')), 80), '');
  v_valid_until := now() + make_interval(days => p_valid_days);

  for v_code_no in 1..p_count loop
    loop
      v_random := gen_random_bytes(12);
      v_chunk := '';
      for v_index in 0..11 loop
        v_chunk := v_chunk || substr(v_alphabet, (get_byte(v_random, v_index) % 32) + 1, 1);
      end loop;

      v_code := 'IV-' || to_char(now(), 'YYYYMM') || '-' ||
        substr(v_chunk, 1, 4) || '-' || substr(v_chunk, 5, 4) || '-' || substr(v_chunk, 9, 4);
      v_hash := encode(digest(v_code, 'sha256'), 'hex');
      v_id := null;

      insert into public.recharge_codes (
        code_hash,
        duration_days,
        batch_label,
        valid_until,
        target_user_id,
        target_email
      ) values (
        v_hash,
        p_days,
        coalesce(v_label, 'Issued ' || to_char(current_date, 'YYYY-MM-DD')),
        v_valid_until,
        v_target_user_id,
        v_target_email
      )
      on conflict (code_hash) do nothing
      returning id into v_id;

      exit when v_id is not null;
    end loop;

    code := v_code;
    duration_days := p_days;
    redeem_by := v_valid_until;
    batch_label := coalesce(v_label, 'Issued ' || to_char(current_date, 'YYYY-MM-DD'));
    target_email := v_target_email;
    return next;
  end loop;
end;
$$;

-- Only the privileged SQL Editor/project database owner can reveal plaintext.
revoke all on function public.generate_recharge_codes(integer, integer, integer, text, text)
  from public, anon, authenticated, service_role;

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
  if v_code.target_email is not null and
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
    now(),
    coalesce(v_current.recharge_period_end, now()),
    coalesce(v_current.provider_period_end, now())
  );
  v_end := v_base + make_interval(days => v_code.duration_days);

  insert into public.subscription_entitlements (
    owner_id, gym_id, status, source, recharge_period_end, current_period_end, last_verified_at, updated_at
  ) values (
    v_owner, v_gym, 'active', 'recharge', v_end, v_end, now(), now()
  ) on conflict (owner_id) do update set
    gym_id = excluded.gym_id,
    recharge_period_end = excluded.recharge_period_end,
    last_verified_at = now(),
    updated_at = now();

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
