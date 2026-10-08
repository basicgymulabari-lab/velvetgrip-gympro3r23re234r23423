-- Low-latency, private refresh signals for the platform-owner console.
-- Payloads contain no customer values; the CEO client re-reads authorized RPCs.

drop policy if exists "Platform admins can receive platform refresh events" on realtime.messages;
create policy "Platform admins can receive platform refresh events"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = 'platform-admin-live'
    and (select public.iv_is_platform_admin())
  );

create or replace function public.iv_broadcast_platform_refresh()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, realtime
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'schema', tg_table_schema,
      'table', tg_table_name,
      'operation', tg_op,
      'changed_at', clock_timestamp()
    ),
    'platform_data_changed',
    'platform-admin-live',
    true
  );
  return null;
exception when others then
  -- Realtime is an enhancement: a websocket/partition issue must never block
  -- the underlying gym, billing, invite, backup, or audit transaction.
  raise warning 'Platform refresh broadcast failed for %.%: %', tg_table_schema, tg_table_name, sqlerrm;
  return null;
end;
$$;

revoke all on function public.iv_broadcast_platform_refresh() from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'gyms',
    'gym_users',
    'gym_workspaces',
    'subscription_entitlements',
    'platform_signup_allowlist',
    'recharge_codes',
    'platform_admin_audit_logs',
    'platform_gym_backups'
  ] loop
    execute format('drop trigger if exists platform_admin_live_refresh on public.%I', v_table);
    execute format(
      'create trigger platform_admin_live_refresh after insert or update or delete on public.%I for each statement execute function public.iv_broadcast_platform_refresh()',
      v_table
    );
  end loop;
end;
$$;
