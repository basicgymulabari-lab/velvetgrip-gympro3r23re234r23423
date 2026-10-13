-- Keep attendance separate from the revisioned JSON workspace so the visit
-- history can grow without making every workspace sync larger.
create table if not exists public.gym_member_attendance (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null references public.gyms(id) on delete cascade,
  member_id text not null check (length(trim(member_id)) between 1 and 100),
  attendance_date date not null,
  checked_in_at timestamptz not null default statement_timestamp(),
  checked_in_by uuid references auth.users(id) on delete set null,
  constraint gym_member_attendance_one_per_day unique (gym_id, member_id, attendance_date)
);

create index if not exists gym_member_attendance_day_idx
  on public.gym_member_attendance (gym_id, attendance_date, checked_in_at desc);

alter table public.gym_member_attendance enable row level security;

revoke all on table public.gym_member_attendance from public, anon, authenticated;
grant select on table public.gym_member_attendance to authenticated;

create or replace function public.iv_can_manage_member_attendance()
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
      and membership.gym_id = public.iv_current_gym_id()
      and membership.enabled
      and (
        membership.role = 'owner'
        or (
          membership.role = 'receptionist'
          and public.iv_has_permission(membership.permissions, 'members')
        )
      )
  )
$$;

revoke all on function public.iv_can_manage_member_attendance() from public, anon;
grant execute on function public.iv_can_manage_member_attendance() to authenticated;

drop policy if exists "Gym members can read attendance" on public.gym_member_attendance;
create policy "Gym members can read attendance"
  on public.gym_member_attendance for select to authenticated
  using (
    gym_id = public.iv_current_gym_id()
    and public.iv_can_manage_member_attendance()
  );

create or replace function public.record_current_member_attendance(
  p_member_id text,
  p_attendance_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_gym_id uuid;
  v_role text;
  v_permissions jsonb;
  v_workspace jsonb;
  v_entry public.gym_member_attendance%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  if p_member_id is null
    or p_member_id <> trim(p_member_id)
    or length(p_member_id) not between 1 and 100
    or p_attendance_date is null then
    raise exception using errcode = '22023', message = 'ATTENDANCE_INVALID_INPUT';
  end if;

  select membership.gym_id, membership.role, membership.permissions
    into v_gym_id, v_role, v_permissions
  from public.gym_users membership
  where membership.user_id = v_user_id
    and membership.enabled
  order by case membership.role when 'owner' then 0 else 1 end
  limit 1;

  if v_gym_id is null
    or not (
      v_role = 'owner'
      or (
        v_role = 'receptionist'
        and public.iv_has_permission(v_permissions, 'members')
      )
    ) then
    raise exception using errcode = '42501', message = 'ATTENDANCE_FORBIDDEN';
  end if;

  -- The client supplies the gym's local calendar date; a one-day UTC margin
  -- accommodates gyms whose local date differs from the database date.
  if p_attendance_date < current_date - 1 or p_attendance_date > current_date + 1 then
    raise exception using errcode = '22023', message = 'ATTENDANCE_DATE_OUT_OF_RANGE';
  end if;

  -- Serialize against concurrent workspace saves so a deleted/non-member
  -- profile cannot pass validation while its roster row is being changed.
  select workspace.state into v_workspace
  from public.gym_workspaces workspace
  where workspace.gym_id = v_gym_id
  for share;

  if not found or not exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(v_workspace -> 'members') = 'array' then v_workspace -> 'members'
        else '[]'::jsonb
      end
    ) member
    where member ->> 'id' = p_member_id
      and coalesce(member ->> 'type', 'member') <> 'walk_in'
      and coalesce(member ->> 'deletedAt', '') = ''
  ) then
    raise exception using errcode = 'P0002', message = 'ATTENDANCE_MEMBER_NOT_FOUND';
  end if;

  insert into public.gym_member_attendance (gym_id, member_id, attendance_date, checked_in_by)
  values (v_gym_id, p_member_id, p_attendance_date, v_user_id)
  on conflict (gym_id, member_id, attendance_date) do nothing
  returning * into v_entry;

  if found then
    return jsonb_build_object(
      'status', 'checked_in',
      'id', v_entry.id,
      'gym_id', v_entry.gym_id,
      'member_id', v_entry.member_id,
      'attendance_date', v_entry.attendance_date,
      'checked_in_at', v_entry.checked_in_at,
      'checked_in_by', v_entry.checked_in_by
    );
  end if;

  select * into v_entry
  from public.gym_member_attendance
  where gym_id = v_gym_id
    and member_id = p_member_id
    and attendance_date = p_attendance_date;

  return jsonb_build_object(
    'status', 'already_checked_in',
    'id', v_entry.id,
    'gym_id', v_entry.gym_id,
    'member_id', v_entry.member_id,
    'attendance_date', v_entry.attendance_date,
    'checked_in_at', v_entry.checked_in_at,
    'checked_in_by', v_entry.checked_in_by
  );
end;
$$;

revoke all on function public.record_current_member_attendance(text, date) from public, anon;
grant execute on function public.record_current_member_attendance(text, date) to authenticated;
