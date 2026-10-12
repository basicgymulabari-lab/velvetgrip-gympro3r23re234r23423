-- PostgreSQL requires RETURNS TABLE query expressions to match their declared
-- types exactly. auth.users.email is varchar, while this RPC promises text.
create or replace function public.platform_list_member_migration_history(
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  operation_id uuid,
  operation_type text,
  source_gym_name text,
  destination_gym_name text,
  admin_email text,
  status text,
  total_count integer,
  successful_count integer,
  skipped_count integer,
  failed_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  row_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select o.id,
    o.operation_type::text,
    s.name::text,
    d.name::text,
    coalesce(u.email::text, 'Removed admin'::text),
    o.status::text,
    o.total_count,
    o.successful_count,
    o.skipped_count,
    o.failed_count,
    o.created_at,
    o.updated_at,
    count(*) over ()
  from public.platform_member_migration_operations o
  left join public.gyms s on s.id = o.source_gym_id
  left join public.gyms d on d.id = o.destination_gym_id
  left join auth.users u on u.id = o.admin_user_id
  order by o.created_at desc
  limit least(greatest(coalesce(p_page_size, 25), 1), 100)
  offset (least(greatest(coalesce(p_page, 1), 1), 100000) - 1)
    * least(greatest(coalesce(p_page_size, 25), 1), 100);
end;
$$;

revoke all on function public.platform_list_member_migration_history(integer, integer)
  from public, anon, service_role;
grant execute on function public.platform_list_member_migration_history(integer, integer)
  to authenticated;
