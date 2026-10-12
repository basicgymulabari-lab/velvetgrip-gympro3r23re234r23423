-- A member batch must not classify profiles already transferred from its own
-- source as destination duplicates. This matters both within one RPC batch and
-- across the UI's repeated 100-row batches. Placeholder phone values such as
-- 0000000000 are not stable identifiers and must not block a roster import.
do $migration$
declare
  v_preview_definition text;
  v_transfer_definition text;
  v_preview_old text := $old$
        where nullif(dm ->> 'deletedAt', '') is null
          and ((nullif(lower(btrim(coalesce(e.m ->> 'email', ''))), '') is not null
                and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(e.m ->> 'email')))
            or (length(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
                and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                  = right(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g'), 10)))
$old$;
  v_preview_new text := $new$
        where nullif(dm ->> 'deletedAt', '') is null
          and not exists (
            select 1 from public.platform_member_migration_links migrated
            where migrated.source_gym_id = p_source_gym_id
              and migrated.destination_gym_id = p_destination_gym_id
              and migrated.destination_member_id = dm ->> 'id'
          )
          and ((nullif(lower(btrim(coalesce(e.m ->> 'email', ''))), '') is not null
                and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(e.m ->> 'email')))
            or (length(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
                and length(replace(
                  right(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g'), 10),
                  left(right(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g'), 10), 1), '')) > 0
                and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                  = right(regexp_replace(coalesce(e.m ->> 'phone', ''), '[^0-9]', '', 'g'), 10)))
$new$;
  v_transfer_old text := $old$
        select exists (select 1 from jsonb_array_elements(v_destination_members) dm
          where nullif(dm ->> 'deletedAt', '') is null and (
            (nullif(lower(btrim(coalesce(v_member ->> 'email', ''))), '') is not null
              and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(v_member ->> 'email')))
            or (length(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
              and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g'), 10))))
          into v_duplicate;
$old$;
  v_transfer_new text := $new$
        select exists (select 1 from jsonb_array_elements(v_destination_members) dm
          where nullif(dm ->> 'deletedAt', '') is null
            and not exists (
              select 1 from public.platform_member_migration_links migrated
              where migrated.source_gym_id = p_source_gym_id
                and migrated.destination_gym_id = p_destination_gym_id
                and migrated.destination_member_id = dm ->> 'id'
            )
            and (
              (nullif(lower(btrim(coalesce(v_member ->> 'email', ''))), '') is not null
                and lower(btrim(coalesce(dm ->> 'email', ''))) = lower(btrim(v_member ->> 'email')))
              or (length(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g')) >= 10
                and length(replace(
                  right(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g'), 10),
                  left(right(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g'), 10), 1), '')) > 0
                and right(regexp_replace(coalesce(dm ->> 'phone', ''), '[^0-9]', '', 'g'), 10)
                  = right(regexp_replace(coalesce(v_member ->> 'phone', ''), '[^0-9]', '', 'g'), 10))))
          into v_duplicate;
$new$;
begin
  select pg_get_functiondef(
    'public.platform_list_member_migration_members(uuid,uuid,text,integer,integer)'::regprocedure
  ) into v_preview_definition;
  if position(v_preview_old in v_preview_definition) = 0 then
    raise exception 'Member migration preview duplicate check changed; refusing an unsafe rewrite.';
  end if;
  execute replace(v_preview_definition, v_preview_old, v_preview_new);

  select pg_get_functiondef(
    'public.platform_transfer_members(uuid,uuid,uuid,text[],integer,text[],jsonb,boolean,text[],boolean)'::regprocedure
  ) into v_transfer_definition;
  if position(v_transfer_old in v_transfer_definition) = 0 then
    raise exception 'Member migration transfer duplicate check changed; refusing an unsafe rewrite.';
  end if;
  execute replace(v_transfer_definition, v_transfer_old, v_transfer_new);
end;
$migration$;
