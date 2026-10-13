-- Include the exact membership-linked payment count and total in the CEO's
-- pre-transfer preview so operators can reconcile receipts before confirming.
-- Keep the existing RPC return signature and embed these values in its JSON.
do $$
declare
  v_definition text;
  v_old_payment_cte text := $old$
  ), source_plans as materialized (
    select plan.value ->> 'id' as id, plan.value ->> 'name' as name
$old$;
  v_new_payment_cte text := $new$
  ), payments_by_membership as materialized (
    select
      payment.value ->> 'membershipId' as membership_id,
      count(*)::integer as payment_count,
      coalesce(sum((payment.value ->> 'amount')::numeric), 0) as payment_total
    from jsonb_array_elements(coalesce(v_source -> 'payments', '[]'::jsonb)) as payment(value)
    where nullif(payment.value ->> 'membershipId', '') is not null
    group by payment.value ->> 'membershipId'
  ), payment_summaries as materialized (
    select
      terms.value ->> 'memberId' as member_id,
      sum(linked.payment_count)::integer as linked_payment_count,
      coalesce(sum(linked.payment_total), 0) as linked_payment_total
    from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) as terms(value)
    join payments_by_membership linked on linked.membership_id = terms.value ->> 'id'
    group by terms.value ->> 'memberId'
  ), source_plans as materialized (
    select plan.value ->> 'id' as id, plan.value ->> 'name' as name
$new$;
  v_old_fields text := $old$
      'active_membership_count', summary.active_membership_count
$old$;
  v_new_fields text := $new$
      'active_membership_count', summary.active_membership_count,
      'linked_payment_count', coalesce(payment_summary.linked_payment_count, 0),
      'linked_payment_total', coalesce(payment_summary.linked_payment_total, 0),
      'payment_currency', coalesce(nullif(btrim(v_source #>> '{settings,currency}'), ''), '₹')
$new$;
  v_old_join text := $old$
  left join source_plans plan on plan.id = summary.latest_membership ->> 'planId'
$old$;
  v_new_join text := $new$
  left join source_plans plan on plan.id = summary.latest_membership ->> 'planId'
  left join payment_summaries payment_summary on payment_summary.member_id = pc.m ->> 'id'
$new$;
begin
  v_definition := pg_get_functiondef(
    'public.platform_list_member_migration_members(uuid,uuid,text,integer,integer)'::regprocedure
  );

  if position('linked_payment_count' in v_definition) > 0
     and position('linked_payment_total' in v_definition) > 0
     and position('payment_currency' in v_definition) > 0 then
    return;
  end if;

  if position(v_old_payment_cte in v_definition) = 0
     or position(v_old_fields in v_definition) = 0
     or position(v_old_join in v_definition) = 0 then
    raise exception 'Member migration preview changed; refusing to add payment totals to an unverified function.';
  end if;

  v_definition := replace(v_definition, v_old_payment_cte, v_new_payment_cte);
  v_definition := replace(v_definition, v_old_fields, v_new_fields);
  v_definition := replace(v_definition, v_old_join, v_new_join);
  execute v_definition;
end;
$$;
