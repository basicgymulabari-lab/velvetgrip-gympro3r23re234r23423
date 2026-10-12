-- Extend CEO member migration to include the full source plan catalog and every
-- membership term. This patches the established, admin-checked transactional RPC
-- in place so its locking, idempotency, capacity enforcement and audit remain.
do $$
declare
  v_definition text;
  v_old_declarations text := $old$
  v_payment jsonb; v_new_payment jsonb; v_payment_id text; v_invoice_no text; v_invoice_seq integer;
  v_invoice_prefix text; v_status text; v_message text; v_row_number integer;
  v_duplicate boolean; v_moved integer := 0; v_skipped integer := 0; v_failed integer := 0;
  v_total integer; v_success integer; v_operation_status text; v_config jsonb;
  v_source_timezone text; v_source_today date;
$old$;
  v_new_declarations text := $new$
  v_payment jsonb; v_new_payment jsonb; v_payment_id text; v_invoice_no text; v_invoice_seq integer;
  v_invoice_prefix text; v_status text; v_message text; v_row_number integer;
  v_duplicate boolean; v_moved integer := 0; v_skipped integer := 0; v_failed integer := 0;
  v_total integer; v_success integer; v_operation_status text; v_config jsonb;
  v_source_timezone text; v_source_today date;
  v_source_plans jsonb; v_destination_plans jsonb; v_plan_source jsonb; v_plan_target jsonb;
  v_plan_mapping_resolved jsonb; v_membership jsonb; v_member_membership_ids text[];
  v_membership_count integer; v_moved_payment_count integer;
$new$;
  v_old_arrays text := $old$
  v_source_memberships := coalesce(v_source_state -> 'memberships', '[]'::jsonb);
  v_source_payments := coalesce(v_source_state -> 'payments', '[]'::jsonb);
  v_destination_members := coalesce(v_destination_state -> 'members', '[]'::jsonb);
$old$;
  v_new_arrays text := $new$
  v_source_memberships := coalesce(v_source_state -> 'memberships', '[]'::jsonb);
  v_source_payments := coalesce(v_source_state -> 'payments', '[]'::jsonb);
  v_source_plans := coalesce(v_source_state -> 'plans', '[]'::jsonb);
  v_destination_plans := coalesce(v_destination_state -> 'plans', '[]'::jsonb);
  v_destination_members := coalesce(v_destination_state -> 'members', '[]'::jsonb);
