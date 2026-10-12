-- Imported DOB and join dates are calendar dates, not UTC instants. Keeping
-- them as YYYY-MM-DD prevents west-of-UTC gyms from displaying the prior day
-- and keeps month-to-date selectors aligned with the imported value.
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
          'dob', to_jsonb(v_dob::text),
          'address', btrim(coalesce(v_member ->> 'address', '')),
          'photo', null, 'joinDate', to_jsonb(v_join_date::text),
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
