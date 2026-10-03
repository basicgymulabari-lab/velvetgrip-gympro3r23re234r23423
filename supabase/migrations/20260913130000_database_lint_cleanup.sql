-- Keep validation callable from triggers/RPCs without overstating volatility.
-- Supabase's plpgsql linter flags the JSON inspection performed by this
-- routine as STABLE, so mark it accordingly.
alter function public.iv_validate_workspace(jsonb) stable;

-- Equivalent owner-tenant bootstrap with the unused legacy role variable
-- removed. The tenant continues to be derived exclusively from auth.uid().
create or replace function public.ensure_owner_gym(p_name text, p_initial_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_gym_id uuid;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'My Gym'), 120);
  v_display_name text := left(coalesce(nullif(trim(p_initial_state -> 'settings' ->> 'adminName'), ''), 'Gym Owner'), 120);
  v_email text := left(coalesce(nullif(trim(p_initial_state -> 'settings' ->> 'email'), ''), ''), 320);
  v_state jsonb;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select gym_id into v_gym_id
  from public.gym_users
  where user_id = v_user
  limit 1;
  if found then
    return public.get_current_gym_context();
  end if;

  insert into public.gyms (owner_user_id, name)
  values (v_user, v_name)
  on conflict (owner_user_id) do update set updated_at = now()
  returning id into v_gym_id;

  insert into public.gym_users (gym_id, user_id, role, display_name, email, enabled, permissions)
  values (v_gym_id, v_user, 'owner', v_display_name, v_email, true, '{}'::jsonb)
  on conflict (gym_id, user_id) do update set
    role = 'owner', enabled = true, display_name = excluded.display_name,
    email = excluded.email, updated_at = now();

  v_state := coalesce(p_initial_state, '{}'::jsonb) - 'auth' - 'staff';
  v_state := jsonb_set(v_state, '{auth}', '{"email":"","passwordHash":""}'::jsonb, true);
  v_state := jsonb_set(v_state, '{staff}', '{}'::jsonb, true);

  insert into public.gym_workspaces (owner_id, gym_id, state, revision)
  values (v_user, v_gym_id, v_state, 1)
  on conflict (gym_id) do nothing;

  insert into public.audit_logs (gym_id, user_id, role, action, entity_type, entity_id)
  values (v_gym_id, v_user, 'owner', 'gym_created', 'gym', v_gym_id::text);

  return public.get_current_gym_context();
end;
$$;
