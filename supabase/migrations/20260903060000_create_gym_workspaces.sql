create table if not exists public.gym_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gym_workspaces enable row level security;

create policy "Owners can read their gym workspace"
  on public.gym_workspaces for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Owners can create their gym workspace"
  on public.gym_workspaces for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "Owners can update their gym workspace"
  on public.gym_workspaces for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "Owners can delete their gym workspace"
  on public.gym_workspaces for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_gym_workspaces_updated_at on public.gym_workspaces;
create trigger set_gym_workspaces_updated_at
before update on public.gym_workspaces
for each row execute function public.set_updated_at();
