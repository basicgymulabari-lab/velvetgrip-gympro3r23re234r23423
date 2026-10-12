-- Make an idempotent "already transferred" result actionable for the CEO.
-- This is deliberately limited to the protected migration-history RPC; it
-- does not expose customer records to gym users or duplicate any profile data.

create or replace function public.platform_list_member_migration_items(p_operation_id uuid)
returns table (
  row_number integer,
  source_member_id text,
  destination_member_id text,
  outcome text,
  message text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if not exists (
    select 1 from public.platform_member_migration_operations
    where id = p_operation_id and admin_user_id = auth.uid()
  ) then
    raise exception 'MIGRATION_OPERATION_NOT_FOUND';
  end if;

  return query
  select i.row_number,
    i.source_member_id,
    coalesce(i.destination_member_id, l.destination_member_id),
    i.outcome,
    case
      when i.outcome = 'skipped'
        and i.message = 'This member has already been transferred from the source gym.'
        and l.destination_gym_id is not null
      then left(
        'Already transferred to ' || coalesce(g.name, 'a removed gym') ||
        ' — ' || coalesce(u.email, 'owner email unavailable') ||
        ' on ' || to_char(l.transferred_at at time zone 'UTC', 'DD Mon YYYY HH24:MI') ||
        ' UTC. No duplicate was created.', 240)
      else i.message
    end
  from public.platform_member_migration_items i
  join public.platform_member_migration_operations o on o.id = i.operation_id
  left join public.platform_member_migration_links l
    on l.source_gym_id = o.source_gym_id and l.source_member_id = i.source_member_id
  left join public.gyms g on g.id = l.destination_gym_id
  left join auth.users u on u.id = g.owner_user_id
  where i.operation_id = p_operation_id
  order by i.row_number;
end;
$$;
