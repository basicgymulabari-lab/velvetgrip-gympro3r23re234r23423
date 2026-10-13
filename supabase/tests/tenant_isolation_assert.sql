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

insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions)
values (
  'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '54000000-0000-0000-0000-000000000004',
  'receptionist',
  'Staff Without Member Access',
  'qa-member-a@example.com',
  '{"members":false}'
);

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
    '{"version":1,"auth":{"email":"","passwordHash":""},"staff":{},"settings":{"gymName":"QA Gym B","adminName":"Owner B"},"members":[{"id":"attendance-member-b","type":"member","name":"Attendance Member B","phone":"9800000000","email":"","deletedAt":null}],"plans":[],"memberships":[],"payments":[],"products":[{"id":"product-b","name":"B Protein","cost":999,"price":1200,"stock":7}],"sales":[],"activities":[],"expenses":[{"id":"expense-b","title":"Rent B","amount":900}],"inquiries":[],"readNotifications":[],"invoiceSeq":0}'
  );

insert into public.subscription_entitlements (
  owner_id, gym_id, status, source, manual_period_end, current_period_end
) values (
  '51000000-0000-0000-0000-000000000001',
  'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'active', 'manual', now() + interval '30 days', now() + interval '30 days'
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
  if public.get_current_gym_context() ->> 'subscription_status' <> 'active' then
    raise exception 'owner A did not resolve its gym Pro entitlement';
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

-- The Settings template action replaces business arrays through the same
-- revision-checked workspace RPC. Exercise a realistic starter dataset and
-- read it back from the server before continuing the tenant/RLS checks.
do $$
declare
  v_loaded jsonb := public.load_current_gym_workspace();
  v_state jsonb := v_loaded -> 'state';
  v_template jsonb;
  v_members jsonb;
  v_memberships jsonb;
  v_payments jsonb;
  v_result jsonb;
  v_reloaded jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'id', format('template-member-%s', person.ordinality),
    'type', 'member',
    'name', person.name,
    'email', format('template-member-%s@example.invalid', person.ordinality),
    'phone', '9800000' || lpad(person.ordinality::text, 3, '0'),
    'gender', case when person.ordinality % 2 = 0 then 'female' else 'male' end,
    'dob', '1995-01-02',
    'address', 'Kathmandu',
    'joinDate', current_date::text,
    'emergencyContact', '',
    'notes', '[]'::jsonb,
    'measurements', '[]'::jsonb,
    'deletedAt', null
  ) order by person.ordinality)
  into v_members
  from unnest(array[
    'Aarati Karki', 'Suman Thapa', 'Nabin Oli', 'Sagar Rai', 'Riya Sharma',
    'Prabin Gurung', 'Anisha Tamang', 'Bikash Shrestha', 'Mina Adhikari', 'Roshan Lama'
  ]) with ordinality as person(name, ordinality);

  select jsonb_agg(jsonb_build_object(
    'id', format('template-membership-%s', member.ordinality),
    'memberId', format('template-member-%s', member.ordinality),
    'planId', case when member.ordinality % 2 = 0 then 'template-plan-quarterly' else 'template-plan-monthly' end,
    'startDate', current_date::text,
    'endDate', (current_date + 29)::text,
    'price', case when member.ordinality % 2 = 0 then 4000 else 1500 end,
    'discount', 0,
    'joiningFee', 0,
    'frozen', false,
    'createdAt', now()
  ) order by member.ordinality)
  into v_memberships
  from generate_series(1, 10) as member(ordinality);

  select jsonb_agg(jsonb_build_object(
    'id', format('template-payment-%s', member.ordinality),
    'invoiceNo', format('QA-STARTER-%s', member.ordinality),
    'memberId', format('template-member-%s', member.ordinality),
    'membershipId', format('template-membership-%s', member.ordinality),
    'kind', 'membership',
    'amount', 300,
    'method', 'cash',
    'date', now(),
    'note', 'QA starter dataset'
  ) order by member.ordinality)
  into v_payments
  from generate_series(1, 10) as member(ordinality);

  v_template := v_state || jsonb_build_object(
    'members', v_members,
    'plans', jsonb_build_array(
      jsonb_build_object('id', 'template-plan-monthly', 'name', 'Monthly Strength', 'price', 1500, 'joiningFee', 1000, 'durationDays', 30, 'description', 'Starter plan', 'active', true),
      jsonb_build_object('id', 'template-plan-quarterly', 'name', 'Quarterly Power', 'price', 4000, 'joiningFee', 1000, 'durationDays', 90, 'description', 'Starter plan', 'active', true)
    ),
    'memberships', v_memberships,
    'payments', v_payments,
    'products', jsonb_build_array(jsonb_build_object('id', 'template-product', 'name', 'Protein Shaker', 'category', 'Accessories', 'sku', 'QA-001', 'cost', 180, 'price', 450, 'stock', 20, 'lowStockAt', 4, 'createdAt', now())),
    'sales', jsonb_build_array(jsonb_build_object('id', 'template-sale', 'invoiceNo', 'QA-SALE-1', 'productId', 'template-product', 'productName', 'Protein Shaker', 'qty', 1, 'unitPrice', 450, 'unitCost', 180, 'discount', 0, 'total', 450, 'paid', 450, 'buyer', 'Aarati Karki', 'memberId', 'template-member-1', 'date', now())),
    'expenses', jsonb_build_array(jsonb_build_object('id', 'template-expense', 'title', 'Utilities', 'amount', 1000)),
    'invoiceSeq', 1
  );

  v_result := public.save_current_gym_workspace(v_template, (v_loaded ->> 'revision')::bigint);
  v_reloaded := public.load_current_gym_workspace() -> 'state';

  if jsonb_array_length(v_reloaded -> 'members') <> 10
    or jsonb_array_length(v_reloaded -> 'plans') <> 2
    or jsonb_array_length(v_reloaded -> 'memberships') <> 10
    or jsonb_array_length(v_reloaded -> 'payments') <> 10
    or jsonb_array_length(v_reloaded -> 'products') <> 1
    or jsonb_array_length(v_reloaded -> 'sales') <> 1
    or jsonb_array_length(v_reloaded -> 'expenses') <> 1
    or v_reloaded -> 'settings' ->> 'gymName' <> 'QA Gym A'
    or (v_result ->> 'revision')::bigint <= (v_loaded ->> 'revision')::bigint then
    raise exception 'template workspace did not persist intact across server reload';
  end if;
