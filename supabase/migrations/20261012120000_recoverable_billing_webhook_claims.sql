-- Make billing webhook claims atomic and recoverable after failed or abandoned attempts.
-- Only the server-side service role may claim/reclaim provider events.

alter table public.billing_webhook_events
  add column if not exists claimed_at timestamptz not null default now(),
  add column if not exists claim_token uuid,
  add column if not exists attempt_count integer not null default 1
    check (attempt_count > 0);

create or replace function public.claim_billing_webhook_event(
  p_provider text,
  p_event_key text,
  p_event_type text,
  p_payload_sha256 text,
  p_claim_token uuid,
  p_reclaim_after_seconds integer default 600
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
  v_status text;
  v_payload_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_provider is null
    or p_provider not in ('stripe', 'razorpay')
    or p_event_key is null
    or length(btrim(p_event_key)) = 0
    or length(p_event_key) > 255
    or (p_event_type is not null and length(p_event_type) > 255)
    or p_payload_sha256 is null
    or p_payload_sha256 !~ '^[0-9a-f]{64}$'
    or p_claim_token is null
    or p_reclaim_after_seconds is null
    or p_reclaim_after_seconds not between 60 and 3600 then
    raise exception 'invalid webhook claim parameters' using errcode = '22023';
  end if;

  insert into public.billing_webhook_events (
    provider, event_key, event_type, payload_sha256, status, claimed_at, claim_token, attempt_count
  ) values (
    p_provider, p_event_key, p_event_type, p_payload_sha256, 'processing', clock_timestamp(), p_claim_token, 1
  ) on conflict (provider, event_key) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return 'claimed';
  end if;

  update public.billing_webhook_events
  set status = 'processing',
      error_code = null,
      processed_at = null,
      claimed_at = clock_timestamp(),
      claim_token = p_claim_token,
      attempt_count = attempt_count + 1
  where provider = p_provider
    and event_key = p_event_key
    and payload_sha256 = p_payload_sha256
    and (
      status = 'failed'
      or (
        status = 'processing'
        and claimed_at < clock_timestamp() - make_interval(secs => p_reclaim_after_seconds)
      )
    );

  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return 'claimed';
  end if;

  select status, payload_sha256
  into v_status, v_payload_sha256
  from public.billing_webhook_events
  where provider = p_provider and event_key = p_event_key;

  if not found then
    raise exception 'webhook event claim disappeared' using errcode = '40001';
  end if;
  if v_payload_sha256 <> p_payload_sha256 then
    return 'payload_conflict';
  end if;
  if v_status = 'processed' then
    return 'processed';
  end if;
  return 'in_progress';
end;
$$;

revoke all on function public.claim_billing_webhook_event(text, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_billing_webhook_event(text, text, text, text, uuid, integer)
  to service_role;

comment on column public.billing_webhook_events.claimed_at is
  'Latest time this event was atomically claimed; used to recover abandoned processing attempts.';
comment on column public.billing_webhook_events.attempt_count is
  'Number of processing claims, including safe retries after failure or lease expiry.';
comment on column public.billing_webhook_events.claim_token is
  'Opaque lease token that prevents an expired worker from finalizing a newer claim.';
