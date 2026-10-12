-- Safe integration assertions: the transaction is rolled back and uses only a synthetic event.
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_event_key constant text := 'qa-webhook-recovery-assert';
  v_hash constant text := repeat('a', 64);
  v_token_1 constant uuid := '00000000-0000-4000-8000-000000000001';
  v_token_2 constant uuid := '00000000-0000-4000-8000-000000000002';
  v_token_3 constant uuid := '00000000-0000-4000-8000-000000000003';
  v_token_4 constant uuid := '00000000-0000-4000-8000-000000000004';
  v_result text;
  v_attempt_count integer;
  v_rows integer;
begin
  v_result := public.claim_billing_webhook_event('stripe', v_event_key, 'invoice.paid', v_hash, v_token_1, 600);
  if v_result <> 'claimed' then
    raise exception 'first delivery should claim event, got %', v_result;
  end if;

  v_result := public.claim_billing_webhook_event('stripe', v_event_key, 'invoice.paid', v_hash, v_token_2, 600);
  if v_result <> 'in_progress' then
    raise exception 'concurrent delivery should be retryable, got %', v_result;
  end if;

  update public.billing_webhook_events
  set status = 'failed', error_code = 'QA_TRANSIENT', processed_at = now(), claim_token = null
  where provider = 'stripe' and event_key = v_event_key and claim_token = v_token_1;

  v_result := public.claim_billing_webhook_event('stripe', v_event_key, 'invoice.paid', v_hash, v_token_2, 600);
  if v_result <> 'claimed' then
    raise exception 'failed event should be reclaimed, got %', v_result;
  end if;

  update public.billing_webhook_events
  set claimed_at = now() - interval '11 minutes'
  where provider = 'stripe' and event_key = v_event_key and claim_token = v_token_2;
  v_result := public.claim_billing_webhook_event('stripe', v_event_key, 'invoice.paid', v_hash, v_token_3, 600);
  if v_result <> 'claimed' then
    raise exception 'stale processing lease should be reclaimed, got %', v_result;
  end if;

  update public.billing_webhook_events
  set status = 'failed', claim_token = null
  where provider = 'stripe' and event_key = v_event_key and claim_token = v_token_2;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'a stale worker must not finalize a newer claim';
  end if;

  select attempt_count into v_attempt_count
  from public.billing_webhook_events
  where provider = 'stripe' and event_key = v_event_key;
  if v_attempt_count <> 3 then
    raise exception 'claim attempts should be counted, got %', v_attempt_count;
  end if;

  update public.billing_webhook_events
  set status = 'processed', processed_at = now(), claim_token = null
  where provider = 'stripe' and event_key = v_event_key and claim_token = v_token_3;
  v_result := public.claim_billing_webhook_event('stripe', v_event_key, 'invoice.paid', v_hash, v_token_4, 600);
  if v_result <> 'processed' then
    raise exception 'processed event must remain idempotent, got %', v_result;
  end if;

  v_result := public.claim_billing_webhook_event(
    'stripe', v_event_key, 'invoice.paid', repeat('b', 64), '00000000-0000-4000-8000-000000000005', 600
  );
  if v_result <> 'payload_conflict' then
    raise exception 'changed payload under the same provider event id must be rejected, got %', v_result;
  end if;
end;
$$;

rollback;
select 'billing webhook recovery assertions passed' as result;
