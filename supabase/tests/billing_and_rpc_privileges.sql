-- Run after 20261012000000_harden_public_rpc_and_billing_permissions.sql.
do $$
declare
  v_function regprocedure;
begin
  if has_table_privilege('anon', 'public.billing_transactions', 'SELECT')
    or has_table_privilege('anon', 'public.billing_transactions', 'INSERT')
    or has_table_privilege('anon', 'public.billing_transactions', 'UPDATE')
    or has_table_privilege('anon', 'public.billing_transactions', 'DELETE')
    or has_table_privilege('anon', 'public.billing_transactions', 'TRUNCATE')
    or has_table_privilege('anon', 'public.billing_transactions', 'REFERENCES')
    or has_table_privilege('anon', 'public.billing_transactions', 'TRIGGER') then
    raise exception 'anon must not access or alter billing transaction history';
  end if;

  if not has_table_privilege('authenticated', 'public.billing_transactions', 'SELECT') then
    raise exception 'authenticated gym owners must retain RLS-scoped billing history reads';
  end if;

  if has_table_privilege('authenticated', 'public.billing_transactions', 'INSERT')
    or has_table_privilege('authenticated', 'public.billing_transactions', 'UPDATE')
    or has_table_privilege('authenticated', 'public.billing_transactions', 'DELETE')
    or has_table_privilege('authenticated', 'public.billing_transactions', 'TRUNCATE')
    or has_table_privilege('authenticated', 'public.billing_transactions', 'REFERENCES')
    or has_table_privilege('authenticated', 'public.billing_transactions', 'TRIGGER') then
    raise exception 'authenticated users must not write or administer billing transaction history';
  end if;

  if not has_table_privilege('service_role', 'public.billing_transactions', 'INSERT')
    or not has_table_privilege('service_role', 'public.billing_transactions', 'UPDATE') then
    raise exception 'billing backend must retain transaction write access';
  end if;

  if has_function_privilege(
       'anon', 'public.claim_billing_webhook_event(text,text,text,text,uuid,integer)', 'EXECUTE'
     )
    or has_function_privilege(
       'authenticated', 'public.claim_billing_webhook_event(text,text,text,text,uuid,integer)', 'EXECUTE'
     ) then
    raise exception 'webhook claim routine must remain unavailable to clients';
  end if;
  if not has_function_privilege(
       'service_role', 'public.claim_billing_webhook_event(text,text,text,text,uuid,integer)', 'EXECUTE'
     ) then
    raise exception 'billing backend must be able to claim webhook events';
  end if;

  foreach v_function in array array[
    'public.iv_current_gym_id()'::regprocedure,
    'public.iv_is_current_gym_owner()'::regprocedure,
    'public.load_current_gym_workspace()'::regprocedure,
    'public.save_current_gym_workspace(jsonb,bigint)'::regprocedure,
    'public.ensure_owner_gym(text,jsonb)'::regprocedure,
    'public.get_current_gym_context()'::regprocedure,
    'public.record_audit_event(text,text,text,jsonb)'::regprocedure
  ] loop
    if has_function_privilege('anon', v_function, 'EXECUTE') then
      raise exception 'unauthenticated callers can execute %', v_function;
    end if;
    if not has_function_privilege('authenticated', v_function, 'EXECUTE') then
      raise exception 'authenticated callers lost required execution on %', v_function;
    end if;
    if has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'service_role has unnecessary execution on %', v_function;
    end if;
  end loop;

  foreach v_function in array array[
    'public.iv_validate_workspace_trigger()'::regprocedure,
    'public.enforce_gym_member_limit()'::regprocedure
  ] loop
    if has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'trigger-only routine is directly executable: %', v_function;
    end if;
  end loop;
end;
$$;
