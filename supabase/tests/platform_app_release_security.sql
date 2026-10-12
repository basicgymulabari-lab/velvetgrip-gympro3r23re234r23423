-- Platform app release storage and RPC privilege-boundary assertions.
-- Run after 20261012140000_platform_app_release_center.sql.
do $$
declare
  v_function regprocedure;
  v_public boolean;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.platform_app_releases'::regclass) then
    raise exception 'platform_app_releases must have RLS enabled';
  end if;
  if has_table_privilege('anon', 'public.platform_app_releases', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_app_releases', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_app_releases', 'INSERT')
    or has_table_privilege('authenticated', 'public.platform_app_releases', 'UPDATE')
    or has_table_privilege('authenticated', 'public.platform_app_releases', 'DELETE') then
    raise exception 'release metadata must be accessed only through guarded RPCs';
  end if;

  select public into v_public from storage.buckets where id = 'iv-platform-releases';
  if v_public is distinct from false then
    raise exception 'app release artifact bucket must remain private';
  end if;

  for v_function in
    select function_name::regprocedure from unnest(array[
      'public.platform_list_app_releases()',
      'public.platform_publish_app_release(text,text,text,text,text,text)',
      'public.platform_archive_app_release(uuid)',
      'public.platform_current_app_releases()'
    ]) as functions(function_name)
  loop
    if not (select prosecdef from pg_proc where oid = v_function) then
      raise exception 'app release RPC % must be SECURITY DEFINER', v_function;
    end if;
    if has_function_privilege('anon', v_function, 'EXECUTE')
      or not has_function_privilege('authenticated', v_function, 'EXECUTE') then
      raise exception 'app release RPC % must be authenticated-only', v_function;
    end if;
  end loop;

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  begin
    perform * from public.platform_list_app_releases();
    raise exception 'a normal account could read CEO release history';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
  begin
    perform * from public.platform_publish_app_release(
      'ios', '1.0.0', 'unauthorized QA attempt', null, null, 'https://apps.apple.com/app/example'
    );
    raise exception 'a normal account could publish an app release';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
  begin
    perform public.platform_archive_app_release('00000000-0000-0000-0000-000000000002');
    raise exception 'a normal account could archive an app release';
  exception when raise_exception then
    if sqlerrm <> 'PLATFORM_ADMIN_REQUIRED' then raise; end if;
  end;
  begin
    perform * from public.platform_current_app_releases();
    raise exception 'a user outside a gym workspace could read app releases';
  exception when raise_exception then
    if sqlerrm <> 'GYM_ACCOUNT_REQUIRED' then raise; end if;
  end;
end;
$$;

select 'platform app release security assertions passed' as result;
