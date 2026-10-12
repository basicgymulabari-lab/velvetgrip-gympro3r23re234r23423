-- Keep the CEO migration roster preview below PostgREST's authenticated
-- statement timeout for large gyms. The previous implementation repeatedly
-- expanded every membership and destination member for every source member.
-- This version counts/sorts the source once, then enriches only the requested
-- page and materializes destination contacts and migration links once.
create or replace function public.platform_list_member_migration_members(
  p_source_gym_id uuid,
  p_destination_gym_id uuid default null,
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 100
)
returns table (
  member jsonb,
  possible_duplicate boolean,
  current_membership jsonb,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_source jsonb;
  v_destination jsonb;
  v_source_name text;
  v_source_timezone text;
  v_source_today date;
  v_page integer;
  v_page_size integer;
  v_offset integer;
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if not exists (
    select 1 from public.gyms
    where id = p_source_gym_id and is_member_migration_source
  ) then
    raise exception 'DESIGNATED_SOURCE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.gyms
    where id = p_source_gym_id and account_status = 'active'
  ) then
    raise exception 'ACTIVE_GYMS_REQUIRED';
  end if;

  select w.state, g.name into v_source, v_source_name
  from public.gym_workspaces w
  join public.gyms g on g.id = w.gym_id
  where w.gym_id = p_source_gym_id;
  if not found then raise exception 'SOURCE_WORKSPACE_NOT_FOUND'; end if;

  v_source_timezone := case v_source #>> '{settings,phoneCountry}'
    when 'nepal' then 'Asia/Kathmandu'
    when 'usa' then 'America/New_York'
    else 'Asia/Kolkata'
  end;
  v_source_today := (now() at time zone v_source_timezone)::date;

  if p_destination_gym_id is not null then
    if p_source_gym_id = p_destination_gym_id or not exists (
      select 1 from public.gyms
      where id = p_destination_gym_id and account_status = 'active'
    ) then
      raise exception 'INVALID_DESTINATION_GYM';
    end if;
    select state into v_destination
    from public.gym_workspaces
    where gym_id = p_destination_gym_id;
    if not found then raise exception 'DESTINATION_WORKSPACE_NOT_FOUND'; end if;
  end if;

  v_page := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size := least(greatest(coalesce(p_page_size, 100), 1), 100);
  v_offset := (v_page - 1) * v_page_size;

  return query
  with source_members as materialized (
    select
      item.value as m,
      row_number() over (
        order by lower(coalesce(item.value ->> 'name', '')), item.value ->> 'id'
      ) as rn,
      count(*) over () as total
    from jsonb_array_elements(coalesce(v_source -> 'members', '[]'::jsonb)) as item(value)
    where coalesce(item.value ->> 'type', 'member') <> 'walk_in'
      and nullif(item.value ->> 'deletedAt', '') is null
      and (
        btrim(coalesce(p_search, '')) = ''
        or concat_ws(' ', item.value ->> 'name', item.value ->> 'email', item.value ->> 'phone')
          ilike '%' || left(btrim(p_search), 100) || '%'
      )
  ), page_members as materialized (
    select sm.m, sm.rn, sm.total
    from source_members sm
    where sm.rn > v_offset and sm.rn <= v_offset + v_page_size
  ), page_contacts as materialized (
    select
      pm.m,
      pm.rn,
      pm.total,
      nullif(lower(btrim(coalesce(pm.m ->> 'email', ''))), '') as normalized_email,
      regexp_replace(coalesce(pm.m ->> 'phone', ''), '[^0-9]', '', 'g') as phone_digits
    from page_members pm
  ), migrated_destination_ids as materialized (
    select distinct migrated.destination_member_id
    from public.platform_member_migration_links migrated
    where v_destination is not null
      and migrated.source_gym_id = p_source_gym_id
      and migrated.destination_gym_id = p_destination_gym_id
  ), destination_contacts as materialized (
    select
      dm.value as m,
      nullif(lower(btrim(coalesce(dm.value ->> 'email', ''))), '') as normalized_email,
      regexp_replace(coalesce(dm.value ->> 'phone', ''), '[^0-9]', '', 'g') as phone_digits
    from jsonb_array_elements(coalesce(v_destination -> 'members', '[]'::jsonb)) as dm(value)
    left join migrated_destination_ids migrated
      on migrated.destination_member_id = dm.value ->> 'id'
    where nullif(dm.value ->> 'deletedAt', '') is null
      and migrated.destination_member_id is null
  ), duplicate_source_ids as materialized (
    select source.id
    from (
      select pc.m ->> 'id' as id, pc.normalized_email
      from page_contacts pc
    ) source
    join destination_contacts destination
      on source.normalized_email is not null
      and source.normalized_email = destination.normalized_email

    union

    select source.id
    from (
      select
        pc.m ->> 'id' as id,
        pc.phone_digits,
        right(pc.phone_digits, 10) as phone_last_ten
      from page_contacts pc
    ) source
    join destination_contacts destination
      on length(source.phone_digits) >= 10
      and length(replace(source.phone_last_ten, left(source.phone_last_ten, 1), '')) > 0
      and right(destination.phone_digits, 10) = source.phone_last_ten
  ), page_memberships as materialized (
    select
      pm.m ->> 'id' as member_id,
      terms.value as membership,
      terms.ordinality,
      count(*) over (partition by pm.m ->> 'id')::integer as membership_count,
      count(*) filter (
        where not coalesce((terms.value ->> 'frozen')::boolean, false)
          and timezone(v_source_timezone, (terms.value ->> 'endDate')::timestamptz)::date >= v_source_today
      ) over (partition by pm.m ->> 'id')::integer as active_membership_count,
      row_number() over (
        partition by pm.m ->> 'id'
        order by (terms.value ->> 'endDate')::timestamptz desc, terms.ordinality asc
      ) as latest_rank
    from page_members pm
    join jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb))
      with ordinality as terms(value, ordinality)
      on terms.value ->> 'memberId' = pm.m ->> 'id'
  ), membership_summaries as materialized (
    select
      history.member_id,
      history.membership as latest_membership,
      history.membership_count,
      history.active_membership_count
    from page_memberships history
    where history.latest_rank = 1
  ), source_plans as materialized (
    select plan.value ->> 'id' as id, plan.value ->> 'name' as name
    from jsonb_array_elements(coalesce(v_source -> 'plans', '[]'::jsonb)) as plan(value)
  )
  select
    jsonb_build_object(
      'id', pc.m -> 'id',
      'name', pc.m -> 'name',
      'email', pc.m -> 'email',
      'phone', pc.m -> 'phone'
    ),
    exists (
      select 1 from duplicate_source_ids duplicate
      where duplicate.id = pc.m ->> 'id'
    ),
    case when summary.latest_membership is null then null else jsonb_build_object(
      'id', summary.latest_membership ->> 'id',
      'plan_id', summary.latest_membership ->> 'planId',
      'plan_name', plan.name,
      'start_date', summary.latest_membership ->> 'startDate',
      'end_date', to_char(
        timezone(v_source_timezone, (summary.latest_membership ->> 'endDate')::timestamptz),
        'YYYY-MM-DD'
      ),
      'frozen', coalesce((summary.latest_membership ->> 'frozen')::boolean, false),
      'active', not coalesce((summary.latest_membership ->> 'frozen')::boolean, false)
        and timezone(v_source_timezone, (summary.latest_membership ->> 'endDate')::timestamptz)::date >= v_source_today,
      'price', summary.latest_membership -> 'price',
      'membership_count', summary.membership_count,
      'active_membership_count', summary.active_membership_count
    ) end,
    pc.total
  from page_contacts pc
  left join membership_summaries summary on summary.member_id = pc.m ->> 'id'
  left join source_plans plan on plan.id = summary.latest_membership ->> 'planId'
  order by pc.rn;
end;
$$;

revoke all on function public.platform_list_member_migration_members(uuid, uuid, text, integer, integer)
  from public, anon, service_role;
grant execute on function public.platform_list_member_migration_members(uuid, uuid, text, integer, integer)
  to authenticated;
