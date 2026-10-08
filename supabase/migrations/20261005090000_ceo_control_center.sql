-- Forward-only CEO control center migration.
-- Reuses gyms, gym_users, gym_workspaces, subscription_entitlements,
-- recharge_codes and platform_admins; no customer data is dropped.

alter table public.gyms
  add column if not exists account_status text not null default 'active'
    check (account_status in ('pending', 'active', 'suspended', 'archived')),
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid references auth.users(id) on delete set null,
  add column if not exists suspension_note text not null default '';

alter table public.platform_admins
  add column if not exists role text not null default 'super_admin'
    check (role in ('super_admin', 'support_admin', 'finance_admin'));

alter table public.platform_signup_allowlist
  add column if not exists gym_name text not null default '';

create or replace function public.get_current_gym_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare v_user uuid := auth.uid(); v_membership public.gym_users%rowtype;
  v_gym public.gyms%rowtype; v_entitlement public.subscription_entitlements%rowtype;
begin
  if v_user is null then return null; end if;
  select * into v_membership from public.gym_users where user_id = v_user limit 1;
  if not found then return null; end if;
  select * into v_gym from public.gyms where id = v_membership.gym_id;
  select * into v_entitlement from public.subscription_entitlements where gym_id = v_membership.gym_id;
  return jsonb_build_object(
    'gym_id', v_membership.gym_id, 'role', v_membership.role,
    'permissions', coalesce(v_membership.permissions, '{}'::jsonb),
    'display_name', v_membership.display_name, 'email', v_membership.email,
    'enabled', v_membership.enabled, 'gym_name', v_gym.name,
    'account_status', v_gym.account_status,
    'subscription_expires_at', v_entitlement.current_period_end,
    'subscription_expired', v_entitlement.current_period_end is not null
      and v_entitlement.current_period_end <= now()
      and (v_entitlement.provider_period_end is not null or v_entitlement.recharge_period_end is not null
        or v_entitlement.manual_period_end is not null)
  );
end;
$$;

