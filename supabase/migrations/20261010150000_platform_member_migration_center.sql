-- CEO-only member onboarding and migration center.
-- Customer records remain in gym_workspaces; member bundles are moved with
-- their current active term, while historical terms and unrelated sales stay
-- with the source. Every operation is admin-checked, bounded, and audited.

alter table public.gyms
  add column if not exists is_member_migration_source boolean not null default false;

create unique index if not exists gyms_single_member_migration_source_idx
  on public.gyms (is_member_migration_source) where is_member_migration_source;
revoke update (is_member_migration_source) on public.gyms from public, anon, authenticated, service_role;

create table if not exists public.platform_member_migration_operations (
  id uuid primary key,
  operation_type text not null check (operation_type in ('import', 'transfer')),
  source_gym_id uuid references public.gyms(id) on delete set null,
  destination_gym_id uuid references public.gyms(id) on delete set null,
  admin_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'partial', 'failed')),
  config jsonb not null default '{}'::jsonb,
  total_count integer not null default 0 check (total_count >= 0),
  successful_count integer not null default 0 check (successful_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists platform_member_migration_created_idx
  on public.platform_member_migration_operations (created_at desc);
create index if not exists platform_member_migration_source_idx
  on public.platform_member_migration_operations (source_gym_id, created_at desc);

create table if not exists public.platform_member_migration_items (
  operation_id uuid not null references public.platform_member_migration_operations(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  source_member_id text,
  destination_member_id text,
  outcome text not null check (outcome in ('imported', 'transferred', 'skipped', 'failed')),
  message text not null default '',
  created_at timestamptz not null default now(),
  primary key (operation_id, row_number)
);
alter table public.platform_member_migration_items
  add column if not exists request_digest text;

create table if not exists public.platform_member_migration_links (
  source_gym_id uuid not null references public.gyms(id) on delete cascade,
  destination_gym_id uuid not null references public.gyms(id) on delete cascade,
  source_member_id text not null,
  destination_member_id text not null,
  operation_id uuid not null references public.platform_member_migration_operations(id) on delete cascade,
  transferred_at timestamptz not null default now(),
  primary key (source_gym_id, destination_gym_id, source_member_id)
);
create unique index if not exists platform_member_migration_source_link_unique_idx
  on public.platform_member_migration_links (source_gym_id, source_member_id);

alter table public.platform_member_migration_operations enable row level security;
alter table public.platform_member_migration_items enable row level security;
alter table public.platform_member_migration_links enable row level security;
revoke all on public.platform_member_migration_operations,
  public.platform_member_migration_items, public.platform_member_migration_links
  from public, anon, authenticated, service_role;

create or replace function public.platform_list_member_migration_gyms()
returns table (
  gym_id uuid, gym_name text, owner_email text, account_status text,
  member_count integer, has_workspace boolean, is_source boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select g.id, g.name, coalesce(u.email, m.email, ''), g.account_status,
    (select count(*)::integer from jsonb_array_elements(
      case when jsonb_typeof(w.state -> 'members') = 'array' then w.state -> 'members' else '[]'::jsonb end
    ) member where coalesce(member ->> 'type', 'member') <> 'walk_in'
      and nullif(member ->> 'deletedAt', '') is null),
    w.gym_id is not null, g.is_member_migration_source
  from public.gyms g
  left join public.gym_workspaces w on w.gym_id = g.id
  left join public.gym_users m on m.gym_id = g.id and m.user_id = g.owner_user_id and m.role = 'owner'
  left join auth.users u on u.id = g.owner_user_id
  order by g.is_member_migration_source desc, g.created_at desc
  limit 1000;
end;
$$;

create or replace function public.platform_set_member_migration_source(
  p_gym_id uuid, p_confirm_gym_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_gym public.gyms%rowtype;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select * into v_gym from public.gyms where id = p_gym_id for update;
  if not found or v_gym.account_status <> 'active' then raise exception 'ACTIVE_SOURCE_GYM_REQUIRED'; end if;
  if btrim(coalesce(p_confirm_gym_name, '')) <> v_gym.name then raise exception 'GYM_NAME_CONFIRMATION_MISMATCH'; end if;
  if not exists (select 1 from public.gym_workspaces where gym_id = p_gym_id) then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;
  if exists (select 1 from public.platform_member_migration_operations
    where status = 'processing' and source_gym_id = p_gym_id) then
    raise exception 'MIGRATION_OPERATION_IN_PROGRESS';
  end if;
  update public.gyms set is_member_migration_source = false where is_member_migration_source;
  update public.gyms set is_member_migration_source = true where id = p_gym_id;
  perform public.platform_write_audit('member_migration_source_changed', p_gym_id,
    jsonb_build_object('gym_name', v_gym.name));
  return jsonb_build_object('gym_id', p_gym_id, 'gym_name', v_gym.name, 'is_source', true);
end;
$$;

create or replace function public.platform_get_member_migration_context(
  p_source_gym_id uuid, p_destination_gym_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_source public.gyms%rowtype; v_destination public.gyms%rowtype;
  v_source_state jsonb; v_destination_state jsonb;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_source_gym_id is null or p_destination_gym_id is null or p_source_gym_id = p_destination_gym_id then
    raise exception 'INVALID_MIGRATION_GYMS';
  end if;
  select * into v_source from public.gyms where id = p_source_gym_id;
  select * into v_destination from public.gyms where id = p_destination_gym_id;
  if v_source.id is null or not v_source.is_member_migration_source then raise exception 'DESIGNATED_SOURCE_REQUIRED'; end if;
  if v_destination.id is null then raise exception 'INVALID_DESTINATION_GYM'; end if;
  if v_source.account_status <> 'active' or v_destination.account_status <> 'active' then
    raise exception 'ACTIVE_GYMS_REQUIRED';
  end if;
  select state into v_source_state from public.gym_workspaces where gym_id = p_source_gym_id;
  if not found then raise exception 'SOURCE_WORKSPACE_NOT_FOUND'; end if;
  select state into v_destination_state from public.gym_workspaces where gym_id = p_destination_gym_id;
  if not found then raise exception 'DESTINATION_WORKSPACE_NOT_FOUND'; end if;
  return jsonb_build_object(
    'source', jsonb_build_object('gym_id', v_source.id, 'gym_name', v_source.name,
      'member_count', (select count(*)::integer from jsonb_array_elements(
        case when jsonb_typeof(v_source_state -> 'members') = 'array' then v_source_state -> 'members' else '[]'::jsonb end
      ) member where coalesce(member ->> 'type', 'member') <> 'walk_in'
        and nullif(member ->> 'deletedAt', '') is null)),
    'destination', jsonb_build_object('gym_id', v_destination.id, 'gym_name', v_destination.name,
      'member_count', (select count(*)::integer from jsonb_array_elements(
        case when jsonb_typeof(v_destination_state -> 'members') = 'array' then v_destination_state -> 'members' else '[]'::jsonb end
      ) member where coalesce(member ->> 'type', 'member') <> 'walk_in'
        and nullif(member ->> 'deletedAt', '') is null)),
    'source_plans', coalesce((select jsonb_agg(jsonb_build_object('id', plan ->> 'id', 'name', plan ->> 'name',
      'price', plan -> 'price', 'active', coalesce((plan ->> 'active')::boolean, false),
      'deleted', nullif(plan ->> 'deletedAt', '') is not null))
      from jsonb_array_elements(coalesce(v_source_state -> 'plans', '[]'::jsonb)) plan), '[]'::jsonb),
    'destination_plans', coalesce((select jsonb_agg(jsonb_build_object('id', plan ->> 'id', 'name', plan ->> 'name',
      'price', plan -> 'price', 'active', coalesce((plan ->> 'active')::boolean, false),
      'deleted', nullif(plan ->> 'deletedAt', '') is not null))
      from jsonb_array_elements(coalesce(v_destination_state -> 'plans', '[]'::jsonb)) plan), '[]'::jsonb)
  );
end;
$$;

create or replace function public.platform_list_member_migration_members(
  p_source_gym_id uuid, p_destination_gym_id uuid default null,
  p_search text default '', p_page integer default 1, p_page_size integer default 100
)
returns table (member jsonb, possible_duplicate boolean, current_membership jsonb, total_count bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_source jsonb; v_destination jsonb; v_source_name text;
  v_source_timezone text; v_source_today date;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.gyms where id = p_source_gym_id and is_member_migration_source) then
    raise exception 'DESIGNATED_SOURCE_REQUIRED';
  end if;
  if not exists (select 1 from public.gyms where id = p_source_gym_id and account_status = 'active') then
    raise exception 'ACTIVE_GYMS_REQUIRED';
  end if;
  select w.state, g.name into v_source, v_source_name
    from public.gym_workspaces w join public.gyms g on g.id = w.gym_id
    where w.gym_id = p_source_gym_id;
  if not found then raise exception 'SOURCE_WORKSPACE_NOT_FOUND'; end if;
  -- Membership end dates are stored as ISO timestamps made from a local
  -- date input. Interpret the day using the gym's configured country.
  v_source_timezone := case v_source #>> '{settings,phoneCountry}'
    when 'nepal' then 'Asia/Kathmandu'
    when 'usa' then 'America/New_York'
    else 'Asia/Kolkata' end;
  v_source_today := (now() at time zone v_source_timezone)::date;
  if p_destination_gym_id is not null then
    if p_source_gym_id = p_destination_gym_id or not exists (
      select 1 from public.gyms where id = p_destination_gym_id and account_status = 'active'
    ) then raise exception 'INVALID_DESTINATION_GYM'; end if;
    select state into v_destination from public.gym_workspaces where gym_id = p_destination_gym_id;
    if not found then raise exception 'DESTINATION_WORKSPACE_NOT_FOUND'; end if;
  end if;
  return query
  with source_members as (
    select item as m, row_number() over (order by lower(coalesce(item ->> 'name', '')), item ->> 'id') as rn
    from jsonb_array_elements(coalesce(v_source -> 'members', '[]'::jsonb)) item
    where coalesce(item ->> 'type', 'member') <> 'walk_in'
      and nullif(item ->> 'deletedAt', '') is null
      and (btrim(coalesce(p_search, '')) = '' or
        concat_ws(' ', item ->> 'name', item ->> 'email', item ->> 'phone') ilike '%' || left(btrim(p_search), 100) || '%')
  ), expanded as (
    select sm.m, sm.rn,
      (select ms.value from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) with ordinality ms(value, ordinality)
        where ms.value ->> 'memberId' = sm.m ->> 'id'
        order by (ms.value ->> 'endDate')::timestamptz desc, ms.ordinality asc limit 1) as membership
    from source_members sm
  ), annotated as (
    select e.m, e.rn, e.membership,
      case when v_destination is null then false else exists (
        select 1 from jsonb_array_elements(coalesce(v_destination -> 'members', '[]'::jsonb)) dm
        where nullif(dm ->> 'deletedAt', '') is null
          and ((nullif(lower(btrim(coalesce(e.m ->> 'email', ''))), '') is not null
                and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(e.m ->> 'email')))
            or (length(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
                and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                  = right(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g'), 10)))
      ) end as duplicate,
      count(*) over () as total
    from expanded e
  )
  select jsonb_build_object('id', a.m -> 'id', 'name', a.m -> 'name',
      'email', a.m -> 'email', 'phone', a.m -> 'phone'), a.duplicate,
    case when a.membership is null then null else jsonb_build_object(
      'id', a.membership ->> 'id', 'plan_id', a.membership ->> 'planId',
      'plan_name', (select plan ->> 'name' from jsonb_array_elements(coalesce(v_source -> 'plans', '[]'::jsonb)) plan
        where plan ->> 'id' = a.membership ->> 'planId' limit 1),
      'start_date', a.membership ->> 'startDate',
      'end_date', to_char(timezone(v_source_timezone, (a.membership ->> 'endDate')::timestamptz), 'YYYY-MM-DD'),
      'frozen', coalesce((a.membership ->> 'frozen')::boolean, false),
      'active', not coalesce((a.membership ->> 'frozen')::boolean, false)
        and timezone(v_source_timezone, (a.membership ->> 'endDate')::timestamptz)::date >= v_source_today,
      'price', a.membership -> 'price'
    ) end,
    a.total
  from annotated a
  order by a.rn
  limit least(greatest(coalesce(p_page_size, 100), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 100), 1), 100);
end;
$$;

create or replace function public.platform_import_migration_members(
  p_operation_id uuid, p_source_gym_id uuid, p_rows jsonb, p_final boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_gym public.gyms%rowtype; v_workspace public.gym_workspaces%rowtype;
  v_operation public.platform_member_migration_operations%rowtype;
  v_row jsonb; v_member jsonb; v_row_number integer; v_id text; v_status text;
  v_message text; v_name text; v_email text; v_phone text; v_emergency text;
  v_gender text; v_dob date; v_join_date date; v_phone_prefix text;
  v_seen_rows integer[] := '{}'; v_local_timezone text; v_today date; v_request_digest text;
  v_existing_digest text;
  v_members jsonb; v_next jsonb; v_duplicate boolean; v_processed integer := 0;
  v_total integer; v_success integer; v_skipped integer; v_failed integer; v_operation_status text;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_operation_id is null or coalesce(jsonb_typeof(p_rows), 'null') <> 'array'
     or jsonb_array_length(p_rows) > 100 then raise exception 'INVALID_MIGRATION_BATCH'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) row_data
    group by nullif(row_data ->> 'rowNumber', '') having count(*) > 1) then
    raise exception 'DUPLICATE_MIGRATION_ROW_NUMBER';
  end if;
  select * into v_gym from public.gyms where id = p_source_gym_id and is_member_migration_source for update;
  if not found or v_gym.account_status <> 'active' then raise exception 'DESIGNATED_SOURCE_REQUIRED'; end if;
  insert into public.platform_member_migration_operations
    (id, operation_type, source_gym_id, admin_user_id)
  values (p_operation_id, 'import', p_source_gym_id, auth.uid()) on conflict (id) do nothing;
  select * into v_operation from public.platform_member_migration_operations where id = p_operation_id for update;
  if v_operation.operation_type <> 'import' or v_operation.source_gym_id <> p_source_gym_id
     or v_operation.admin_user_id is distinct from auth.uid() then raise exception 'MIGRATION_OPERATION_MISMATCH'; end if;
  if v_operation.status <> 'processing' then
    return jsonb_build_object('status', v_operation.status, 'total', v_operation.total_count,
      'imported', v_operation.successful_count, 'skipped', v_operation.skipped_count,
      'failed', v_operation.failed_count, 'operation_id', p_operation_id);
  end if;
  select * into v_workspace from public.gym_workspaces where gym_id = p_source_gym_id for update;
  if not found then raise exception 'SOURCE_WORKSPACE_NOT_FOUND'; end if;
  v_members := coalesce(v_workspace.state -> 'members', '[]'::jsonb);
  v_phone_prefix := case v_workspace.state #>> '{settings,phoneCountry}'
    when 'nepal' then '+977 ' when 'usa' then '+1 ' else '+91 ' end;
  v_local_timezone := case v_workspace.state #>> '{settings,phoneCountry}'
    when 'nepal' then 'Asia/Kathmandu' when 'usa' then 'America/New_York' else 'Asia/Kolkata' end;
  v_today := (now() at time zone v_local_timezone)::date;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_processed := v_processed + 1;
    v_row_number := nullif(v_row ->> 'rowNumber', '')::integer;
    if v_row_number is null or v_row_number < 1 then raise exception 'INVALID_ROW_NUMBER'; end if;
    if v_row_number = any(v_seen_rows) then raise exception 'DUPLICATE_MIGRATION_ROW_NUMBER'; end if;
    v_seen_rows := array_append(v_seen_rows, v_row_number);
    v_member := coalesce(v_row -> 'member', '{}'::jsonb);
    v_request_digest := md5(v_member::text || chr(31) || coalesce(v_row ->> 'allowDuplicate', 'false'));
    select request_digest into v_existing_digest from public.platform_member_migration_items
      where operation_id = p_operation_id and row_number = v_row_number;
    if found then
      if v_existing_digest is distinct from v_request_digest then raise exception 'MIGRATION_OPERATION_MISMATCH'; end if;
      continue;
    end if;
    v_name := btrim(coalesce(v_member ->> 'name', ''));
    v_email := lower(btrim(coalesce(v_member ->> 'email', '')));
    v_phone := regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g');
    v_emergency := regexp_replace(coalesce(v_member ->> 'emergencyContact', ''), '[^0-9]', '', 'g');
    v_gender := lower(btrim(coalesce(v_member ->> 'gender', '')));
    v_status := 'failed'; v_message := 'Row did not pass server validation.'; v_id := null;
    begin v_dob := nullif(v_member ->> 'dob', '')::date; exception when others then v_dob := null; end;
    begin v_join_date := nullif(v_member ->> 'joinDate', '')::date; exception when others then v_join_date := null; end;

    if char_length(v_name) < 2 or char_length(v_name) > 80 then v_message := 'Name must be 2–80 characters.';
    elsif v_email <> '' and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then v_message := 'Email address is invalid.';
    elsif v_phone !~ '^[0-9]{10}$' then v_message := 'Phone must contain exactly 10 local digits.';
    elsif v_gender not in ('male', 'female', 'other') then v_message := 'Gender must be male, female, or other.';
    elsif v_dob is null or v_dob > v_today then v_message := 'Date of birth is missing or invalid.';
    elsif v_join_date is null or v_join_date > v_today then v_message := 'Join date is invalid.';
    elsif char_length(btrim(coalesce(v_member ->> 'address', ''))) > 200 then v_message := 'Address must be 200 characters or fewer.';
    elsif coalesce(v_member ->> 'emergencyContact', '') <> '' and v_emergency !~ '^[0-9]{10}$' then
      v_message := 'Emergency contact must contain exactly 10 local digits.';
    else
      select exists (select 1 from jsonb_array_elements(v_members) existing
        where nullif(existing ->> 'deletedAt', '') is null and (
          (v_email <> '' and lower(btrim(coalesce(existing ->> 'email', ''))) = v_email)
          or right(regexp_replace(coalesce(existing ->> 'phone', ''), '[^0-9]', '', 'g'), 10) = v_phone))
        into v_duplicate;
      if v_duplicate and not coalesce((v_row ->> 'allowDuplicate')::boolean, false) then
        v_status := 'skipped'; v_message := 'Possible duplicate email or phone; explicitly approve it to import.';
      else
        v_id := gen_random_uuid()::text;
        v_members := v_members || jsonb_build_array(jsonb_build_object(
          'id', v_id, 'type', 'member', 'name', v_name, 'email', v_email,
          'phone', v_phone_prefix || v_phone, 'gender', v_gender,
          'dob', to_jsonb(v_dob::timestamp at time zone 'UTC'),
          'address', btrim(coalesce(v_member ->> 'address', '')),
          'photo', null, 'joinDate', to_jsonb(v_join_date::timestamp at time zone 'UTC'),
          'emergencyContact', case when v_emergency = '' then '' else v_phone_prefix || v_emergency end,
          'notes', '[]'::jsonb, 'measurements', '[]'::jsonb, 'deletedAt', null, 'deletedBy', null
        ));
        v_status := 'imported'; v_message := 'Member prepared in the designated source gym.';
      end if;
    end if;
    insert into public.platform_member_migration_items(operation_id, row_number, source_member_id, outcome, message, request_digest)
    values (p_operation_id, v_row_number, v_id, v_status, left(v_message, 240), v_request_digest);
  end loop;

  v_next := jsonb_set(v_workspace.state, '{members}', v_members, true);
  perform public.iv_validate_workspace(v_next);
  if v_members is distinct from coalesce(v_workspace.state -> 'members', '[]'::jsonb) then
    update public.gym_workspaces set state = v_next, revision = revision + 1, updated_at = now()
      where gym_id = p_source_gym_id;
  end if;
  select count(*)::integer, count(*) filter (where outcome = 'imported')::integer,
    count(*) filter (where outcome = 'skipped')::integer, count(*) filter (where outcome = 'failed')::integer
    into v_total, v_success, v_skipped, v_failed
    from public.platform_member_migration_items where operation_id = p_operation_id;
  v_operation_status := case when not coalesce(p_final, false) then 'processing'
    when v_failed = 0 and v_skipped = 0 then 'completed'
    when v_success > 0 then 'partial' else 'failed' end;
  update public.platform_member_migration_operations set status = v_operation_status,
    total_count = (select count(*) from public.platform_member_migration_items where operation_id = p_operation_id),
    successful_count = v_success, skipped_count = v_skipped, failed_count = v_failed, updated_at = now()
    where id = p_operation_id;
  if p_final then perform public.platform_write_audit('member_migration_imported', p_source_gym_id,
    jsonb_build_object('operation_id', p_operation_id, 'imported', v_success, 'skipped', v_skipped, 'failed', v_failed)); end if;
  return jsonb_build_object('status', v_operation_status, 'total',
    (select count(*) from public.platform_member_migration_items where operation_id = p_operation_id),
    'imported', v_success, 'skipped', v_skipped, 'failed', v_failed, 'operation_id', p_operation_id,
    'results', coalesce((select jsonb_agg(jsonb_build_object('row_number', row_number, 'outcome', outcome, 'message', message)
      order by row_number) from public.platform_member_migration_items where operation_id = p_operation_id), '[]'::jsonb));
end;
$$;

create or replace function public.platform_transfer_members(
  p_operation_id uuid, p_source_gym_id uuid, p_destination_gym_id uuid,
  p_member_ids text[], p_row_offset integer, p_all_member_ids text[], p_plan_mapping jsonb,
  p_transfer_active_payments boolean default true, p_override_duplicates text[] default '{}',
  p_final boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_source public.gyms%rowtype; v_destination public.gyms%rowtype;
  v_source_workspace public.gym_workspaces%rowtype; v_destination_workspace public.gym_workspaces%rowtype;
  v_operation public.platform_member_migration_operations%rowtype;
  v_source_state jsonb; v_destination_state jsonb; v_source_members jsonb; v_source_memberships jsonb;
  v_source_payments jsonb; v_destination_members jsonb; v_destination_memberships jsonb;
  v_destination_payments jsonb; v_next_source jsonb; v_next_destination jsonb;
  v_member_id text; v_member jsonb; v_new_member jsonb; v_current jsonb; v_copy_membership jsonb;
  v_existing_member_id text;
  v_plan_id text; v_new_plan_id text; v_new_member_id text; v_new_membership_id text;
  v_payment jsonb; v_new_payment jsonb; v_payment_id text; v_invoice_no text; v_invoice_seq integer;
  v_invoice_prefix text; v_status text; v_message text; v_row_number integer;
  v_duplicate boolean; v_moved integer := 0; v_skipped integer := 0; v_failed integer := 0;
  v_total integer; v_success integer; v_operation_status text; v_config jsonb;
  v_source_timezone text; v_source_today date;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_operation_id is null or p_source_gym_id is null or p_destination_gym_id is null
     or p_source_gym_id = p_destination_gym_id or coalesce(array_length(p_member_ids, 1), 0) not between 1 and 100
     or p_row_offset is null or p_row_offset < 0
     or coalesce(jsonb_typeof(p_plan_mapping), 'null') <> 'object'
     or coalesce(cardinality(p_all_member_ids), 0) not between 1 and 5000
     or p_row_offset + cardinality(p_member_ids) > cardinality(p_all_member_ids)
     or to_jsonb(p_member_ids) is distinct from to_jsonb(
       p_all_member_ids[(p_row_offset + 1):(p_row_offset + cardinality(p_member_ids))]) then
    raise exception 'INVALID_TRANSFER_BATCH';
  end if;
  if array_position(p_all_member_ids, null) is not null or array_position(p_all_member_ids, '') is not null
     or (select count(distinct member_id) from unnest(p_all_member_ids) as members(member_id)) <> cardinality(p_all_member_ids)
     or exists (select 1 from unnest(coalesce(p_override_duplicates, '{}')) as overrides(member_id)
       where member_id is null or member_id = '' or not (member_id = any(p_all_member_ids))) then
    raise exception 'INVALID_TRANSFER_MEMBER_IDS';
  end if;

  -- Lock gym and workspace rows in stable ID order so overlapping transfers do not deadlock.
  perform 1 from public.gyms where id in (p_source_gym_id, p_destination_gym_id) order by id for update;
  select * into v_source from public.gyms where id = p_source_gym_id;
  select * into v_destination from public.gyms where id = p_destination_gym_id;
  if v_source.id is null or not v_source.is_member_migration_source then raise exception 'DESIGNATED_SOURCE_REQUIRED'; end if;
  if v_destination.id is null then raise exception 'INVALID_DESTINATION_GYM'; end if;
  if v_source.account_status <> 'active' or v_destination.account_status <> 'active' then raise exception 'ACTIVE_GYMS_REQUIRED'; end if;
  -- Workspace lock order mirrors gym lock order.
  perform 1 from public.gym_workspaces where gym_id in (p_source_gym_id, p_destination_gym_id)
    order by gym_id for update;
  select * into v_source_workspace from public.gym_workspaces where gym_id = p_source_gym_id;
  select * into v_destination_workspace from public.gym_workspaces where gym_id = p_destination_gym_id;
  if v_source_workspace.gym_id is null or v_destination_workspace.gym_id is null then raise exception 'WORKSPACE_NOT_FOUND'; end if;

  v_config := jsonb_build_object('plan_mapping', p_plan_mapping,
    'transfer_active_payments', coalesce(p_transfer_active_payments, true),
    'selected_member_ids', to_jsonb(p_all_member_ids),
    'duplicate_overrides', to_jsonb(coalesce(p_override_duplicates, '{}'::text[])));
  insert into public.platform_member_migration_operations
    (id, operation_type, source_gym_id, destination_gym_id, admin_user_id, config)
  values (p_operation_id, 'transfer', p_source_gym_id, p_destination_gym_id, auth.uid(), v_config)
  on conflict (id) do nothing;
  select * into v_operation from public.platform_member_migration_operations where id = p_operation_id for update;
  if v_operation.operation_type <> 'transfer' or v_operation.source_gym_id <> p_source_gym_id
     or v_operation.destination_gym_id <> p_destination_gym_id or v_operation.admin_user_id is distinct from auth.uid()
     or v_operation.config is distinct from v_config then raise exception 'MIGRATION_OPERATION_MISMATCH'; end if;
  if v_operation.status <> 'processing' then
    return jsonb_build_object('status', v_operation.status, 'total', v_operation.total_count,
      'transferred', v_operation.successful_count, 'skipped', v_operation.skipped_count,
      'failed', v_operation.failed_count, 'operation_id', p_operation_id);
  end if;

  v_source_state := v_source_workspace.state; v_destination_state := v_destination_workspace.state;
  v_source_timezone := case v_source_state #>> '{settings,phoneCountry}'
    when 'nepal' then 'Asia/Kathmandu'
    when 'usa' then 'America/New_York'
    else 'Asia/Kolkata' end;
  v_source_today := (now() at time zone v_source_timezone)::date;
  v_source_members := coalesce(v_source_state -> 'members', '[]'::jsonb);
  v_source_memberships := coalesce(v_source_state -> 'memberships', '[]'::jsonb);
  v_source_payments := coalesce(v_source_state -> 'payments', '[]'::jsonb);
  v_destination_members := coalesce(v_destination_state -> 'members', '[]'::jsonb);
  v_destination_memberships := coalesce(v_destination_state -> 'memberships', '[]'::jsonb);
  v_destination_payments := coalesce(v_destination_state -> 'payments', '[]'::jsonb);
  v_invoice_prefix := coalesce(nullif(v_destination_state #>> '{settings,invoicePrefix}', ''), 'INV');
  v_invoice_seq := greatest(coalesce((v_destination_state ->> 'invoiceSeq')::integer, 0), 0);

  for v_member_id in select distinct unnest(p_member_ids) loop
    v_row_number := p_row_offset + 1 + array_position(p_member_ids, v_member_id) - 1;
    select source_member_id into v_existing_member_id from public.platform_member_migration_items
      where operation_id = p_operation_id and row_number = v_row_number;
    if found then
      if v_existing_member_id is distinct from v_member_id then raise exception 'MIGRATION_OPERATION_MISMATCH'; end if;
      continue;
    end if;
    v_status := 'failed'; v_message := 'Member is not available in the designated source gym.';
    select member into v_member from jsonb_array_elements(v_source_members) member
      where member ->> 'id' = v_member_id and coalesce(member ->> 'type', 'member') <> 'walk_in'
        and nullif(member ->> 'deletedAt', '') is null limit 1;
    if v_member is not null then
      if exists(select 1 from public.platform_member_migration_links where source_gym_id = p_source_gym_id
        and source_member_id = v_member_id) then
        v_status := 'skipped'; v_message := 'This member has already been transferred from the source gym.';
      else
        select exists (select 1 from jsonb_array_elements(v_destination_members) dm
          where nullif(dm ->> 'deletedAt', '') is null and (
            (nullif(lower(btrim(coalesce(v_member ->> 'email', ''))), '') is not null
              and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(v_member ->> 'email')))
            or (length(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
              and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g'), 10))))
          into v_duplicate;
        if v_duplicate and not v_member_id = any(coalesce(p_override_duplicates, '{}')) then
          v_status := 'skipped'; v_message := 'Possible duplicate email or phone in the destination gym.';
        else
          select item.value into v_current from jsonb_array_elements(v_source_memberships) with ordinality item(value, ordinality)
            where item.value ->> 'memberId' = v_member_id
            order by (item.value ->> 'endDate')::timestamptz desc, item.ordinality asc limit 1;
          if v_current is not null and not coalesce((v_current ->> 'frozen')::boolean, false)
             and timezone(v_source_timezone, (v_current ->> 'endDate')::timestamptz)::date >= v_source_today then
            v_plan_id := v_current ->> 'planId';
            v_new_plan_id := p_plan_mapping ->> v_plan_id;
            if v_new_plan_id is null or not exists (select 1 from jsonb_array_elements(
              coalesce(v_destination_state -> 'plans', '[]'::jsonb)) plan
              where plan ->> 'id' = v_new_plan_id and coalesce((plan ->> 'active')::boolean, false)
                and nullif(plan ->> 'deletedAt', '') is null) then
              v_message := 'Map this active membership to an active destination plan before transferring.';
            else
              v_message := '';
            end if;
          else
            v_current := null; v_message := '';
          end if;
          if v_message = '' then
            v_new_member_id := gen_random_uuid()::text;
            v_new_member := jsonb_set(v_member - 'photo' - 'deletedAt' - 'deletedBy', '{id}', to_jsonb(v_new_member_id), true);
            v_new_member := jsonb_set(v_new_member, '{photo}', 'null'::jsonb, true);
            v_destination_members := v_destination_members || jsonb_build_array(v_new_member);

            if v_current is not null then
              v_new_membership_id := gen_random_uuid()::text;
              v_copy_membership := jsonb_set(v_current, '{id}', to_jsonb(v_new_membership_id), true);
              v_copy_membership := jsonb_set(v_copy_membership, '{memberId}', to_jsonb(v_new_member_id), true);
              v_copy_membership := jsonb_set(v_copy_membership, '{planId}', to_jsonb(v_new_plan_id), true);
              v_destination_memberships := v_destination_memberships || jsonb_build_array(v_copy_membership);
              if coalesce(p_transfer_active_payments, true) then
                for v_payment in select value from jsonb_array_elements(v_source_payments) value
                  where value ->> 'membershipId' = v_current ->> 'id' order by value ->> 'date', value ->> 'id'
                loop
                  v_payment_id := gen_random_uuid()::text;
                  loop
                    v_invoice_seq := v_invoice_seq + 1;
                    v_invoice_no := v_invoice_prefix || '-' || lpad(v_invoice_seq::text, 6, '0');
                    exit when not exists (select 1 from jsonb_array_elements(v_destination_payments) existing
                      where existing ->> 'invoiceNo' = v_invoice_no)
                      and not exists (select 1 from jsonb_array_elements(coalesce(v_destination_state -> 'sales', '[]'::jsonb)) sale
                        where sale ->> 'invoiceNo' = v_invoice_no);
                  end loop;
                  v_new_payment := jsonb_set(v_payment, '{id}', to_jsonb(v_payment_id), true);
                  v_new_payment := jsonb_set(v_new_payment, '{memberId}', to_jsonb(v_new_member_id), true);
                  v_new_payment := jsonb_set(v_new_payment, '{membershipId}', to_jsonb(v_new_membership_id), true);
                  v_new_payment := jsonb_set(v_new_payment, '{invoiceNo}', to_jsonb(v_invoice_no), true);
                  v_new_payment := jsonb_set(v_new_payment, '{note}', to_jsonb(left(
                    'Migrated from ' || v_source.name || ' (' || coalesce(v_payment ->> 'invoiceNo', 'no invoice') || '): ' ||
                    coalesce(v_payment ->> 'note', ''), 500)), true);
                  v_destination_payments := v_destination_payments || jsonb_build_array(v_new_payment);
                end loop;
              end if;
            end if;

            -- Keep the source row recoverable in Trash. Retain older terms,
            -- product sales and their payment history with their original gym.
            v_source_members := (select coalesce(jsonb_agg(case when value ->> 'id' = v_member_id
              then jsonb_set(jsonb_set(value, '{deletedAt}', to_jsonb(now()), true), '{deletedBy}', to_jsonb(auth.uid()::text), true)
              else value end order by ordinality), '[]'::jsonb)
              from jsonb_array_elements(v_source_members) with ordinality rows(value, ordinality));
            if v_current is not null and coalesce(p_transfer_active_payments, true) then
              v_source_memberships := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_memberships) with ordinality rows(value, ordinality)
                where value ->> 'id' <> (v_current ->> 'id'));
              v_source_payments := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_payments) with ordinality rows(value, ordinality)
                where value ->> 'membershipId' <> (v_current ->> 'id'));
            end if;
            insert into public.platform_member_migration_links(source_gym_id, destination_gym_id,
              source_member_id, destination_member_id, operation_id)
            values (p_source_gym_id, p_destination_gym_id, v_member_id, v_new_member_id, p_operation_id);
            v_status := 'transferred'; v_message := case when v_current is null
              then 'Profile transferred; no active membership was present.'
              when coalesce(p_transfer_active_payments, true)
              then 'Profile, active membership and linked payments transferred. Other history remains at source.'
              else 'Profile and membership copied. Linked payments remain at source; destination shows the outstanding balance.' end;
          end if;
        end if;
      end if;
    end if;
    insert into public.platform_member_migration_items(operation_id, row_number, source_member_id,
      destination_member_id, outcome, message)
    values (p_operation_id, v_row_number, v_member_id,
      case when v_status = 'transferred' then v_new_member_id else null end, v_status, left(v_message, 240));
  end loop;

  v_next_source := jsonb_set(jsonb_set(jsonb_set(v_source_state, '{members}', v_source_members, true),
    '{memberships}', v_source_memberships, true), '{payments}', v_source_payments, true);
  v_next_destination := jsonb_set(jsonb_set(jsonb_set(v_destination_state, '{members}', v_destination_members, true),
    '{memberships}', v_destination_memberships, true), '{payments}', v_destination_payments, true);
  v_next_destination := jsonb_set(v_next_destination, '{invoiceSeq}', to_jsonb(v_invoice_seq), true);
  perform public.iv_validate_workspace(v_next_source);
  perform public.iv_validate_workspace(v_next_destination);
  if v_next_source is distinct from v_source_state then
    update public.gym_workspaces set state = v_next_source, revision = revision + 1, updated_at = now()
      where gym_id = p_source_gym_id;
  end if;
  if v_next_destination is distinct from v_destination_state then
    update public.gym_workspaces set state = v_next_destination, revision = revision + 1, updated_at = now()
      where gym_id = p_destination_gym_id;
  end if;
  select count(*)::integer, count(*) filter (where outcome = 'transferred')::integer,
    count(*) filter (where outcome = 'skipped')::integer, count(*) filter (where outcome = 'failed')::integer
    into v_total, v_success, v_skipped, v_failed from public.platform_member_migration_items where operation_id = p_operation_id;
  v_operation_status := case when not coalesce(p_final, false) then 'processing'
    when v_failed = 0 and v_skipped = 0 then 'completed'
    when v_success > 0 then 'partial' else 'failed' end;
  update public.platform_member_migration_operations set status = v_operation_status,
    total_count = v_total, successful_count = v_success, skipped_count = v_skipped,
    failed_count = v_failed, updated_at = now() where id = p_operation_id;
  if p_final then perform public.platform_write_audit('members_migrated', p_destination_gym_id,
    jsonb_build_object('operation_id', p_operation_id, 'source_gym_id', p_source_gym_id,
      'transferred', v_success, 'skipped', v_skipped, 'failed', v_failed,
      'active_membership_payments_moved', coalesce(p_transfer_active_payments, true))); end if;
  return jsonb_build_object('status', v_operation_status, 'total', v_total,
    'transferred', v_success, 'skipped', v_skipped, 'failed', v_failed, 'operation_id', p_operation_id,
    'results', coalesce((select jsonb_agg(jsonb_build_object('row_number', row_number,
      'source_member_id', source_member_id, 'outcome', outcome, 'message', message) order by row_number)
      from public.platform_member_migration_items where operation_id = p_operation_id), '[]'::jsonb));
exception when others then
  -- PostgreSQL rolls the entire workspace move back if either tenant cannot be
  -- validated; callers only receive a confirmed commit or a raised error.
  raise;
end;
$$;

create or replace function public.platform_list_member_migration_history(p_page integer default 1, p_page_size integer default 25)
returns table (operation_id uuid, operation_type text, source_gym_name text, destination_gym_name text,
  admin_email text, status text, total_count integer, successful_count integer,
  skipped_count integer, failed_count integer, created_at timestamptz, updated_at timestamptz, row_count bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query select o.id, o.operation_type, s.name, d.name, coalesce(u.email, 'Removed admin'),
    o.status, o.total_count, o.successful_count, o.skipped_count, o.failed_count, o.created_at, o.updated_at,
    count(*) over ()
  from public.platform_member_migration_operations o
  left join public.gyms s on s.id = o.source_gym_id
  left join public.gyms d on d.id = o.destination_gym_id
  left join auth.users u on u.id = o.admin_user_id
  order by o.created_at desc
  limit least(greatest(coalesce(p_page_size, 25), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;

create or replace function public.platform_finalize_member_migration(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_operation public.platform_member_migration_operations%rowtype;
  v_total integer; v_success integer; v_skipped integer; v_failed integer; v_status text;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  select * into v_operation from public.platform_member_migration_operations where id = p_operation_id for update;
  if not found or v_operation.admin_user_id is distinct from auth.uid() then raise exception 'MIGRATION_OPERATION_NOT_FOUND'; end if;
  if v_operation.status <> 'processing' then raise exception 'MIGRATION_OPERATION_ALREADY_FINAL'; end if;
  select count(*)::integer, count(*) filter (where outcome in ('imported', 'transferred'))::integer,
    count(*) filter (where outcome = 'skipped')::integer, count(*) filter (where outcome = 'failed')::integer
    into v_total, v_success, v_skipped, v_failed from public.platform_member_migration_items where operation_id = p_operation_id;
  v_status := case when v_success = 0 then 'failed' else 'partial' end;
  update public.platform_member_migration_operations set status = v_status, total_count = v_total,
    successful_count = v_success, skipped_count = v_skipped, failed_count = v_failed, updated_at = now()
    where id = p_operation_id;
  perform public.platform_write_audit('member_migration_interrupted', v_operation.destination_gym_id,
    jsonb_build_object('operation_id', p_operation_id, 'processed', v_total,
      'successful', v_success, 'skipped', v_skipped, 'failed', v_failed));
  return jsonb_build_object('status', v_status, 'total', v_total, 'successful', v_success,
    'skipped', v_skipped, 'failed', v_failed);
end;
$$;

create or replace function public.platform_list_member_migration_items(p_operation_id uuid)
returns table (row_number integer, source_member_id text, destination_member_id text, outcome text, message text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.platform_member_migration_operations
    where id = p_operation_id and admin_user_id = auth.uid()) then raise exception 'MIGRATION_OPERATION_NOT_FOUND'; end if;
  return query select i.row_number, i.source_member_id, i.destination_member_id, i.outcome, i.message
    from public.platform_member_migration_items i where i.operation_id = p_operation_id order by i.row_number;
end;
$$;

revoke all on function public.platform_list_member_migration_gyms() from public, anon, service_role;
revoke all on function public.platform_set_member_migration_source(uuid, text) from public, anon, service_role;
revoke all on function public.platform_get_member_migration_context(uuid, uuid) from public, anon, service_role;
revoke all on function public.platform_list_member_migration_members(uuid, uuid, text, integer, integer) from public, anon, service_role;
revoke all on function public.platform_import_migration_members(uuid, uuid, jsonb, boolean) from public, anon, service_role;
revoke all on function public.platform_transfer_members(uuid, uuid, uuid, text[], integer, text[], jsonb, boolean, text[], boolean) from public, anon, service_role;
revoke all on function public.platform_list_member_migration_history(integer, integer) from public, anon, service_role;
revoke all on function public.platform_finalize_member_migration(uuid) from public, anon, service_role;
revoke all on function public.platform_list_member_migration_items(uuid) from public, anon, service_role;
grant execute on function public.platform_list_member_migration_gyms() to authenticated;
grant execute on function public.platform_set_member_migration_source(uuid, text) to authenticated;
grant execute on function public.platform_get_member_migration_context(uuid, uuid) to authenticated;
grant execute on function public.platform_list_member_migration_members(uuid, uuid, text, integer, integer) to authenticated;
grant execute on function public.platform_import_migration_members(uuid, uuid, jsonb, boolean) to authenticated;
grant execute on function public.platform_transfer_members(uuid, uuid, uuid, text[], integer, text[], jsonb, boolean, text[], boolean) to authenticated;
grant execute on function public.platform_list_member_migration_history(integer, integer) to authenticated;
grant execute on function public.platform_finalize_member_migration(uuid) to authenticated;
grant execute on function public.platform_list_member_migration_items(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'platform_admin_live_refresh'
    and tgrelid = 'public.platform_member_migration_operations'::regclass) then
    create trigger platform_admin_live_refresh after insert or update or delete on public.platform_member_migration_operations
      for each statement execute function public.iv_broadcast_platform_refresh();
  end if;
end;
$$;
