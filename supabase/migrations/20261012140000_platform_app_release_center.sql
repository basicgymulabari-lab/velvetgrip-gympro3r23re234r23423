-- CEO-managed release catalog for Windows and Android installers plus the
-- official iOS distribution page. Release files remain in a private bucket;
-- gym users receive short-lived signed URLs only for published releases.

create table if not exists public.platform_app_releases (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('windows', 'android', 'ios')),
  version text not null check (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  release_notes text not null check (char_length(btrim(release_notes)) between 1 and 4000),
  download_url text,
  artifact_path text,
  file_name text,
  status text not null default 'published' check (status in ('published', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  constraint platform_app_releases_version_unique unique (platform, version),
  constraint platform_app_releases_distribution_check check (
    (platform = 'windows' and artifact_path is not null and file_name is not null and download_url is null)
    or (platform = 'android' and artifact_path is not null and file_name is not null and download_url is null)
    or (platform = 'ios' and artifact_path is null and file_name is null and download_url is not null)
  )
);

create index if not exists platform_app_releases_status_published_idx
  on public.platform_app_releases (status, published_at desc);
alter table public.platform_app_releases enable row level security;
revoke all on public.platform_app_releases from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'iv-platform-releases',
  'iv-platform-releases',
  false,
  52428800,
  array['application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.iv_can_read_platform_release_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.iv_is_platform_admin()
    or (
      exists (
        select 1 from public.gym_users gu
        where gu.user_id = auth.uid() and gu.enabled
      )
      and exists (
        select 1 from public.platform_app_releases r
        where r.status = 'published' and r.artifact_path = p_name
      )
    )
$$;
revoke all on function public.iv_can_read_platform_release_object(text) from public, anon, service_role;
grant execute on function public.iv_can_read_platform_release_object(text) to authenticated;

drop policy if exists "Platform release files read" on storage.objects;
create policy "Platform release files read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'iv-platform-releases'
    and public.iv_can_read_platform_release_object(name)
  );

drop policy if exists "Platform admins upload release files" on storage.objects;
create policy "Platform admins upload release files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'iv-platform-releases'
    and public.iv_is_platform_admin()
    and name ~ '^(windows/[0-9a-f-]{36}\.(exe|msi)|android/[0-9a-f-]{36}\.apk)$'
  );

drop policy if exists "Platform admins remove release files" on storage.objects;
create policy "Platform admins remove release files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'iv-platform-releases' and public.iv_is_platform_admin());

create or replace function public.platform_list_app_releases()
returns table (
  id uuid,
  platform text,
  version text,
  release_notes text,
  download_url text,
  artifact_path text,
  file_name text,
  status text,
  created_by uuid,
  created_at timestamptz,
  published_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
    select r.id, r.platform, r.version, r.release_notes, r.download_url,
      r.artifact_path, r.file_name, r.status, r.created_by, r.created_at, r.published_at
    from public.platform_app_releases r
    order by r.created_at desc
    limit 100;
end;
$$;

create or replace function public.platform_publish_app_release(
  p_platform text,
  p_version text,
  p_release_notes text,
  p_artifact_path text default null,
  p_file_name text default null,
  p_download_url text default null
)
returns table (
  id uuid,
  platform text,
  version text,
  release_notes text,
  download_url text,
  artifact_path text,
  file_name text,
  status text,
  created_by uuid,
  created_at timestamptz,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_release public.platform_app_releases%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_platform not in ('windows', 'android', 'ios') then raise exception 'INVALID_APP_PLATFORM'; end if;
  if p_version !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' then raise exception 'INVALID_APP_VERSION'; end if;
  if char_length(btrim(coalesce(p_release_notes, ''))) not between 1 and 4000 then
    raise exception 'INVALID_APP_RELEASE_NOTES';
  end if;

  if p_platform = 'windows' then
    if p_download_url is not null or p_artifact_path is null or p_file_name is null
      or p_artifact_path !~ ('^windows/[0-9a-f-]{36}\.(exe|msi)$')
      or p_file_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.(exe|msi)$' then
      raise exception 'INVALID_WINDOWS_APP_ARTIFACT';
    end if;
  elsif p_platform = 'android' then
    if p_download_url is not null or p_artifact_path is null or p_file_name is null
      or p_artifact_path !~ ('^android/[0-9a-f-]{36}\.apk$')
      or p_file_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.apk$' then
      raise exception 'INVALID_ANDROID_APP_ARTIFACT';
    end if;
  elsif p_artifact_path is not null or p_file_name is not null or p_download_url is null
    or p_download_url !~ '^https://(apps\.apple\.com|testflight\.apple\.com)/' then
    raise exception 'INVALID_IOS_DISTRIBUTION_LINK';
  end if;

  if p_platform in ('windows', 'android') and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'iv-platform-releases' and o.name = p_artifact_path
  ) then
    raise exception 'APP_RELEASE_ARTIFACT_NOT_FOUND';
  end if;

  insert into public.platform_app_releases as r (
    platform, version, release_notes, download_url, artifact_path, file_name, created_by
  ) values (
    p_platform, p_version, btrim(p_release_notes), p_download_url, p_artifact_path, p_file_name, auth.uid()
  ) returning r.* into v_release;

  insert into public.platform_admin_audit_logs (admin_user_id, action, metadata)
  values (
    auth.uid(),
    'app_release_published',
    jsonb_build_object('release_id', v_release.id, 'platform', v_release.platform, 'version', v_release.version)
  );

  return query select v_release.id, v_release.platform, v_release.version, v_release.release_notes,
    v_release.download_url, v_release.artifact_path, v_release.file_name, v_release.status,
    v_release.created_by, v_release.created_at, v_release.published_at;
exception
  when unique_violation then raise exception 'APP_RELEASE_VERSION_EXISTS';
end;
$$;

create or replace function public.platform_archive_app_release(p_release_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_release public.platform_app_releases%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  update public.platform_app_releases r
    set status = 'archived'
    where r.id = p_release_id and r.status = 'published'
    returning r.* into v_release;
  if not found then raise exception 'APP_RELEASE_NOT_FOUND'; end if;

  insert into public.platform_admin_audit_logs (admin_user_id, action, metadata)
  values (
    auth.uid(),
    'app_release_archived',
    jsonb_build_object('release_id', v_release.id, 'platform', v_release.platform, 'version', v_release.version)
  );
  return jsonb_build_object('id', v_release.id, 'platform', v_release.platform, 'version', v_release.version);
end;
$$;

create or replace function public.platform_current_app_releases()
returns table (
  id uuid,
  platform text,
  version text,
  release_notes text,
  download_url text,
  artifact_path text,
  file_name text,
  published_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.gym_users gu where gu.user_id = auth.uid() and gu.enabled
  ) then raise exception 'GYM_ACCOUNT_REQUIRED'; end if;

  return query
    select latest.id, latest.platform, latest.version, latest.release_notes,
      latest.download_url, latest.artifact_path, latest.file_name, latest.published_at
    from (
      select distinct on (r.platform)
        r.id, r.platform, r.version, r.release_notes, r.download_url,
        r.artifact_path, r.file_name, r.published_at
      from public.platform_app_releases r
      where r.status = 'published'
      order by r.platform, r.published_at desc, r.created_at desc
    ) latest
    order by latest.platform;
end;
$$;

revoke all on function public.platform_list_app_releases() from public, anon, service_role;
revoke all on function public.platform_publish_app_release(text, text, text, text, text, text) from public, anon, service_role;
revoke all on function public.platform_archive_app_release(uuid) from public, anon, service_role;
revoke all on function public.platform_current_app_releases() from public, anon, service_role;
grant execute on function public.platform_list_app_releases() to authenticated;
grant execute on function public.platform_publish_app_release(text, text, text, text, text, text) to authenticated;
grant execute on function public.platform_archive_app_release(uuid) to authenticated;
grant execute on function public.platform_current_app_releases() to authenticated;