create table if not exists public.platform_admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_user_id uuid references auth.users(id) on delete set null,
  gym_id uuid references public.gyms(id) on delete set null,
  action text not null check (char_length(action) between 1 and 100),
  result text not null default 'success' check (result in ('success', 'failure')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_admin_audit_created_idx
  on public.platform_admin_audit_logs (created_at desc);
create index if not exists platform_admin_audit_gym_created_idx
  on public.platform_admin_audit_logs (gym_id, created_at desc);
alter table public.platform_admin_audit_logs enable row level security;
revoke all on public.platform_admin_audit_logs from public, anon, authenticated, service_role;

-- Snapshots live in a non-exposed database table and can only be accessed by
-- the audited SECURITY DEFINER operations below. No Storage public URL exists.
create table if not exists public.platform_gym_backups (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  backup_type text not null default 'manual' check (backup_type in ('manual', 'pre_restore')),
  status text not null default 'successful' check (status in ('successful', 'failed')),
  snapshot jsonb not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  created_at timestamptz not null default now()
);
create index if not exists platform_gym_backups_gym_created_idx
  on public.platform_gym_backups (gym_id, created_at desc);
alter table public.platform_gym_backups enable row level security;
revoke all on public.platform_gym_backups from public, anon, authenticated, service_role;

-- Remove direct client table writes. The profile name is kept in sync from the
-- already-authorized workspace RPC, not directly writable through PostgREST.
revoke insert, update, delete, truncate, references, trigger
  on public.gyms, public.gym_users, public.subscription_entitlements, public.audit_logs
  from public, anon, authenticated;
revoke update (owner_user_id, name, subscription_plan, subscription_status, trial_ends_at,
  account_status, suspended_at, suspended_by, suspension_note)
  on public.gyms from public, anon, authenticated;
grant select on public.gyms, public.gym_users, public.subscription_entitlements to authenticated;

drop policy if exists "Owners can update their gym" on public.gyms;
drop policy if exists "Owners can update their gym name" on public.gyms;

create or replace function public.platform_write_audit(
  p_action text, p_gym_id uuid default null, p_metadata jsonb default '{}'::jsonb,
  p_result text default 'success'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  insert into public.platform_admin_audit_logs (admin_user_id, gym_id, action, result, metadata)
  values (auth.uid(), p_gym_id, left(p_action, 100), p_result,
    case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end);
end;
$$;
revoke all on function public.platform_write_audit(text, uuid, jsonb, text) from public, anon, authenticated, service_role;

create or replace function public.platform_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_result jsonb;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'total_gyms', count(*),
    'active_gyms', count(*) filter (where g.account_status = 'active'),
    'pending_gyms', count(*) filter (where g.account_status = 'pending'),
    'suspended_gyms', count(*) filter (where g.account_status = 'suspended'),
    'archived_gyms', count(*) filter (where g.account_status = 'archived'),
    'active_pro', count(*) filter (where e.status = 'active' and e.current_period_end > now()),
    'expired_pro', count(*) filter (where e.status = 'active' and e.current_period_end <= now()),
    'expiring_soon', count(*) filter (where e.status = 'active'
      and e.current_period_end > now() and e.current_period_end <= now() + interval '7 days'),
    'total_members', coalesce(sum((select count(*) from jsonb_array_elements(
      case when jsonb_typeof(w.state -> 'members') = 'array' then w.state -> 'members' else '[]'::jsonb end
    ) member where nullif(member ->> 'deletedAt', '') is null)), 0),
    'active_owners', count(distinct g.owner_user_id) filter (where exists(
      select 1 from public.gym_users m where m.gym_id = g.id and m.user_id = g.owner_user_id
        and m.role = 'owner' and m.enabled)),
    'workspace_bytes', coalesce(sum(pg_column_size(w.state)), 0),
    'measured_at', now()
  ) into v_result
  from public.gyms g
  left join public.subscription_entitlements e on e.gym_id = g.id
  left join public.gym_workspaces w on w.gym_id = g.id;
  return v_result;
end;
$$;

create or replace function public.platform_list_gyms(
  p_search text default '', p_status text default 'all', p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  gym_id uuid, gym_name text, owner_id uuid, owner_name text, owner_email text,
  account_status text, created_at timestamptz, last_activity_at timestamptz,
  member_count integer, subscription_status text, subscription_source text,
  subscription_expires_at timestamptz, days_remaining integer, total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_search text := left(lower(btrim(coalesce(p_search, ''))), 200);
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_status not in ('all', 'pending', 'active', 'suspended', 'archived', 'expired', 'expiring') then
    raise exception 'INVALID_STATUS_FILTER';
  end if;
  return query
  with rows as (
    select g.id, g.name, g.owner_user_id, coalesce(u.raw_user_meta_data ->> 'full_name', m.display_name, '') as owner_name,
      coalesce(u.email, m.email, '') as owner_email, g.account_status, g.created_at,
      greatest(g.updated_at, coalesce(w.updated_at, g.updated_at)) as last_activity_at,
      (select count(*)::integer from jsonb_array_elements(case when jsonb_typeof(w.state -> 'members') = 'array'
        then w.state -> 'members' else '[]'::jsonb end) member
        where nullif(member ->> 'deletedAt', '') is null) as member_count,
      coalesce(e.status, 'free') as sub_status, e.source as sub_source, e.current_period_end,
      case when e.status = 'active' and e.current_period_end > now()
        then greatest(0, ceil(extract(epoch from (e.current_period_end - now())) / 86400))::integer else 0 end as days_remaining
    from public.gyms g
    left join public.gym_users m on m.gym_id = g.id and m.user_id = g.owner_user_id and m.role = 'owner'
    left join auth.users u on u.id = g.owner_user_id
    left join public.gym_workspaces w on w.gym_id = g.id
    left join public.subscription_entitlements e on e.gym_id = g.id
  ), filtered as (
    select * from rows r where
      (v_search = '' or lower(r.name) like '%' || v_search || '%'
        or lower(r.owner_name) like '%' || v_search || '%'
        or lower(r.owner_email) like '%' || v_search || '%' or r.id::text like '%' || v_search || '%')
      and (p_status = 'all' or r.account_status = p_status
        or (p_status = 'expired' and r.sub_status = 'active' and r.current_period_end <= now())
        or (p_status = 'expiring' and r.sub_status = 'active' and r.current_period_end > now()
          and r.current_period_end <= now() + interval '30 days'))
  )
  select f.id, f.name, f.owner_user_id, f.owner_name, f.owner_email, f.account_status,
    f.created_at, f.last_activity_at, f.member_count, f.sub_status, f.sub_source,
    f.current_period_end, f.days_remaining, count(*) over ()
  from filtered f order by f.created_at desc
  limit least(greatest(coalesce(p_page_size, 25), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;

create or replace function public.platform_set_gym_status(
  p_gym_id uuid, p_status text, p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_gym public.gyms%rowtype; v_old text;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_status not in ('active', 'suspended', 'archived', 'pending') then raise exception 'INVALID_GYM_STATUS'; end if;
  select * into v_gym from public.gyms where id = p_gym_id for update;
  if not found then raise exception 'GYM_NOT_FOUND'; end if;
  v_old := v_gym.account_status;
  update public.gyms set account_status = p_status,
    suspended_at = case when p_status = 'suspended' then coalesce(suspended_at, now()) else null end,
    suspended_by = case when p_status = 'suspended' then auth.uid() else null end,
    suspension_note = case when p_status = 'suspended' then left(btrim(coalesce(p_note, '')), 500) else '' end
  where id = p_gym_id returning * into v_gym;
  perform public.platform_write_audit('gym_status_changed', p_gym_id,
    jsonb_build_object('from', v_old, 'to', p_status, 'note', left(btrim(coalesce(p_note, '')), 500)));
  return jsonb_build_object('gym_id', p_gym_id, 'status', v_gym.account_status);
end;
$$;

create or replace function public.platform_list_audit_logs(p_page integer default 1, p_page_size integer default 50)
returns table (id bigint, admin_email text, gym_id uuid, gym_name text, action text,
  result text, metadata jsonb, created_at timestamptz, total_count bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query select a.id, coalesce(u.email, 'Removed admin'), a.gym_id, g.name,
    a.action, a.result, a.metadata, a.created_at, count(*) over ()
  from public.platform_admin_audit_logs a
  left join auth.users u on u.id = a.admin_user_id
  left join public.gyms g on g.id = a.gym_id
  order by a.created_at desc
  limit least(greatest(coalesce(p_page_size, 50), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 50), 1), 100);
end;
$$;

create or replace function public.platform_create_gym_backup(p_gym_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_backup public.platform_gym_backups%rowtype; v_gym public.gyms%rowtype;
  v_workspace public.gym_workspaces%rowtype; v_entitlement public.subscription_entitlements%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select * into v_gym from public.gyms where id = p_gym_id;
  if not found then raise exception 'GYM_NOT_FOUND'; end if;
  select * into v_workspace from public.gym_workspaces where gym_id = p_gym_id;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;
  select * into v_entitlement from public.subscription_entitlements where gym_id = p_gym_id;
  insert into public.platform_gym_backups (gym_id, created_by, backup_type, snapshot, size_bytes)
  values (p_gym_id, auth.uid(), 'manual', jsonb_build_object(
    'backup_version', 1, 'created_at', now(),
    'gym', jsonb_build_object('id', v_gym.id, 'name', v_gym.name, 'account_status', v_gym.account_status),
    'subscription', jsonb_build_object('status', v_entitlement.status, 'source', v_entitlement.source,
      'current_period_end', v_entitlement.current_period_end),
    'workspace', jsonb_build_object('revision', v_workspace.revision,
      'updated_at', v_workspace.updated_at, 'state', v_workspace.state)
  ), pg_column_size(v_workspace.state)) returning * into v_backup;
  perform public.platform_write_audit('backup_created', p_gym_id,
    jsonb_build_object('backup_id', v_backup.id, 'bytes', v_backup.size_bytes));
  return jsonb_build_object('backup_id', v_backup.id, 'created_at', v_backup.created_at,
    'size_bytes', v_backup.size_bytes, 'status', v_backup.status);
end;
$$;

create or replace function public.platform_list_gym_backups(p_gym_id uuid)
returns table (backup_id uuid, gym_id uuid, gym_name text, backup_type text,
  status text, size_bytes bigint, created_at timestamptz, created_by_email text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query select b.id, b.gym_id, g.name, b.backup_type, b.status, b.size_bytes,
    b.created_at, coalesce(u.email, 'Removed admin')
  from public.platform_gym_backups b
  join public.gyms g on g.id = b.gym_id
  left join auth.users u on u.id = b.created_by
  where b.gym_id = p_gym_id order by b.created_at desc limit 100;
end;
$$;

create or replace function public.platform_download_gym_backup(p_backup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_backup public.platform_gym_backups%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select * into v_backup from public.platform_gym_backups where id = p_backup_id;
  if not found or v_backup.status <> 'successful' then raise exception 'BACKUP_NOT_AVAILABLE'; end if;
  perform public.platform_write_audit('backup_downloaded', v_backup.gym_id,
    jsonb_build_object('backup_id', v_backup.id));
  return v_backup.snapshot;
end;
$$;

create or replace function public.platform_restore_gym_backup(p_backup_id uuid, p_confirm_gym_name text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_backup public.platform_gym_backups%rowtype; v_gym public.gyms%rowtype;
  v_workspace public.gym_workspaces%rowtype; v_entitlement public.subscription_entitlements%rowtype; v_pre_id uuid;
  v_restored jsonb; v_size bigint;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select * into v_backup from public.platform_gym_backups where id = p_backup_id for update;
  if not found or v_backup.status <> 'successful' then raise exception 'BACKUP_NOT_AVAILABLE'; end if;
  select * into v_gym from public.gyms where id = v_backup.gym_id for update;
  if not found then raise exception 'GYM_NOT_FOUND'; end if;
  if btrim(coalesce(p_confirm_gym_name, '')) <> v_gym.name then raise exception 'GYM_NAME_CONFIRMATION_MISMATCH'; end if;
  if (v_backup.snapshot ->> 'backup_version') is distinct from '1'
    or (v_backup.snapshot #>> '{gym,id}') is distinct from v_backup.gym_id::text then
    raise exception 'BACKUP_INVALID';
  end if;
  select * into v_workspace from public.gym_workspaces where gym_id = v_gym.id for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;
  select * into v_entitlement from public.subscription_entitlements where gym_id = v_gym.id;

  insert into public.platform_gym_backups (gym_id, created_by, backup_type, snapshot, size_bytes)
  values (v_gym.id, auth.uid(), 'pre_restore', jsonb_build_object(
    'backup_version', 1, 'created_at', now(),
    'gym', jsonb_build_object('id', v_gym.id, 'name', v_gym.name, 'account_status', v_gym.account_status),
    'subscription', jsonb_build_object('status', v_entitlement.status, 'source', v_entitlement.source,
      'current_period_end', v_entitlement.current_period_end),
    'workspace', jsonb_build_object('revision', v_workspace.revision,
      'updated_at', v_workspace.updated_at, 'state', v_workspace.state)
  ), pg_column_size(v_workspace.state)) returning id into v_pre_id;

  v_restored := v_backup.snapshot #> '{workspace,state}';
  if jsonb_typeof(v_restored) <> 'object' then raise exception 'BACKUP_INVALID'; end if;
  perform public.iv_validate_workspace(v_restored);
  if char_length(btrim(coalesce(v_backup.snapshot #>> '{gym,name}', ''))) between 2 and 120 then
    update public.gyms set name = v_backup.snapshot #>> '{gym,name}' where id = v_gym.id;
  end if;
  -- Restore is an explicit admin operation and must still work for an expired
  -- or suspended tenant; ordinary owner/receptionist workspace writes remain blocked.
  perform set_config('iv.platform_restore', 'on', true);
  update public.gym_workspaces set state = v_restored, revision = revision + 1, updated_at = now()
    where gym_id = v_gym.id returning state into v_restored;
  perform set_config('iv.platform_restore', 'off', true);
  v_size := pg_column_size(v_restored);
  perform public.platform_write_audit('backup_restored', v_gym.id,
    jsonb_build_object('backup_id', p_backup_id, 'pre_restore_backup_id', v_pre_id,
      'new_revision', v_workspace.revision + 1, 'restored_bytes', v_size));
  return jsonb_build_object('status', 'restored', 'gym_id', v_gym.id,
    'workspace_revision', v_workspace.revision + 1, 'pre_restore_backup_id', v_pre_id);
end;
$$;

-- Subscription/key history is recorded independently of tenant-level audit
-- logs, without ever recording raw recharge codes or hashes.
create or replace function public.platform_capture_subscription_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_gym_id uuid; v_action text; v_meta jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'subscription_entitlements' then
    v_gym_id := coalesce(new.gym_id, old.gym_id);
    v_action := case when tg_op = 'INSERT' then 'subscription_created' else 'subscription_changed' end;
    v_meta := jsonb_build_object('source', new.source, 'status', new.status,
      'period_end', new.current_period_end, 'provider_status', new.provider_status);
  else
    v_gym_id := (select m.gym_id from public.gym_users m where m.user_id = coalesce(new.redeemed_by, old.redeemed_by)
      and m.role = 'owner' limit 1);
    v_action := case when new.revoked_at is not null and old.revoked_at is null then 'recharge_code_revoked'
      when new.redeemed_at is not null and old.redeemed_at is null then 'recharge_code_claimed'
      when tg_op = 'INSERT' then 'recharge_code_generated' else 'recharge_code_changed' end;
    v_meta := jsonb_build_object('code_id', new.id, 'duration_days', new.duration_days,
      'status', case when new.revoked_at is not null then 'revoked'
        when new.redeemed_at is not null then 'claimed' else 'available' end);
  end if;
  if v_action is not null then
    insert into public.platform_admin_audit_logs (admin_user_id, gym_id, action, metadata)
    values (auth.uid(), v_gym_id, v_action, v_meta);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists platform_entitlement_audit on public.subscription_entitlements;
create trigger platform_entitlement_audit after insert or update on public.subscription_entitlements
for each row execute function public.platform_capture_subscription_event();
drop trigger if exists platform_recharge_code_audit on public.recharge_codes;
create trigger platform_recharge_code_audit after insert or update on public.recharge_codes
for each row execute function public.platform_capture_subscription_event();

-- Even if a client bypasses React, a suspended tenant or an expired paid
-- entitlement cannot persist a changed business workspace. Reads remain open.
create or replace function public.guard_gym_workspace_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_status text; v_has_entitlement boolean; v_gym_name text;
begin
  if current_setting('iv.platform_restore', true) = 'on' then
    if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then return new; end if;
  select g.account_status into v_status from public.gyms g where g.id = new.gym_id;
  if v_status is distinct from 'active' then raise exception 'GYM_ACCOUNT_READ_ONLY'; end if;
  select exists(select 1 from public.subscription_entitlements e
    where e.gym_id = new.gym_id and e.current_period_end is not null
      and (e.provider_period_end is not null or e.recharge_period_end is not null or e.manual_period_end is not null))
    into v_has_entitlement;
  if v_has_entitlement and not exists(select 1 from public.subscription_entitlements e
    where e.gym_id = new.gym_id and e.current_period_end > now()) then
    raise exception 'SUBSCRIPTION_EXPIRED_READ_ONLY';
  end if;
  if tg_op = 'INSERT' then
    select g.name into v_gym_name from public.gyms g where g.id = new.gym_id;
    if v_gym_name is not null and jsonb_typeof(new.state -> 'settings') = 'object' then
      new.state := jsonb_set(new.state, '{settings,gymName}', to_jsonb(v_gym_name), true);
    end if;
  else
    v_gym_name := btrim(coalesce(new.state #>> '{settings,gymName}', ''));
    if char_length(v_gym_name) between 2 and 120 then
      update public.gyms set name = v_gym_name where id = new.gym_id and name is distinct from v_gym_name;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_gym_workspace_write on public.gym_workspaces;
create trigger guard_gym_workspace_write before insert or update of state on public.gym_workspaces
for each row execute function public.guard_gym_workspace_write();

-- Keep private media readable for records in read-only mode, but prevent new
-- uploads/replacements/deletions after suspension or Pro expiry.
create or replace function public.iv_can_write_private_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.gym_users m
    join public.gyms g on g.id = m.gym_id
    where m.user_id = auth.uid() and m.enabled
      and m.gym_id::text = split_part(p_name, '/', 1)
      and g.account_status = 'active'
      and (m.role = 'owner' or (m.role = 'receptionist' and
        ((split_part(p_name, '/', 2) = 'members' and public.iv_has_permission(m.permissions, 'members'))
          or (split_part(p_name, '/', 2) = 'expenses' and public.iv_has_permission(m.permissions, 'expenses')))))
      and (not exists(select 1 from public.subscription_entitlements e where e.gym_id = g.id
          and e.current_period_end is not null
          and (e.provider_period_end is not null or e.recharge_period_end is not null or e.manual_period_end is not null))
        or exists(select 1 from public.subscription_entitlements e where e.gym_id = g.id
          and e.current_period_end > now()))
  )
$$;
revoke all on function public.iv_can_write_private_object(text) from public, anon, service_role;
grant execute on function public.iv_can_write_private_object(text) to authenticated;

drop policy if exists "IronVault private objects insert" on storage.objects;
create policy "IronVault private objects insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'ironvault-private' and public.iv_can_write_private_object(name));
drop policy if exists "IronVault private objects update" on storage.objects;
create policy "IronVault private objects update" on storage.objects for update to authenticated
  using (bucket_id = 'ironvault-private' and public.iv_can_access_private_object(name))
  with check (bucket_id = 'ironvault-private' and public.iv_can_write_private_object(name));
drop policy if exists "IronVault private objects delete" on storage.objects;
create policy "IronVault private objects delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ironvault-private' and public.iv_can_write_private_object(name));

-- An account created outside the auth hook cannot obtain an active gym by
-- directly calling ensure_owner_gym: the invitation must have been consumed.
create or replace function public.require_invited_gym_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_email text; v_invite_gym_name text;
begin
  if auth.uid() is null then return new; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  select i.gym_name into v_invite_gym_name from public.platform_signup_allowlist i
    where i.email = v_email and i.consumed_at is not null and i.revoked_at is null;
  if not found then
    raise exception 'GYM_INVITATION_REQUIRED';
  end if;
  if nullif(btrim(v_invite_gym_name), '') is not null then new.name := v_invite_gym_name; end if;
  return new;
end;
$$;
drop trigger if exists require_invited_gym_owner on public.gyms;
create trigger require_invited_gym_owner before insert on public.gyms
for each row execute function public.require_invited_gym_owner();

create or replace function public.iv_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_email text := lower(nullif(btrim(event #>> '{user,email}'), ''));
begin
  if v_email is not null and exists(select 1 from public.platform_signup_allowlist i
    where i.email = v_email and i.consumed_at is null and i.revoked_at is null) then
    update public.platform_signup_allowlist set consumed_at = now()
      where email = v_email and consumed_at is null and revoked_at is null;
    insert into public.platform_admin_audit_logs (admin_user_id, action, metadata)
      values (null, 'gym_invitation_consumed', jsonb_build_object('email', v_email));
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This gym app is available by invitation only. Contact the administrator for access.'
  ));
end;
$$;
revoke all on function public.iv_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.iv_before_user_created(jsonb) to supabase_auth_admin;

create or replace function public.platform_revoke_signup_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_email text := lower(btrim(p_email));
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  update public.platform_signup_allowlist set revoked_at = now(), revoked_by = auth.uid()
    where email = v_email and consumed_at is null and revoked_at is null;
  if not found then raise exception 'INVITE_NOT_PENDING'; end if;
  perform public.platform_write_audit('gym_invitation_revoked', null, jsonb_build_object('email', v_email));
end;
$$;

create or replace function public.platform_invite_gym_owner(
  p_email text, p_gym_name text, p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_gym_name text := left(btrim(coalesce(p_gym_name, '')), 120);
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'INVALID_INVITE_EMAIL'; end if;
  if char_length(v_gym_name) < 2 then raise exception 'GYM_NAME_REQUIRED'; end if;
  if exists(select 1 from auth.users u join public.gym_users m on m.user_id = u.id
    where lower(u.email) = v_email) then raise exception 'ACCOUNT_ALREADY_EXISTS'; end if;
  insert into public.platform_signup_allowlist (email, gym_name, note, invited_by, consumed_at)
  values (v_email, v_gym_name, left(btrim(coalesce(p_note, '')), 200), auth.uid(),
    case when exists(select 1 from auth.users u where lower(u.email) = v_email) then now() else null end)
  on conflict (email) do update set gym_name = excluded.gym_name, note = excluded.note,
    invited_at = now(), invited_by = auth.uid(), revoked_at = null, revoked_by = null,
    consumed_at = excluded.consumed_at
  where public.platform_signup_allowlist.consumed_at is null;
  if not found then raise exception 'INVITE_ALREADY_USED'; end if;
  perform public.platform_write_audit('gym_invitation_created', null,
    jsonb_build_object('email', v_email, 'gym_name', v_gym_name));
  return jsonb_build_object('email', v_email, 'gym_name', v_gym_name, 'status', 'invited');
end;
$$;

create or replace function public.platform_list_gym_invites()
returns table (email text, gym_name text, note text, invited_at timestamptz,
  consumed_at timestamptz, revoked_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query select i.email, i.gym_name, i.note, i.invited_at, i.consumed_at, i.revoked_at
    from public.platform_signup_allowlist i order by i.invited_at desc limit 500;
end;
$$;

revoke all on function public.platform_dashboard_summary() from public, anon, service_role;
revoke all on function public.platform_list_gyms(text, text, integer, integer) from public, anon, service_role;
revoke all on function public.platform_set_gym_status(uuid, text, text) from public, anon, service_role;
revoke all on function public.platform_list_audit_logs(integer, integer) from public, anon, service_role;
revoke all on function public.platform_create_gym_backup(uuid) from public, anon, service_role;
revoke all on function public.platform_list_gym_backups(uuid) from public, anon, service_role;
revoke all on function public.platform_download_gym_backup(uuid) from public, anon, service_role;
revoke all on function public.platform_restore_gym_backup(uuid, text) from public, anon, service_role;
revoke all on function public.platform_invite_gym_owner(text, text, text) from public, anon, service_role;
revoke all on function public.platform_list_gym_invites() from public, anon, service_role;
grant execute on function public.platform_dashboard_summary() to authenticated;
grant execute on function public.platform_list_gyms(text, text, integer, integer) to authenticated;
grant execute on function public.platform_set_gym_status(uuid, text, text) to authenticated;
grant execute on function public.platform_list_audit_logs(integer, integer) to authenticated;
grant execute on function public.platform_create_gym_backup(uuid) to authenticated;
grant execute on function public.platform_list_gym_backups(uuid) to authenticated;
grant execute on function public.platform_download_gym_backup(uuid) to authenticated;
grant execute on function public.platform_restore_gym_backup(uuid, text) to authenticated;
grant execute on function public.platform_invite_gym_owner(text, text, text) to authenticated;
grant execute on function public.platform_list_gym_invites() to authenticated;

revoke all on function public.platform_capture_subscription_event() from public, anon, authenticated, service_role;
revoke all on function public.guard_gym_workspace_write() from public, anon, authenticated, service_role;
revoke all on function public.require_invited_gym_owner() from public, anon, authenticated, service_role;
