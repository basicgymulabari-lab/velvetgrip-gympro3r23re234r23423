-- Give the CEO migration preview the same destination subscription signal used
-- by enforce_gym_member_limit, so the UI can explain capacity before transfer.
create or replace function public.platform_get_member_migration_context(
  p_source_gym_id uuid, p_destination_gym_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_source public.gyms%rowtype;
  v_destination public.gyms%rowtype;
  v_source_state jsonb;
  v_destination_state jsonb;
  v_destination_member_count integer;
  v_destination_has_pro boolean;
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

  select count(*)::integer into v_destination_member_count
  from jsonb_array_elements(
    case when jsonb_typeof(v_destination_state -> 'members') = 'array'
      then v_destination_state -> 'members' else '[]'::jsonb end
  ) member
  where coalesce(member ->> 'type', 'member') <> 'walk_in'
    and nullif(member ->> 'deletedAt', '') is null;

  -- Match the authoritative member-limit trigger: only an active entitlement
  -- with a future period end unlocks the Pro roster limit.
  select exists (
    select 1 from public.subscription_entitlements entitlement
    where entitlement.gym_id = p_destination_gym_id
      and entitlement.status = 'active'
      and entitlement.current_period_end > now()
  ) into v_destination_has_pro;

  return jsonb_build_object(
    'source', jsonb_build_object('gym_id', v_source.id, 'gym_name', v_source.name,
      'member_count', (select count(*)::integer from jsonb_array_elements(
        case when jsonb_typeof(v_source_state -> 'members') = 'array' then v_source_state -> 'members' else '[]'::jsonb end
      ) member where coalesce(member ->> 'type', 'member') <> 'walk_in'
        and nullif(member ->> 'deletedAt', '') is null)),
    'destination', jsonb_build_object('gym_id', v_destination.id, 'gym_name', v_destination.name,
      'member_count', v_destination_member_count,
      'has_pro', v_destination_has_pro,
      'remaining_free_slots', case when v_destination_has_pro then null
        else greatest(10 - v_destination_member_count, 0) end),
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

revoke all on function public.platform_get_member_migration_context(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.platform_get_member_migration_context(uuid, uuid) to authenticated;
