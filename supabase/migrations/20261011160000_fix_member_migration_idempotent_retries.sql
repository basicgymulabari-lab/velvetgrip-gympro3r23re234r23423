-- A committed transfer soft-deletes its source copy. Check the unique transfer
-- link before classifying that row as unavailable so safe retries explain the
-- original destination instead of returning a generic missing-source failure.
-- Patch the existing function definition to retain its schema's live business
-- logic; fail closed if the expected implementation has drifted.
do $$
declare
  v_definition text;
  v_link_needle text := $needle$
    if v_member is not null then
      if exists(select 1 from public.platform_member_migration_links where source_gym_id = p_source_gym_id
        and source_member_id = v_member_id) then
$needle$;
  v_link_replacement text := $replacement$
    -- Existing links remain authoritative even after the source copy is in Trash.
    if v_member is null and exists(select 1 from public.platform_member_migration_links
      where source_gym_id = p_source_gym_id and source_member_id = v_member_id) then
      v_status := 'skipped'; v_message := 'This member has already been transferred from the source gym.';
    end if;
    if v_member is not null then
      if exists(select 1 from public.platform_member_migration_links where source_gym_id = p_source_gym_id
        and source_member_id = v_member_id) then
$replacement$;
  v_status_needle text := $needle$
  v_operation_status := case when not coalesce(p_final, false) then 'processing'
    when v_failed = 0 and v_skipped = 0 then 'completed'
    when v_success > 0 then 'partial' else 'failed' end;
$needle$;
  v_status_replacement text := $replacement$
  v_operation_status := case
    when not coalesce(p_final, false) then 'processing'
    when v_failed > 0 and v_success > 0 then 'partial'
    when v_failed > 0 then 'failed'
    when v_skipped > 0 and v_success > 0 then 'partial'
    else 'completed'
  end;
$replacement$;
begin
  v_definition := pg_get_functiondef(
    'public.platform_transfer_members(uuid,uuid,uuid,text[],integer,text[],jsonb,boolean,text[],boolean)'::regprocedure
  );

  if position('Existing links remain authoritative even after the source copy is in Trash.' in v_definition) > 0 then
    return;
  end if;
  if position(v_link_needle in v_definition) = 0
     or position(v_status_needle in v_definition) = 0 then
    raise exception 'Member migration function changed; refusing to apply an unverified retry patch.';
  end if;

  v_definition := replace(v_definition, v_link_needle, v_link_replacement);
  v_definition := replace(v_definition, v_status_needle, v_status_replacement);
  execute v_definition;
end;
$$;
