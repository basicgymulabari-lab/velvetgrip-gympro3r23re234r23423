-- Generate and reveal single-use recharge codes from Supabase SQL Editor.
-- Only the privileged SQL owner can execute this plaintext-returning function;
-- normal app roles and service_role cannot call it through the API.
create or replace function public.generate_recharge_codes(
  p_days integer default 30,
  p_count integer default 1,
  p_valid_days integer default 30,
  p_batch_label text default null
)
returns table (
  code text,
  duration_days integer,
  redeem_by timestamptz,
  batch_label text
)
language plpgsql
security definer
set search_path = public, extensions
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
        valid_until
      ) values (
        v_hash,
        p_days,
        coalesce(v_label, 'Issued ' || to_char(current_date, 'YYYY-MM-DD')),
        v_valid_until
      )
      on conflict (code_hash) do nothing
      returning id into v_id;

      exit when v_id is not null;
    end loop;

    code := v_code;
    duration_days := p_days;
    redeem_by := v_valid_until;
    batch_label := coalesce(v_label, 'Issued ' || to_char(current_date, 'YYYY-MM-DD'));
    return next;
  end loop;
end;
$$;

revoke all on function public.generate_recharge_codes(integer, integer, integer, text)
  from public, anon, authenticated, service_role;
