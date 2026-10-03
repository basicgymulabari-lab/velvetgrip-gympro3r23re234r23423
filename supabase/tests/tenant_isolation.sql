-- Run against an isolated local Supabase database after all migrations:
--   supabase test db
-- This test is intentionally destructive inside its transaction and rolls back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at
) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@example.com', '', now(), now(), now()),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@example.com', '', now(), now(), now()),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-a@example.com', '', now(), now(), now()),
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member-a@example.com', '', now(), now(), now());

insert into public.gyms (id, owner_user_id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000001', 'Gym A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '20000000-0000-0000-0000-000000000002', 'Gym B');

insert into public.gym_users (gym_id, user_id, role, display_name, email, permissions) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000001', 'owner', 'Owner A', 'owner-a@example.com', '{}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '20000000-0000-0000-0000-000000000002', 'owner', 'Owner B', 'owner-b@example.com', '{}'),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '30000000-0000-0000-0000-000000000003',
    'receptionist',
    'Staff A',
    'staff-a@example.com',
    '{"dashboard":true,"members":true,"memberships":true,"payments":true,"products":true,"viewProductCost":false,"expenses":false,"reports":false,"inquiries":true,"notifications":true,"trash":false,"viewRevenue":false}'
  );

select throws_ok(
  $$insert into public.gym_users (gym_id, user_id, role, display_name, email)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '40000000-0000-0000-0000-000000000004', 'member', 'Member A', 'member-a@example.com')$$,
  '23514',
  null,
  'managed gym members cannot self-create a management-console role'
);

insert into public.gym_workspaces (owner_id, gym_id, revision, state) values
  (
    '10000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    '{"version":1,"auth":{"email":"","passwordHash":""},"staff":{},"settings":{"gymName":"Gym A","adminName":"Owner A"},"members":[],"plans":[],"memberships":[],"payments":[],"products":[{"id":"product-a","name":"A Protein","cost":100,"price":200,"stock":5}],"sales":[],"activities":[],"expenses":[{"id":"expense-a","title":"Rent A","amount":500}],"inquiries":[],"readNotifications":[],"invoiceSeq":0}'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    1,
    '{"version":1,"auth":{"email":"","passwordHash":""},"staff":{},"settings":{"gymName":"Gym B","adminName":"Owner B"},"members":[],"plans":[],"memberships":[],"payments":[],"products":[{"id":"product-b","name":"B Protein","cost":999,"price":1200,"stock":7}],"sales":[],"activities":[],"expenses":[{"id":"expense-b","title":"Rent B","amount":900}],"inquiries":[],"readNotifications":[],"invoiceSeq":0}'
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select is(public.iv_current_gym_id(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'owner A resolves only to Gym A');
select is(public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName', 'Gym A', 'owner A loads Gym A');
select isnt(public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName', 'Gym B', 'owner A never loads Gym B');
select ok(
  public.iv_can_access_private_object('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/members/photo.jpg'),
  'owner A can resolve private files inside Gym A'
);
select ok(
  not public.iv_can_access_private_object('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/members/photo.jpg'),
  'owner A cannot resolve Gym B private files'
);
select throws_ok(
  'select state from public.gym_workspaces',
  '42501',
  'permission denied for table gym_workspaces',
  'raw workspace table is not client-readable'
);
select throws_ok(
  'select * from public.billing_operations',
  '42501',
  'permission denied for table billing_operations',
  'raw idempotency records are not client-readable'
);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select is(public.iv_current_gym_id(), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'owner B resolves only to Gym B');
select is(public.load_current_gym_workspace() -> 'state' -> 'settings' ->> 'gymName', 'Gym B', 'owner B loads Gym B');

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', true);
select is(public.iv_current_gym_id(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Gym A receptionist resolves to Gym A');
select is(
  (public.load_current_gym_workspace() -> 'state' -> 'products' -> 0 ->> 'cost')::numeric,
  0::numeric,
  'receptionist without cost permission never receives product cost'
);
select is(
  jsonb_array_length(public.load_current_gym_workspace() -> 'state' -> 'expenses'),
  0,
  'receptionist without expense permission never receives expenses'
);
select ok(
  public.iv_can_access_private_object('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/members/photo.jpg'),
  'receptionist with member permission can resolve Gym A member photos'
);
select ok(
  not public.iv_can_access_private_object('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/expenses/receipt.pdf'),
  'receptionist without expense permission cannot resolve private receipts'
);

-- Try to tamper with both an allowed product field and a forbidden expense.
with loaded as (
  select public.load_current_gym_workspace() payload
), attempted as (
  select
    jsonb_set(
      jsonb_set(payload -> 'state', '{products,0,name}', '"Updated by Staff"'::jsonb, false),
      '{expenses}',
      '[{"id":"evil","title":"Tampered","amount":1}]'::jsonb,
      true
    ) as proposed,
    (payload ->> 'revision')::bigint as revision
  from loaded
)
select public.save_current_gym_workspace(proposed, revision) from attempted;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select is(
  public.load_current_gym_workspace() -> 'state' -> 'products' -> 0 ->> 'name',
  'Updated by Staff',
  'delegated product edit is persisted'
);
select is(
  public.load_current_gym_workspace() -> 'state' -> 'expenses' -> 0 ->> 'title',
  'Rent A',
  'forbidden expense tampering is discarded server-side'
);
select is(
  (public.load_current_gym_workspace() -> 'state' -> 'products' -> 0 ->> 'cost')::numeric,
  100::numeric,
  'masked product cost cannot be overwritten by receptionist save'
);

select throws_ok(
  $$select public.iv_validate_private_asset_references(
    '{"version":1,"members":[{"id":"m1","photo":"data:image/png;base64,AAAA"}],"expenses":[]}'::jsonb
  )$$,
  'P0001',
  'INLINE_MEMBER_PHOTO_FORBIDDEN',
  'inline member photos are rejected from persisted cloud workspaces'
);
select throws_ok(
  $$select public.iv_validate_private_asset_references(
    '{"version":1,"members":[],"expenses":[{"id":"e1","attachment":{"dataUrl":"data:application/pdf;base64,AAAA"}}]}'::jsonb
  )$$,
  'P0001',
  'INLINE_EXPENSE_ATTACHMENT_FORBIDDEN',
  'inline expense documents are rejected from persisted cloud workspaces'
);

select * from finish();
rollback;
