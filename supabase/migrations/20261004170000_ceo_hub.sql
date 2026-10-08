-- CEO Hub: invite-only owner onboarding, and protected per-gym JSON exports.
-- All browser-invoked privileged RPCs re-check platform admin membership in Postgres.

create table if not exists public.platform_signup_allowlist (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  note text not null default '',
  invited_at timestamptz not null default now(),
  invited_by uuid references auth.users(id) on delete set null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);

alter table public.platform_signup_allowlist enable row level security;
revoke all on public.platform_signup_allowlist from public, anon, authenticated, service_role;

-- Supabase Auth invokes this hook before creating a new user. Existing users can
-- continue signing in; revoking an invite does not suspend an existing account.
create or replace function public.iv_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_email text := lower(nullif(btrim(event #>> '{user,email}'), ''));
  v_invited_email text;
begin
  if v_email is not null then
    select email into v_invited_email
    from public.platform_signup_allowlist
    where email = v_email and consumed_at is null and revoked_at is null
    for update;
  end if;

  if v_invited_email is not null then
    update public.platform_signup_allowlist
      set consumed_at = now()
      where email = v_email and consumed_at is null and revoked_at is null;
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This gym app is available by invitation only. Contact the administrator for access.'
    )
  );
end;
$$;

revoke all on function public.iv_before_user_created(jsonb)
  from public, anon, authenticated, service_role;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.iv_before_user_created(jsonb) to supabase_auth_admin;

create or replace function public.platform_list_signup_invites()
returns table (
  email text,
  note text,
  invited_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
    select i.email, i.note, i.invited_at, i.consumed_at, i.revoked_at
    from public.platform_signup_allowlist i
    order by i.invited_at desc
    limit 500;
end;
$$;

create or replace function public.platform_add_signup_invite(p_email text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_note text := left(btrim(coalesce(p_note, '')), 200);
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_INVITE_EMAIL';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'ACCOUNT_ALREADY_EXISTS';
  end if;

  insert into public.platform_signup_allowlist (email, note, invited_by, consumed_at)
  values (v_email, v_note, auth.uid(), null)
  on conflict (email) do update set
    note = excluded.note,
    invited_at = now(),
    invited_by = auth.uid(),
    revoked_at = null,
    revoked_by = null
  where public.platform_signup_allowlist.consumed_at is null;

  if not found then raise exception 'INVITE_ALREADY_USED'; end if;
  return jsonb_build_object('email', v_email, 'status', 'invited');
end;
$$;

create or replace function public.platform_revoke_signup_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  update public.platform_signup_allowlist
    set revoked_at = now(), revoked_by = auth.uid()
    where email = lower(btrim(p_email)) and consumed_at is null and revoked_at is null;
  if not found then raise exception 'INVITE_NOT_PENDING'; end if;
end;
$$;

create or replace function public.platform_export_gym_backup(p_gym_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_gym_id uuid;
  v_gym_name text;
  v_owner_email text;
  v_state jsonb;
  v_revision bigint;
  v_updated_at timestamptz;
  v_admin uuid := auth.uid();
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select g.id, g.name, coalesce(u.email, m.email), w.state, w.revision, w.updated_at
    into v_gym_id, v_gym_name, v_owner_email, v_state, v_revision, v_updated_at
  from public.gyms g
  join public.gym_users m on m.gym_id = g.id and m.user_id = g.owner_user_id and m.role = 'owner'
  left join auth.users u on u.id = m.user_id
  join public.gym_workspaces w on w.gym_id = g.id and w.owner_id = m.user_id
  where g.id = p_gym_id and m.enabled;

  if not found then raise exception 'GYM_NOT_FOUND'; end if;

  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
     values (v_gym_id, v_admin, 'system', 'platform_backup_exported', 'workspace', v_gym_id::text,
      jsonb_build_object('workspace_revision', v_revision));

  return jsonb_build_object(
    'backup_version', 1,
    'exported_at', now(),
    'gym', jsonb_build_object('id', v_gym_id, 'name', v_gym_name, 'owner_email', v_owner_email),
    'workspace', jsonb_build_object('revision', v_revision, 'updated_at', v_updated_at, 'state', v_state),
    'included', 'Gym workspace JSON data. Referenced private storage files are not embedded.'
  );
end;
$$;

revoke all on function public.platform_list_signup_invites() from public, anon, service_role;
revoke all on function public.platform_add_signup_invite(text, text) from public, anon, service_role;
revoke all on function public.platform_revoke_signup_invite(text) from public, anon, service_role;
revoke all on function public.platform_export_gym_backup(uuid) from public, anon, service_role;
grant execute on function public.platform_list_signup_invites() to authenticated;
grant execute on function public.platform_add_signup_invite(text, text) to authenticated;
grant execute on function public.platform_revoke_signup_invite(text) to authenticated;
grant execute on function public.platform_export_gym_backup(uuid) to authenticated;
