-- Close default-PUBLIC execution grants on gym RPCs and remove leftover
-- destructive table privileges from billing history. RLS does not apply to
-- TRUNCATE, so the billing grant must be revoked explicitly.

revoke all on table public.billing_transactions
  from public, anon, authenticated;
grant select on table public.billing_transactions to authenticated;

revoke all on function public.iv_current_gym_id()
  from public, anon, service_role;
grant execute on function public.iv_current_gym_id() to authenticated;

revoke all on function public.iv_is_current_gym_owner()
  from public, anon, service_role;
grant execute on function public.iv_is_current_gym_owner() to authenticated;

revoke all on function public.load_current_gym_workspace()
  from public, anon, service_role;
grant execute on function public.load_current_gym_workspace() to authenticated;

revoke all on function public.save_current_gym_workspace(jsonb, bigint)
  from public, anon, service_role;
grant execute on function public.save_current_gym_workspace(jsonb, bigint) to authenticated;

revoke all on function public.ensure_owner_gym(text, jsonb)
  from public, anon, service_role;
grant execute on function public.ensure_owner_gym(text, jsonb) to authenticated;

revoke all on function public.get_current_gym_context()
  from public, anon, service_role;
grant execute on function public.get_current_gym_context() to authenticated;

revoke all on function public.record_audit_event(text, text, text, jsonb)
  from public, anon, service_role;
grant execute on function public.record_audit_event(text, text, text, jsonb) to authenticated;

-- Trigger procedures stay callable by installed triggers, not through PostgREST RPC.
revoke all on function public.iv_validate_workspace_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_gym_member_limit()
  from public, anon, authenticated, service_role;
