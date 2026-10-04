-- Run after 20261004160000_platform_pro_admin.sql.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.platform_admins'::regclass) then
    raise exception 'platform_admins must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.platform_admins', 'SELECT')
    or has_table_privilege('authenticated', 'public.platform_admins', 'SELECT')
    or has_table_privilege('service_role', 'public.platform_admins', 'SELECT') then
    raise exception 'browser/service roles must not read platform_admins directly';
  end if;

  if has_function_privilege('anon', 'public.platform_list_owners()', 'EXECUTE')
    or has_function_privilege('service_role', 'public.platform_list_owners()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.platform_list_owners()', 'EXECUTE') then
    raise exception 'platform owner list RPC grants are too broad or missing';
  end if;

  if has_function_privilege('anon', 'public.platform_generate_recharge_code(uuid,integer,integer,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.platform_generate_recharge_code(uuid,integer,integer,text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.platform_generate_recharge_code(uuid,integer,integer,text)', 'EXECUTE') then
    raise exception 'recharge code generation RPC grants are too broad or missing';
  end if;

  if has_function_privilege('authenticated', 'public.generate_recharge_codes(integer,integer,integer,text,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.generate_recharge_codes(integer,integer,integer,text,text)', 'EXECUTE') then
    raise exception 'raw plaintext code generator must remain inaccessible through the API';
  end if;
end;
$$;