$new$;
  v_core_start text := $mark$          select item.value into v_current from jsonb_array_elements(v_source_memberships) with ordinality item(value, ordinality)$mark$;
  v_core_end text := $mark$            -- Keep the source row recoverable in Trash. Retain older terms,$mark$;
  v_core_replacement text := $replacement$
          -- Validate explicit mappings, then automatically reuse an identical
          -- destination plan or clone the source plan. This covers the entire
          -- catalog, including inactive plans needed by historical terms.
          v_message := '';
          if exists (
            select 1 from jsonb_each_text(coalesce(p_plan_mapping, '{}'::jsonb)) mapping
            where not exists (select 1 from jsonb_array_elements(v_destination_plans) plan
              where plan ->> 'id' = mapping.value)
          ) then
            v_message := 'A selected destination plan is no longer available. Refresh and try again.';
          elsif exists (
            select 1 from jsonb_array_elements(v_source_memberships) membership
            where membership ->> 'memberId' = v_member_id
              and not exists (select 1 from jsonb_array_elements(v_source_plans) plan
                where plan ->> 'id' = membership ->> 'planId')
          ) then
            v_message := 'A source membership refers to a missing source plan; no records were transferred.';
          elsif exists (
            select 1 from jsonb_array_elements(v_source_plans) plan
            where nullif(plan ->> 'id', '') is null
          ) then
            v_message := 'A source plan is missing its identifier; no records were transferred.';
          end if;

          if v_message = '' then
            v_plan_mapping_resolved := '{}'::jsonb;
            for v_plan_source in select plan.value from jsonb_array_elements(v_source_plans) as plan(value) loop
              v_plan_id := v_plan_source ->> 'id';
              if nullif(v_plan_id, '') is null then
                v_message := 'A source plan is missing its identifier; no records were transferred.';
                exit;
              end if;
              v_new_plan_id := p_plan_mapping ->> v_plan_id;
              if v_new_plan_id is null then
                select candidate.value ->> 'id' into v_new_plan_id
                  from jsonb_array_elements(v_destination_plans) with ordinality candidate(value, ordinality)
                  where candidate.value - 'id' = v_plan_source - 'id'
                  order by candidate.ordinality limit 1;
              end if;
              if v_new_plan_id is null then
                v_new_plan_id := gen_random_uuid()::text;
                v_plan_target := jsonb_set(v_plan_source, '{id}', to_jsonb(v_new_plan_id), true);
                v_destination_plans := v_destination_plans || jsonb_build_array(v_plan_target);
              end if;
              v_plan_mapping_resolved := jsonb_set(v_plan_mapping_resolved, array[v_plan_id],
                to_jsonb(v_new_plan_id), true);
            end loop;
          end if;

          if v_message = '' then
            v_new_member_id := gen_random_uuid()::text;
            v_new_member := jsonb_set(v_member - 'photo' - 'deletedAt' - 'deletedBy', '{id}', to_jsonb(v_new_member_id), true);
            v_new_member := jsonb_set(v_new_member, '{photo}', 'null'::jsonb, true);
            v_destination_members := v_destination_members || jsonb_build_array(v_new_member);

            v_member_membership_ids := '{}'::text[];
            v_membership_count := 0;
            v_moved_payment_count := 0;
            for v_membership in
              select membership.value from jsonb_array_elements(v_source_memberships) as membership(value)
              where membership.value ->> 'memberId' = v_member_id
              order by membership.value ->> 'createdAt', membership.value ->> 'id'
            loop
              v_plan_id := v_membership ->> 'planId';
              v_new_plan_id := v_plan_mapping_resolved ->> v_plan_id;
              if v_new_plan_id is null then
                raise exception 'SOURCE_MEMBERSHIP_PLAN_MAPPING_FAILED';
              end if;
              v_new_membership_id := gen_random_uuid()::text;
              v_copy_membership := jsonb_set(v_membership, '{id}', to_jsonb(v_new_membership_id), true);
              v_copy_membership := jsonb_set(v_copy_membership, '{memberId}', to_jsonb(v_new_member_id), true);
              v_copy_membership := jsonb_set(v_copy_membership, '{planId}', to_jsonb(v_new_plan_id), true);
              v_destination_memberships := v_destination_memberships || jsonb_build_array(v_copy_membership);
              v_member_membership_ids := array_append(v_member_membership_ids, v_membership ->> 'id');
              v_membership_count := v_membership_count + 1;

              if coalesce(p_transfer_active_payments, true) then
                for v_payment in select payment.value from jsonb_array_elements(v_source_payments) as payment(value)
                  where payment.value ->> 'membershipId' = v_membership ->> 'id'
                  order by payment.value ->> 'date', payment.value ->> 'id'
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
                  v_moved_payment_count := v_moved_payment_count + 1;
                end loop;
              end if;
            end loop;
          end if;
          if v_message = '' then
            -- The original source profile remains recoverable in Trash; all
            -- membership terms are handled with the payment policy below.
$replacement$;
  v_old_source_membership_move text := $old$
            if v_current is not null and coalesce(p_transfer_active_payments, true) then
              v_source_memberships := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_memberships) with ordinality rows(value, ordinality)
                where value ->> 'id' <> (v_current ->> 'id'));
              v_source_payments := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_payments) with ordinality rows(value, ordinality)
                where value ->> 'membershipId' <> (v_current ->> 'id'));
            end if;
$old$;
  v_new_source_membership_move text := $new$
            -- When linked payment movement is approved, move every membership
            -- term and its linked payments. Otherwise the original history and
            -- payment relationships remain together in the source Trash copy.
            if coalesce(p_transfer_active_payments, true) and cardinality(v_member_membership_ids) > 0 then
              v_source_memberships := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_memberships) with ordinality rows(value, ordinality)
                where not (value ->> 'id' = any(v_member_membership_ids)));
              v_source_payments := (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
                from jsonb_array_elements(v_source_payments) with ordinality rows(value, ordinality)
                where not (value ->> 'membershipId' = any(v_member_membership_ids)));
            end if;
