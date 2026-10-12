-- A receptionist without cost permission receives historical sale rows with
-- unitCost masked to zero. Compare the immutable record after excluding that
-- protected field; the write path below restores its authoritative value.
create or replace function public.save_current_gym_workspace(p_state jsonb, p_expected_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_membership public.gym_users%rowtype;
  v_workspace public.gym_workspaces%rowtype;
  v_next jsonb;
  v_products jsonb;
  v_sales jsonb;
  v_invoice_seq bigint;
  v_changed_keys jsonb;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'INVALID_WORKSPACE'; end if;

  select * into v_membership
  from public.gym_users
  where user_id = v_user
  limit 1;
  if not found then raise exception 'GYM_MEMBERSHIP_REQUIRED'; end if;
  if not v_membership.enabled then raise exception 'STAFF_DISABLED'; end if;

  select * into v_workspace
  from public.gym_workspaces
  where gym_id = v_membership.gym_id
  for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND'; end if;

  if p_expected_revision is null or p_expected_revision <> v_workspace.revision then
    raise exception 'WORKSPACE_CONFLICT';
  end if;

  if v_membership.role = 'owner' then
    v_next := p_state - 'auth' - 'staff';
    v_next := jsonb_set(v_next, '{auth}', '{"email":"","passwordHash":""}'::jsonb, true);
    v_next := jsonb_set(v_next, '{staff}', '{}'::jsonb, true);
  else
    -- Start from the authoritative server state and only replace areas the
    -- owner explicitly delegated. This prevents client-side privilege bypasses
    -- and prevents hidden fields from being zeroed by a filtered client copy.
    v_next := v_workspace.state;

    if public.iv_has_permission(v_membership.permissions, 'members') then
      v_next := jsonb_set(v_next, '{members}', coalesce(p_state -> 'members', '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'memberships') then
      v_next := jsonb_set(v_next, '{memberships}', coalesce(p_state -> 'memberships', '[]'::jsonb), true);
      v_next := jsonb_set(v_next, '{plans}', coalesce(p_state -> 'plans', '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'payments') then
      -- Receptionists may record new payments but cannot rewrite or remove
      -- financial history by crafting a workspace payload outside the UI.
      if exists (
        select 1
        from jsonb_array_elements(coalesce(v_workspace.state -> 'payments', '[]'::jsonb)) original
        where not exists (
          select 1
          from jsonb_array_elements(coalesce(p_state -> 'payments', '[]'::jsonb)) incoming
          where incoming ->> 'id' = original ->> 'id' and incoming = original
        )
      ) then
        raise exception 'PAYMENT_HISTORY_IMMUTABLE';
      end if;
      v_next := jsonb_set(v_next, '{payments}', coalesce(p_state -> 'payments', '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'products') then
      v_products := coalesce(p_state -> 'products', '[]'::jsonb);
      v_sales := coalesce(p_state -> 'sales', '[]'::jsonb);

      -- Existing sale history is immutable. A receptionist's read projection
      -- masks unitCost, so compare every other field and restore unitCost from
      -- the authoritative workspace before saving.
      if exists (
        select 1
        from jsonb_array_elements(coalesce(v_workspace.state -> 'sales', '[]'::jsonb)) original
        where not exists (
          select 1
          from jsonb_array_elements(v_sales) incoming
          where incoming ->> 'id' = original ->> 'id'
            and (
              incoming = original
              or (
                not public.iv_has_permission(v_membership.permissions, 'viewProductCost')
                and incoming - 'unitCost' = original - 'unitCost'
              )
            )
        )
      ) then
        raise exception 'SALE_HISTORY_IMMUTABLE';
      end if;

      if not public.iv_has_permission(v_membership.permissions, 'viewProductCost') then
        select coalesce(jsonb_agg(
          jsonb_set(
            incoming,
            '{cost}',
            coalesce(
              (select original -> 'cost'
               from jsonb_array_elements(coalesce(v_workspace.state -> 'products', '[]'::jsonb)) original
               where original ->> 'id' = incoming ->> 'id'
               limit 1),
              '0'::jsonb
            ),
            true
          )
        ), '[]'::jsonb)
        into v_products
        from jsonb_array_elements(v_products) incoming;

        select coalesce(jsonb_agg(
          jsonb_set(
            incoming,
            '{unitCost}',
            coalesce(
              (select original -> 'unitCost'
               from jsonb_array_elements(coalesce(v_workspace.state -> 'sales', '[]'::jsonb)) original
               where original ->> 'id' = incoming ->> 'id'
               limit 1),
              (select product -> 'cost'
               from jsonb_array_elements(coalesce(v_workspace.state -> 'products', '[]'::jsonb)) product
               where product ->> 'id' = incoming ->> 'productId'
               limit 1),
              '0'::jsonb
            ),
            true
          )
        ), '[]'::jsonb)
        into v_sales
        from jsonb_array_elements(v_sales) incoming;
      end if;

      v_next := jsonb_set(v_next, '{products}', coalesce(v_products, '[]'::jsonb), true);
      v_next := jsonb_set(v_next, '{sales}', coalesce(v_sales, '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'expenses') then
      v_next := jsonb_set(v_next, '{expenses}', coalesce(p_state -> 'expenses', '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'inquiries') then
      v_next := jsonb_set(v_next, '{inquiries}', coalesce(p_state -> 'inquiries', '[]'::jsonb), true);
    end if;
    if public.iv_has_permission(v_membership.permissions, 'notifications') then
      v_next := jsonb_set(v_next, '{readNotifications}', coalesce(p_state -> 'readNotifications', '[]'::jsonb), true);
    end if;

    if public.iv_has_permission(v_membership.permissions, 'members')
       or public.iv_has_permission(v_membership.permissions, 'memberships')
       or public.iv_has_permission(v_membership.permissions, 'payments')
       or public.iv_has_permission(v_membership.permissions, 'products')
       or public.iv_has_permission(v_membership.permissions, 'expenses')
       or public.iv_has_permission(v_membership.permissions, 'inquiries') then
      v_next := jsonb_set(v_next, '{activities}', coalesce(p_state -> 'activities', '[]'::jsonb), true);
    end if;

    -- Invoice numbers are shared by payments and product sales. They may only
    -- move forward and only by users allowed to create those records.
    if public.iv_has_permission(v_membership.permissions, 'payments')
       or public.iv_has_permission(v_membership.permissions, 'products') then
      v_invoice_seq := greatest(
        coalesce((v_workspace.state ->> 'invoiceSeq')::bigint, 0),
        coalesce((p_state ->> 'invoiceSeq')::bigint, 0)
      );
      v_next := jsonb_set(v_next, '{invoiceSeq}', to_jsonb(v_invoice_seq), true);
    end if;

    v_next := v_next - 'auth' - 'staff';
    v_next := jsonb_set(v_next, '{auth}', '{"email":"","passwordHash":""}'::jsonb, true);
    v_next := jsonb_set(v_next, '{staff}', '{}'::jsonb, true);
  end if;

  select coalesce(jsonb_agg(changed.key), '[]'::jsonb)
  into v_changed_keys
  from (
    select entry.key
    from jsonb_object_keys(v_next) as entry(key)
    where (v_workspace.state -> entry.key) is distinct from (v_next -> entry.key)
  ) changed;

  update public.gym_workspaces
  set state = v_next,
      revision = revision + 1,
      updated_at = now()
  where id = v_workspace.id
  returning revision into v_workspace.revision;

  update public.gyms
  set name = coalesce(nullif(trim(v_next -> 'settings' ->> 'gymName'), ''), name),
      updated_at = now()
  where id = v_membership.gym_id
    and v_membership.role = 'owner';

  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
  values (
    v_membership.gym_id,
    v_user,
    v_membership.role,
    'workspace_updated',
    'workspace',
    v_workspace.id::text,
    jsonb_build_object('changed_keys', v_changed_keys, 'revision', v_workspace.revision)
  );

  return jsonb_build_object('revision', v_workspace.revision, 'updated_at', now());
end;
$$;
