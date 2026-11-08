-- A citizen whose storehouse good is already full can leave that shift.
-- The mind chooses the place. This function only checks that the place offers
-- the role, then records the change. It does not move money and it is not a
-- chain transaction. The next world tick sends the citizen to the new shift.
-- A builder shift is what advances an unfinished building.

create or replace function world_change_shift(
  p_citizen uuid,
  p_building text,
  p_role text,
  p_decision uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity text;
  v_status text;
  v_building_role text;
  v_name text;
  v_world bigint;
  v_tick bigint;
  v_summary text;
begin
  if p_citizen is null or p_building is null or p_role is null then
    return jsonb_build_object('ok', false, 'reason', 'a shift change needs a citizen, a place, and a role');
  end if;
  if p_role not in ('farmer', 'woodcutter', 'stonecutter', 'crafter', 'builder') then
    return jsonb_build_object('ok', false, 'reason', 'that role cannot take a shift change');
  end if;

  select activity into v_activity
  from citizen_world_state
  where citizen_id = p_citizen;
  if v_activity is null then
    return jsonb_build_object('ok', false, 'reason', 'citizen is not in the world');
  end if;
  if v_activity = 'unavailable' then
    return jsonb_build_object('ok', false, 'reason', 'citizen is unavailable');
  end if;

  select status, role, name
  into v_status, v_building_role, v_name
  from world_buildings
  where id = p_building;
  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown building');
  end if;

  if p_role = 'builder' then
    if v_status <> 'under_construction' or v_building_role is distinct from 'builder' then
      return jsonb_build_object('ok', false, 'reason', 'a builder shift needs an unfinished building');
    end if;
  elsif v_status <> 'active' or v_building_role is distinct from p_role then
    return jsonb_build_object('ok', false, 'reason', 'that place does not offer this shift');
  end if;

  select last_tick_world_s, tick_seq into v_world, v_tick from world_state;

  update citizen_world_state
  set
    role = p_role,
    work_id = p_building,
    decision_source = 'ai',
    version = version + 1,
    updated_tick = coalesce(v_tick, updated_tick)
  where citizen_id = p_citizen;

  v_summary := coalesce(world_citizen_label(p_citizen), 'A citizen')
    || ' changed shift to ' || p_role || ' at ' || coalesce(v_name, p_building) || '.';

  perform world_record_event(
    'shift:' || coalesce(p_decision::text, p_citizen::text) || ':' || p_building,
    'citizen.retasked',
    'work',
    'ai',
    v_summary,
    p_citizen,
    p_building,
    null,
    now(),
    v_world,
    v_tick,
    jsonb_build_object('role', p_role, 'buildingId', p_building),
    null,
    p_decision
  );

  return jsonb_build_object('ok', true, 'role', p_role, 'buildingId', p_building, 'summary', v_summary);
end;
$$;

revoke all on function world_change_shift(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function world_change_shift(uuid, text, text, uuid) to service_role;
