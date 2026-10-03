-- Remote-safe tenant/RLS assertions. Everything is rolled back.
-- Run with:
--   supabase db query --linked --file supabase/tests/tenant_isolation_assert.sql

begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at
) values
  ('51000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-owner-a@example.com', '', now(), now(), now()),
  ('52000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-owner-b@example.com', '', now(), now(), now()),
  ('53000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-staff-a@example.com', '', now(), now(), now()),
  ('54000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-member-a@example.com', '', now(), now(), now());

insert into public.gyms (id, owner_user_id, name) values
  ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '51000000-0000-0000-0000-000000000001', 'QA Gym A'),
  ('cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '52000000-0000-0000-0000-000000000002', 'QA Gym B');

insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions) values
  ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '51000000-0000-0000-0000-000000000001', 'owner', 'Owner A', 'qa-owner-a@example.com', '{}'),
  ('cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '52000000-0000-0000-0000-000000000002', 'owner', 'Owner B', 'qa-owner-b@example.com', '{}'),
  (
    'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '53000000-0000-0000-0000-000000000003',
    'receptionist',
    'Staff A',
    'qa-staff-a@example.com',
    '{"dashboard":true,"members":true,"memberships":true,"payments":true,"products":true,"viewProductCost":false,"expenses":false,"reports":false,"inquiries":true,"notifications":true,"trash":false,"viewRevenue":false}'
  );

do $$
begin
  begin
    insert into public.gym_users (gym_id, user_id, role, display_name, email)
    values ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54000000-0000-0000-0000-000000000004', 'member', 'Member A', 'qa-member-a@example.com');
    raise exception 'member management role was accepted unexpectedly';
  exception
    when check_violation then null;
  end;
end;
$$;

insert into public.gym_workspaces (owner_id, gym_id, revision, state) values
  (
    '51000000-0000-0000-0000-000000000001',
    'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    '{"version":1,"auth":{"email":"","passwordHash":""},"staff":{},"settings":{"gymName":"QA Gym A","adminName":"Owner A"},"members":[],"plans":[],"memberships":[],"payments":[],"products":[{"id":"product-a","name":"A Protein","cost":100,"price":200,"stock":5}],"sales":[],"activities":[],"expenses":[{"id":"expense-a","title":"Rent A","amount":500}],"inquiries":[],"readNotifications":[],"invoiceSeq":0}'
  ),
  (
    '52000000-0000-0000-0000-000000000002',
    'cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    1,
    '{"version":1,"auth":{"email":"","passwordHash":""},"staff":{},"settings":{"gymName":"QA Gym B","adminName":"Owner B"},"members":[],"plans":[],"memberships":[],"payments":[],"products":[{"id":"product-b","name":"B Protein","cost":999,"price":1200,"stock":7}],"sales":[],"activities":[],"expenses":[{"id":"expense-b","title":"Rent B","amount":900}],"inquiries":[],"readNotifications":[],"invoiceSeq":0}'
  );

do $$
declare
  v_public boolean;
begin
  select public into v_public from storage.buckets where id = 'ironvault-private';
  if v_public is distinct from false then
    raise exception 'ironvault-private bucket must exist and remain private';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000001', true);

do $$
begin
  if public.iv_current_gym_id() <> 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid then
    raise exception 'owner A resolved to the wrong tenant';
  end if;
  if public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName' <> 'QA Gym A' then
    raise exception 'owner A did not load Gym A';
  end if;
  if public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName' = 'QA Gym B' then
    raise exception 'owner A loaded Gym B';
  end if;
  if not public.iv_can_access_private_object('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/members/photo.jpg') then
    raise exception 'owner A cannot resolve its own private member object';
  end if;
  if public.iv_can_access_private_object('cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/members/photo.jpg') then
    raise exception 'owner A can resolve Gym B private objects';
  end if;
  if has_table_privilege(current_user, 'public.gym_workspaces', 'SELECT') then
    raise exception 'authenticated role can read raw gym_workspaces';
  end if;
  if has_table_privilege(current_user, 'public.billing_operations', 'SELECT') then
    raise exception 'authenticated role can read internal billing idempotency records';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '52000000-0000-0000-0000-000000000002', true);
do $$
begin
  if public.iv_current_gym_id() <> 'cbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid then
    raise exception 'owner B resolved to the wrong tenant';
  end if;
  if public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName' <> 'QA Gym B' then
    raise exception 'owner B did not load Gym B';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '53000000-0000-0000-0000-000000000003', true);
do $$
declare
  v_payload jsonb := public.load_current_gym_workspace();
begin
  if public.iv_current_gym_id() <> 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid then
    raise exception 'receptionist resolved to the wrong tenant';
  end if;
  if (v_payload -> 'state' -> 'products' -> 0 ->> 'cost')::numeric <> 0 then
    raise exception 'receptionist received masked product cost';
  end if;
  if jsonb_array_length(v_payload -> 'state' -> 'expenses') <> 0 then
    raise exception 'receptionist received expenses without permission';
  end if;
  if not public.iv_can_access_private_object('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/members/photo.jpg') then
    raise exception 'receptionist with member permission cannot resolve member photo';
  end if;
  if public.iv_can_access_private_object('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/expenses/receipt.pdf') then
    raise exception 'receptionist without expense permission can resolve expense receipt';
  end if;
end;
$$;

with loaded as (
  select public.load_current_gym_workspace() payload
), attempted as (
  select
    jsonb_set(
      jsonb_set(
        jsonb_set(payload -> 'state', '{products,0,name}', '"Updated by Staff"'::jsonb, false),
        '{products,0,cost}',
        '999999'::jsonb,
        false
      ),
      '{expenses}',
      '[{"id":"evil","title":"Tampered","amount":1}]'::jsonb,
      true
    ) as proposed,
    (payload ->> 'revision')::bigint as revision
  from loaded
)
select public.save_current_gym_workspace(proposed, revision) from attempted;

select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000001', true);
do $$
declare
  v_state jsonb := public.load_current_gym_workspace() -> 'state';
begin
  if v_state -> 'products' -> 0 ->> 'name' <> 'Updated by Staff' then
    raise exception 'delegated product edit did not persist';
  end if;
  if (v_state -> 'products' -> 0 ->> 'cost')::numeric <> 100 then
    raise exception 'receptionist overwrote owner-only product cost';
  end if;
  if jsonb_array_length(v_state -> 'expenses') <> 1
     or v_state -> 'expenses' -> 0 ->> 'title' <> 'Rent A' then
    raise exception 'receptionist tampered with owner-only expenses';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.iv_validate_private_asset_references(
      '{"version":1,"members":[{"id":"m1","photo":"data:image/png;base64,AAAA"}],"expenses":[]}'::jsonb
    );
    raise exception 'inline member photo was accepted';
  exception
    when raise_exception then
      if sqlerrm <> 'INLINE_MEMBER_PHOTO_FORBIDDEN' then raise; end if;
  end;
  begin
    perform public.iv_validate_private_asset_references(
      '{"version":1,"members":[],"expenses":[{"id":"e1","attachment":{"dataUrl":"data:application/pdf;base64,AAAA"}}]}'::jsonb
    );
    raise exception 'inline expense attachment was accepted';
  exception
    when raise_exception then
      if sqlerrm <> 'INLINE_EXPENSE_ATTACHMENT_FORBIDDEN' then raise; end if;
  end;
end;
$$;

reset role;
rollback;

select 'tenant/RLS/storage assertions passed' as result;