end;
$$;

-- Attendance is gym-scoped, idempotent per member/day, and written only
-- through the permission-checked RPC (not direct client table inserts).
select public.record_current_member_attendance('template-member-1', current_date);
do $$
declare
  v_result jsonb;
begin
  v_result := public.record_current_member_attendance('template-member-1', current_date);
  if v_result ->> 'status' <> 'already_checked_in' then
    raise exception 'duplicate attendance check-in was not idempotent';
  end if;
  if (select count(*) from public.gym_member_attendance where gym_id = 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid and member_id = 'template-member-1' and attendance_date = current_date) <> 1 then
    raise exception 'member attendance did not persist exactly once';
  end if;
  begin
    insert into public.gym_member_attendance (gym_id, member_id, attendance_date)
    values ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'template-member-2', current_date);
    raise exception 'direct attendance table insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
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
  if public.get_current_gym_context() ->> 'subscription_status' <> 'free'
      or public.get_current_gym_context() ->> 'subscription_source' is not null
      or public.get_current_gym_context() ->> 'subscription_current_period_end' is not null then
    raise exception 'owner B received Gym A subscription details';
  end if;
  if public.record_current_member_attendance('attendance-member-b', current_date) ->> 'status' <> 'checked_in' then
    raise exception 'Gym B owner could not check in its own member';
  end if;
  if exists (select 1 from public.gym_member_attendance where gym_id = 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) then
    raise exception 'Gym B can read Gym A attendance';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '53000000-0000-0000-0000-000000000003', true);
do $$
declare
  v_payload jsonb := public.load_current_gym_workspace();
  v_context jsonb := public.get_current_gym_context();
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
  if exists (select 1 from public.subscription_entitlements) then
    raise exception 'receptionist can read the protected billing row directly';
  end if;
  if v_context ->> 'subscription_status' <> 'active'
      or v_context ->> 'subscription_source' <> 'manual'
      or (v_context ->> 'subscription_current_period_end')::timestamptz <= now() then
    raise exception 'receptionist did not resolve the gym Pro entitlement summary';
  end if;
  if not exists (
    select 1 from public.gym_member_attendance
    where gym_id = 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
      and member_id = 'template-member-1'
      and attendance_date = current_date
  ) then
    raise exception 'receptionist with members permission cannot read attendance';
  end if;
  if public.record_current_member_attendance('template-member-2', current_date) ->> 'status' <> 'checked_in' then
    raise exception 'receptionist with members permission cannot record attendance';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '54000000-0000-0000-0000-000000000004', true);
do $$
begin
  if exists (
    select 1 from public.gym_member_attendance
    where gym_id = 'caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
  ) then
    raise exception 'receptionist without members permission can read attendance';
  end if;
  begin
    perform public.record_current_member_attendance('template-member-3', current_date);
    raise exception 'receptionist without members permission recorded attendance';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ATTENDANCE_FORBIDDEN' then raise; end if;
  end;
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
  if (v_state -> 'products' -> 0 ->> 'cost')::numeric <> 180 then
    raise exception 'receptionist overwrote owner-only product cost';
  end if;
  if jsonb_array_length(v_state -> 'expenses') <> 1
     or v_state -> 'expenses' -> 0 ->> 'title' <> 'Utilities' then
    raise exception 'receptionist tampered with owner-only expenses';
  end if;
  if jsonb_array_length(v_state -> 'sales') <> 1
     or (v_state -> 'sales' -> 0 ->> 'unitCost')::numeric <> 180
     or (v_state -> 'sales' -> 0 ->> 'total')::numeric <> 450
     or v_state -> 'sales' -> 0 ->> 'invoiceNo' <> 'QA-SALE-1' then
    raise exception 'receptionist product save changed historical sale details';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '53000000-0000-0000-0000-000000000003', true);
do $$
declare
  v_payload jsonb := public.load_current_gym_workspace();
  v_tampered jsonb;
begin
  v_tampered := jsonb_set(v_payload -> 'state', '{sales,0,total}', '1'::jsonb, false);
  begin
    perform public.save_current_gym_workspace(v_tampered, (v_payload ->> 'revision')::bigint);
    raise exception 'SALE_TAMPER_ACCEPTED';
  exception
    when raise_exception then
      if sqlerrm <> 'SALE_HISTORY_IMMUTABLE' then raise; end if;
  end;
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
