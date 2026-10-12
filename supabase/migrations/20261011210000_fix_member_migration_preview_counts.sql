-- Fix per-member history counts in the CEO migration preview.
-- The unqualified table alias `membership` was shadowed by the outer
-- `a.membership` column, turning the count predicate into a constant and
-- showing the entire source roster count for every member.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.platform_list_member_migration_members(uuid,uuid,text,integer,integer)'::regprocedure
  ) into v_definition;

  if position('from jsonb_array_elements(coalesce(v_source -> ''memberships'', ''[]''::jsonb)) as terms(value)' in v_definition) = 0 then
    v_old := $old$
      'membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) membership
        where membership ->> 'memberId' = a.m ->> 'id'),
      'active_membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) membership
        where membership ->> 'memberId' = a.m ->> 'id'
          and not coalesce((membership ->> 'frozen')::boolean, false)
          and timezone(v_source_timezone, (membership ->> 'endDate')::timestamptz)::date >= v_source_today)
$old$;
    v_new := $new$
      'membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) as terms(value)
        where terms.value ->> 'memberId' = a.m ->> 'id'),
      'active_membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) as terms(value)
        where terms.value ->> 'memberId' = a.m ->> 'id'
          and not coalesce((terms.value ->> 'frozen')::boolean, false)
          and timezone(v_source_timezone, (terms.value ->> 'endDate')::timestamptz)::date >= v_source_today)
$new$;

    if position(v_old in v_definition) = 0 then
      raise exception 'Expected member migration preview count expression was not found; refusing an unsafe function rewrite';
    end if;

    execute replace(v_definition, v_old, v_new);
  end if;
end;
$migration$;