$new$;
  v_old_message text := $old$
            v_status := 'transferred'; v_message := case when v_current is null
              then 'Profile transferred; no active membership was present.'
              when coalesce(p_transfer_active_payments, true)
              then 'Profile, active membership and linked payments transferred. Other history remains at source.'
              else 'Profile and membership copied. Linked payments remain at source; destination shows the outstanding balance.' end;
$old$;
  v_new_message text := $new$
            v_status := 'transferred'; v_message := case
              when coalesce(p_transfer_active_payments, true) then
                'Profile, ' || v_membership_count || ' membership term(s), full plan catalog and ' ||
                  v_moved_payment_count || ' linked payment(s) transferred. Source profile is retained in Trash.'
              else
                'Profile, ' || v_membership_count || ' membership term(s) and full plan catalog copied. Linked payments remain with the source history.'
              end;
$new$;
  v_old_next_destination text := $old$
  v_next_destination := jsonb_set(jsonb_set(jsonb_set(v_destination_state, '{members}', v_destination_members, true),
    '{memberships}', v_destination_memberships, true), '{payments}', v_destination_payments, true);
$old$;
  v_new_next_destination text := $new$
  v_next_destination := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_destination_state, '{members}', v_destination_members, true),
    '{plans}', v_destination_plans, true), '{memberships}', v_destination_memberships, true),
    '{payments}', v_destination_payments, true);
$new$;
  v_old_audit text := $old$
      'active_membership_payments_moved', coalesce(p_transfer_active_payments, true))); end if;
$old$;
  v_new_audit text := $new$
      'membership_history_and_linked_payments_moved', coalesce(p_transfer_active_payments, true))); end if;
$new$;
begin
  v_definition := pg_get_functiondef(
    'public.platform_transfer_members(uuid,uuid,uuid,text[],integer,text[],jsonb,boolean,text[],boolean)'::regprocedure
  );
  if position('full plan catalog and ' in v_definition) > 0 then return; end if;
  if position(v_old_declarations in v_definition) = 0
     or position(v_old_arrays in v_definition) = 0
     or position(v_old_source_membership_move in v_definition) = 0
     or position(v_old_message in v_definition) = 0
     or position(v_old_next_destination in v_definition) = 0
     or position(v_old_audit in v_definition) = 0 then
    raise exception 'Member migration transfer function changed; refusing to apply the full-history patch.';
  end if;

  v_definition := replace(v_definition, v_old_declarations, v_new_declarations);
  v_definition := replace(v_definition, v_old_arrays, v_new_arrays);
  if position(v_core_start in v_definition) = 0 or position(v_core_end in v_definition) = 0 then
    raise exception 'Member migration core changed; refusing to replace unverified transfer logic.';
  end if;
  v_definition := overlay(v_definition placing v_core_replacement
    from position(v_core_start in v_definition)
    for position(v_core_end in v_definition) - position(v_core_start in v_definition));
  v_definition := replace(v_definition, v_old_source_membership_move, v_new_source_membership_move);
  v_definition := replace(v_definition, v_old_message, v_new_message);
  v_definition := replace(v_definition, v_old_next_destination, v_new_next_destination);
  v_definition := replace(v_definition, v_old_audit, v_new_audit);
  execute v_definition;
end;
$$;

-- Enrich the existing latest-term preview with full-history counts. Keeping the
-- return signature stable avoids breaking deployed CEO clients.
do $$
declare
  v_definition text;
  v_old text := $old$
      'price', a.membership -> 'price'
$old$;
  v_new text := $new$
      'price', a.membership -> 'price',
      'membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) membership
        where membership ->> 'memberId' = a.m ->> 'id'),
      'active_membership_count', (select count(*)::integer from jsonb_array_elements(coalesce(v_source -> 'memberships', '[]'::jsonb)) membership
        where membership ->> 'memberId' = a.m ->> 'id'
          and not coalesce((membership ->> 'frozen')::boolean, false)
          and timezone(v_source_timezone, (membership ->> 'endDate')::timestamptz)::date >= v_source_today)
$new$;
begin
  v_definition := pg_get_functiondef(
    'public.platform_list_member_migration_members(uuid,uuid,text,integer,integer)'::regprocedure
  );
  if position('membership_count' in v_definition) > 0 then return; end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'Member migration preview changed; refusing to apply the history count patch.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$$;
