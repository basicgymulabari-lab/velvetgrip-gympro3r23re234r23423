-- Explicitly cast varchar-backed gym/auth columns to the text return types
-- declared by this RPC. RETURN QUERY does not coerce these automatically.
create or replace function public.platform_list_member_migration_gyms()
returns table (
  gym_id uuid, gym_name text, owner_email text, account_status text,
  member_count integer, has_workspace boolean, is_source boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.iv_is_platform_admin() then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query
  select g.id, g.name::text, coalesce(u.email::text, m.email::text, ''::text)::text,
    g.account_status::text,
    (select count(*)::integer from jsonb_array_elements(
      case when jsonb_typeof(w.state -> 'members') = 'array' then w.state -> 'members' else '[]'::jsonb end
    ) member where coalesce(member ->> 'type', 'member') <> 'walk_in'
      and nullif(member ->> 'deletedAt', '') is null),
    w.gym_id is not null, g.is_member_migration_source
  from public.gyms g
  left join public.gym_workspaces w on w.gym_id = g.id
  left join public.gym_users m on m.gym_id = g.id and m.user_id = g.owner_user_id and m.role = 'owner'
  left join auth.users u on u.id = g.owner_user_id
  order by g.is_member_migration_source desc, g.created_at desc
  limit 1000;
end;
$$;

revoke all on function public.platform_list_member_migration_gyms() from public, anon, service_role;
grant execute on function public.platform_list_member_migration_gyms() to authenticated;
