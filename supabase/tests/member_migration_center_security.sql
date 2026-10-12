-- CEO member migration privilege-boundary checks.
-- Run after 20261010150000_platform_member_migration_center.sql.
do $$
declare
  v_function regprocedure;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.platform_member_migration_operations'::regclass)
    or not (select relrowsecurity from pg_class where oid = 'public.platform_member_migration_items'::regclass)
    or not (select relrowsecurity from pg_class where oid = 'public.platform_member_migration_links'::regclass) then
    raise exception 'member migration operational tables must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.platform_member_migration_operations', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_member_migration_operations', 'SELECT')
    or has_table_privilege('service_role', 'public.platform_member_migration_operations', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_member_migration_items', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_member_migration_links', 'SELECT') then
    raise exception 'migration operation records must only be read through guarded RPCs';
  end if;

  if has_column_privilege('authenticated', 'public.gyms', 'is_member_migration_source', 'UPDATE') then
    raise exception 'gym owners cannot designate a migration source directly';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
    and indexname = 'platform_member_migration_source_link_unique_idx') then
    raise exception 'a source member must not be transferred to multiple destination gyms';
  end if;

  for v_function in
    select function_name::regprocedure from unnest(array[
      'public.platform_list_member_migration_gyms()',
      'public.platform_set_member_migration_source(uuid,text)',
      'public.platform_get_member_migration_context(uuid,uuid)',
      'public.platform_list_member_migration_members(uuid,uuid,text,integer,integer)',
      'public.platform_import_migration_members(uuid,uuid,jsonb,boolean)',
      'public.platform_transfer_members(uuid,uuid,uuid,text[],integer,text[],jsonb,boolean,text[],boolean)',
      'public.platform_list_member_migration_history(integer,integer)',
      'public.platform_finalize_member_migration(uuid)',
      'public.platform_list_member_migration_items(uuid)'
    ]) as functions(function_name)
  loop
    if not (select prosecdef from pg_proc where oid = v_function) then
      raise exception 'migration RPC % must be SECURITY DEFINER', v_function;
    end if;
    if has_function_privilege('anon', v_function, 'EXECUTE')
      or not has_function_privilege('authenticated', v_function, 'EXECUTE') then
      raise exception 'migration RPC % must be authenticated-only', v_function;
    end if;
  end loop;

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  begin
    perform * from public.platform_list_member_migration_gyms();
    raise exception 'a normal account could read platform migration gym data';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;

  begin
    perform public.platform_set_member_migration_source('00000000-0000-0000-0000-000000000002'::uuid, 'No gym');
    raise exception 'a normal account could change the migration source';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
end;
$$;

-- Exercise the table-returning RPC as a real platform admin where one exists.
-- This catches PostgreSQL varchar/text return mismatches without exposing gym data.
do $$
declare
  v_admin uuid;
  v_returned integer;
  v_expected integer;
  v_history_rows integer;
begin
  select user_id into v_admin from public.platform_admins where enabled limit 1;
  if v_admin is null then
    raise notice 'No platform admin is seeded; migration gym RPC result assertion skipped.';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into v_returned from public.platform_list_member_migration_gyms();
  select least(count(*), 1000)::integer into v_expected from public.gyms;
  if v_returned <> v_expected then
    raise exception 'migration gym RPC returned % rows; expected %', v_returned, v_expected;
  end if;

  -- Execute the history RPC as an admin to catch return-type mismatches while
  -- revealing only the row count, never gym/member data.
  select count(*) into v_history_rows
    from public.platform_list_member_migration_history(1, 25);
end;
$$;
