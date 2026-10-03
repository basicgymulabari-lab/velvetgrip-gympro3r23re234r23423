-- Production storage and provider-webhook hardening for IronVault.
-- Private objects are tenant-prefixed: <gym_uuid>/<members|expenses>/<opaque filename>.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ironvault-private',
  'ironvault-private',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.iv_can_access_private_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.gym_users membership
    where membership.user_id = auth.uid()
      and membership.enabled
      and membership.gym_id::text = split_part(p_name, '/', 1)
      and (
        membership.role = 'owner'
        or (
          membership.role = 'receptionist'
          and (
            (split_part(p_name, '/', 2) = 'members' and public.iv_has_permission(membership.permissions, 'members'))
            or
            (split_part(p_name, '/', 2) = 'expenses' and public.iv_has_permission(membership.permissions, 'expenses'))
          )
        )
      )
  )
$$;

revoke all on function public.iv_can_access_private_object(text) from public, anon;
grant execute on function public.iv_can_access_private_object(text) to authenticated;

drop policy if exists "IronVault private objects read" on storage.objects;
create policy "IronVault private objects read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ironvault-private'
    and public.iv_can_access_private_object(name)
  );

drop policy if exists "IronVault private objects insert" on storage.objects;
create policy "IronVault private objects insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ironvault-private'
    and public.iv_can_access_private_object(name)
  );

drop policy if exists "IronVault private objects update" on storage.objects;
create policy "IronVault private objects update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'ironvault-private'
    and public.iv_can_access_private_object(name)
  )
  with check (
    bucket_id = 'ironvault-private'
    and public.iv_can_access_private_object(name)
  );

drop policy if exists "IronVault private objects delete" on storage.objects;
create policy "IronVault private objects delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'ironvault-private'
    and public.iv_can_access_private_object(name)
  );

create table if not exists public.billing_operations (
  idempotency_key uuid primary key,
  gym_id uuid not null references public.gyms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('stripe','razorpay')),
  operation text not null check (operation in ('checkout','verify')),
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists billing_operations_gym_created_idx
  on public.billing_operations (gym_id, created_at desc);
alter table public.billing_operations enable row level security;
revoke all on public.billing_operations from anon, authenticated;

create table if not exists public.billing_webhook_events (
  provider text not null check (provider in ('stripe','razorpay')),
  event_key text not null,
  event_type text,
  payload_sha256 text not null,
  status text not null default 'processing' check (status in ('processing','processed','failed')),
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_key)
);
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from anon, authenticated;

create table if not exists public.billing_transactions (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('stripe','razorpay')),
  provider_payment_id text not null,
  provider_subscription_id text,
  provider_refund_id text not null default '',
  kind text not null default 'subscription' check (kind in ('subscription','refund')),
  status text not null check (status in ('pending','authorized','paid','failed','refunded','partially_refunded')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'inr' check (currency ~ '^[a-z]{3}$'),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id, kind, provider_refund_id)
);
create index if not exists billing_transactions_gym_occurred_idx
  on public.billing_transactions (gym_id, occurred_at desc);
create index if not exists billing_transactions_subscription_idx
  on public.billing_transactions (provider, provider_subscription_id)
  where provider_subscription_id is not null;
alter table public.billing_transactions enable row level security;

drop policy if exists "Owners can read gym billing transactions" on public.billing_transactions;
create policy "Owners can read gym billing transactions"
  on public.billing_transactions for select to authenticated
  using (gym_id = public.iv_current_gym_id() and public.iv_is_current_gym_owner());

revoke insert, update, delete on public.billing_transactions from anon, authenticated;

drop trigger if exists set_billing_transactions_updated_at on public.billing_transactions;
create trigger set_billing_transactions_updated_at
before update on public.billing_transactions
for each row execute function public.set_updated_at();

-- Keep client audit RPC tightly allow-listed while permitting new storage events.
create or replace function public.record_audit_event(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.gym_users%rowtype;
begin
  select * into v_membership
  from public.gym_users
  where user_id = auth.uid() and enabled
  limit 1;
  if not found then raise exception 'GYM_MEMBERSHIP_REQUIRED'; end if;
  if p_action not in (
    'login', 'logout', 'settings_updated', 'backup_restored', 'staff_updated',
    'member_created', 'member_updated', 'member_deleted', 'payment_created',
    'membership_renewed', 'product_sold', 'expense_created', 'expense_updated',
    'inquiry_updated', 'storage_uploaded', 'storage_deleted'
  ) then raise exception 'INVALID_AUDIT_ACTION'; end if;
  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id, metadata)
  values (
    v_membership.gym_id,
    auth.uid(),
    v_membership.role,
    p_action,
    left(p_entity_type, 80),
    left(p_entity_id, 160),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

revoke execute on function public.consume_api_rate_limit(text, text, integer, integer) from anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;


create or replace function public.iv_validate_private_asset_references(p_state jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_state -> 'members', '[]'::jsonb)) member
    where coalesce(member ->> 'photo', '') like 'data:%'
       or coalesce(member ->> 'photo', '') like 'blob:%'
  ) then
    raise exception 'INLINE_MEMBER_PHOTO_FORBIDDEN';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_state -> 'expenses', '[]'::jsonb)) expense
    where coalesce(expense -> 'attachment' ->> 'dataUrl', '') <> ''
       or coalesce(expense -> 'attachment' ->> 'path', '') like 'data:%'
       or coalesce(expense -> 'attachment' ->> 'path', '') like 'blob:%'
  ) then
    raise exception 'INLINE_EXPENSE_ATTACHMENT_FORBIDDEN';
  end if;
end;
$$;

create or replace function public.iv_validate_private_assets_trigger()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.iv_validate_private_asset_references(new.state);
  return new;
end;
$$;

drop trigger if exists validate_gym_workspace_private_assets on public.gym_workspaces;
create trigger validate_gym_workspace_private_assets
before insert or update of state on public.gym_workspaces
for each row execute function public.iv_validate_private_assets_trigger();
