-- Phase 5a: civil works on existing roads.
--
-- Additive only. Does not reset the clock, rewrite events, move founding
-- buildings, unlock reserved y=2 lots, or rerun verify_cutover.
-- Houses, farms, and workshops may be placed on vacant road-served lots.
-- Coordinates still come from surveyed plots, never from unconstrained model output.

insert into world_plots (id, x, y, w, h, served, status)
values
  ('plot-80-11', 80, 11, 3, 3, true, 'vacant'),
  ('plot-84-11', 84, 11, 3, 3, true, 'vacant'),
  ('plot-92-11', 92, 11, 3, 3, true, 'vacant'),
  ('plot-96-11', 96, 11, 3, 3, true, 'vacant'),
  ('plot-100-11', 100, 11, 3, 3, true, 'vacant'),
  ('plot-53-57', 53, 57, 3, 3, true, 'vacant'),
  ('plot-57-57', 57, 57, 3, 3, true, 'vacant'),
  ('plot-61-57', 61, 57, 3, 3, true, 'vacant'),
  ('plot-65-57', 65, 57, 3, 3, true, 'vacant'),
  ('plot-69-57', 69, 57, 3, 3, true, 'vacant'),
  ('plot-73-57', 73, 57, 3, 3, true, 'vacant')
on conflict (id) do nothing;

comment on table world_plots is
  'Surveyed lots from genesis-v1.1. served lots have a door that touches a road. Unserved lots stay vacant until roads exist. Phase 5a adds lots along existing east y=11 and south y=57 roads.';

-- When a site becomes active, a farm is a farmer workplace, a workshop is a
-- crafter workplace, and a house is a home. Mutates NEW so world_complete still
-- sees capacity from the row it locked for houses placed before this function.

create or replace function world_prepare_building_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'farm' then
    new.role := 'farmer';
    new.job_slots := 4;
    new.batch_shifts := 3;
    new.capacity := null;
    new.open_air := true;
  elsif new.kind = 'workshop' then
    new.role := 'crafter';
    new.job_slots := 4;
    new.batch_shifts := 3;
    new.capacity := null;
    new.open_air := false;
  end if;
  return new;
end;
$$;

create or replace function world_assign_activated_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assigned integer := 0;
  v_slots integer;
begin
  if new.kind not in ('farm', 'workshop') or new.role is null then
    return new;
  end if;
  v_slots := coalesce(new.job_slots, 0);
  if v_slots <= 0 then
    return new;
  end if;

  with builders as (
    select s.citizen_id
    from citizen_world_state s
    join citizens z on z.id = s.citizen_id
    where s.work_id = new.id
      and s.role = 'builder'
      and s.activity <> 'unavailable'
    order by z.token_id
    limit v_slots
  )
  update citizen_world_state s
  set role = new.role, work_id = new.id, updated_tick = new.updated_tick
  from builders
  where s.citizen_id = builders.citizen_id;
  get diagnostics v_assigned = row_count;

  if v_assigned < v_slots then
    with candidates as (
      select s.citizen_id
      from citizen_world_state s
      join citizens z on z.id = s.citizen_id
      where s.activity <> 'unavailable'
        and s.role is null
      order by z.token_id
      limit (v_slots - v_assigned)
    )
    update citizen_world_state s
    set role = new.role, work_id = new.id, updated_tick = new.updated_tick
    from candidates
    where s.citizen_id = candidates.citizen_id;
  end if;

  return new;
end;
$$;

drop trigger if exists world_buildings_prepare_activation on world_buildings;
create trigger world_buildings_prepare_activation
  before update on world_buildings
  for each row
  when (old.status is distinct from new.status and old.status = 'under_construction' and new.status = 'active')
  execute function world_prepare_building_activation();

drop trigger if exists world_buildings_assign_activated_jobs on world_buildings;
create trigger world_buildings_assign_activated_jobs
  after update on world_buildings
  for each row
  when (old.status is distinct from new.status and old.status = 'under_construction' and new.status = 'active')
  execute function world_assign_activated_jobs();

-- Kind-aware goals: finishing a farm does not complete housing goals.

create or replace function world_complete(p_citizen uuid, p_t timestamptz, p_world bigint, p_tick bigint)
returns void
language plpgsql
as $$
declare
  c citizen_world_state%rowtype;
  b world_buildings%rowtype;
  v_label text;
  v_resource text;
  v_amount integer;
  v_added integer;
  v_progress integer;
  v_next text;
  v_mover record;
  v_moved integer := 0;
  v_category text;
  v_event uuid;
  v_intent uuid;
  v_decision uuid;
  v_skill text;
  v_goal text;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen for update;
  if c.task ->> 'action' is distinct from 'work' or c.location_id is null then
    return;
  end if;
  select * into b from world_buildings where id = c.location_id for update;
  v_label := world_citizen_label(p_citizen);
  v_category := case
    when c.activity = 'gathering' then 'resource'
    when c.activity = 'building' then 'construction'
    else 'work'
  end;
  begin
    v_intent := (c.task ->> 'intent')::uuid;
  exception when others then
    v_intent := null;
  end;
  begin
    v_decision := (c.task ->> 'decision')::uuid;
  exception when others then
    v_decision := null;
  end;
  if v_decision is null and v_intent is not null then
    select decision_id into v_decision from world_intents where id = v_intent;
  end if;

  v_event := world_record_event(
    format('sim:%s:%s:work.shift_completed', p_citizen, c.version),
    'work.shift_completed',
    v_category,
    c.decision_source,
    format('%s finished a shift at %s.', v_label, b.name),
    p_citizen,
    b.id,
    null,
    p_t,
    p_world,
    p_tick,
    jsonb_build_object('shift', (c.task ->> 'shift')::integer, 'role', c.role, 'activity', c.activity),
    v_intent,
    v_decision
  );

  if v_event is not null then
    v_skill := world_skill_for_role(c.role);
    if v_skill is not null then
      perform world_award_skill(p_citizen, v_skill, v_event, case when c.role = 'builder' then 10 else 8 end);
    end if;
    if c.decision_source = 'ai' then
      perform world_remember_success(
        p_citizen, v_event, b.id, p_world,
        format('Completed a %s shift at %s.', coalesce(c.role, 'work'), b.name),
        'completed_task'
      );
    end if;
    if c.role = 'crafter' then
      perform world_progress_goal(p_citizen, 'skill_craft', 12, b.id);
    elsif c.role in ('farmer', 'woodcutter', 'stonecutter') then
      perform world_progress_goal(p_citizen, 'resource_production', 10, b.id);
    elsif c.role = 'builder' then
      v_goal := case b.kind
        when 'farm' then 'resource_production'
        when 'workshop' then 'skill_craft'
        else 'housing'
      end;
      perform world_progress_goal(p_citizen, v_goal, 8, b.id);
    elsif c.role = 'merchant' then
      perform world_progress_goal(p_citizen, 'community_facility', 10, b.id);
    end if;
    if v_decision is not null then
      update ai_decisions
      set
        status = 'executed',
        outcome_event_id = coalesce(outcome_event_id, v_event),
        event_hash = coalesce(event_hash, (select event_hash from civilization_events where id = v_event))
      where id = v_decision and status in ('queued', 'accepted', 'proposed', 'executed');
    end if;
  end if;

  if b.status = 'under_construction' and c.activity = 'building' then
    v_progress := least(100, coalesce(b.construction_progress, 0) + 4);
    if v_progress < 100 then
      update world_buildings
      set construction_progress = v_progress, updated_tick = p_tick
      where id = b.id;
      return;
    end if;

    select id into v_next
    from world_buildings
    where status = 'under_construction' and id <> b.id
    order by id
    limit 1;

    update world_buildings
    set construction_progress = 100, status = 'active', completed_at = p_t, updated_tick = p_tick
    where id = b.id;

    perform world_record_event(
      format('sim:%s:construction.completed', b.id),
      'construction.completed',
      'construction',
      'simulation',
      format('%s completed construction. Its walls were raised by simulated builder shifts.', b.name),
      null,
      b.id,
      null,
      p_t,
      p_world,
      p_tick,
      jsonb_build_object('capacity', b.capacity, 'kind', b.kind, 'nextSite', v_next),
      v_intent,
      v_decision
    );

    v_goal := case b.kind
      when 'farm' then 'resource_production'
      when 'workshop' then 'skill_craft'
      when 'house' then 'housing'
      else null
    end;
    if v_goal is not null then
      update citizen_goals
      set status = 'completed', progress = 100, completed_at = now(), related_building_id = b.id
      where kind = v_goal and status in ('proposed', 'active', 'blocked')
        and (related_building_id = b.id or related_building_id is null);
    end if;

    for v_mover in
      select s.citizen_id
      from citizen_world_state s
      join citizens z on z.id = s.citizen_id
      where s.home_id is null and s.activity <> 'unavailable'
      order by z.token_id
      limit coalesce(b.capacity, 0)
    loop
      update citizen_world_state
      set home_id = b.id, updated_tick = p_tick
      where citizen_id = v_mover.citizen_id;
      v_moved := v_moved + 1;
      perform world_record_event(
        format('sim:%s:home:%s', v_mover.citizen_id, b.id),
        'citizen.moved_in',
        'citizen',
        'simulation',
        format('%s was assigned a home in %s.', world_citizen_label(v_mover.citizen_id), b.name),
        v_mover.citizen_id,
        b.id,
        null,
        p_t,
        p_world,
        p_tick,
        '{}'::jsonb
      );
    end loop;

    if v_next is not null then
      update citizen_world_state
      set work_id = v_next, updated_tick = p_tick
      where role = 'builder' and work_id = b.id;
    else
      update citizen_world_state
      set role = null, work_id = null, updated_tick = p_tick
      where role = 'builder' and work_id = b.id;
    end if;
    return;
  end if;

  if b.batch_shifts is null then
    return;
  end if;

  v_resource := case b.kind
    when 'farm' then 'food'
    when 'forest' then 'wood'
    when 'quarry' then 'stone'
    when 'workshop' then 'tools'
  end;
  v_amount := case b.kind
    when 'farm' then 15
    when 'forest' then 18
    when 'quarry' then 9
    when 'workshop' then 4
  end;
  if v_resource is null then
    return;
  end if;

  v_progress := b.production_progress + 1;
  if v_progress < b.batch_shifts then
    update world_buildings set production_progress = v_progress, updated_tick = p_tick where id = b.id;
    return;
  end if;

  v_added := world_store(v_resource, v_amount, p_tick);
  if v_added <= 0 then
    update world_buildings set production_progress = b.batch_shifts, updated_tick = p_tick where id = b.id;
    return;
  end if;

  update world_buildings
  set production_progress = 0, batches_completed = b.batches_completed + 1, updated_tick = p_tick
  where id = b.id;

  perform world_record_event(
    format('sim:%s:batch:%s', b.id, b.batches_completed + 1),
    'production.batch_completed',
    'resource',
    'simulation',
    format('%s completed a simulated batch. %s %s went to the Storehouse.', b.name, v_added, v_resource),
    null,
    b.id,
    null,
    p_t,
    p_world,
    p_tick,
    jsonb_build_object(
      'resource', v_resource,
      'amount', v_added,
      'batch', b.batches_completed + 1,
      'stock', world_stock(v_resource)
    )
  );
end;
$$;

create or replace function world_place_building(
  p_plot text,
  p_kind text,
  p_id text,
  p_name text,
  p_door_x integer,
  p_door_y integer,
  p_routes jsonb,
  p_source text,
  p_decision uuid,
  p_citizen uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plot world_plots%rowtype;
  ws world_state%rowtype;
  v_overlap text;
  v_route jsonb;
  v_from text;
  v_to text;
  v_steps integer;
  v_expected integer;
  v_event uuid;
  v_assigned integer := 0;
  v_capacity integer;
  v_open boolean;
begin
  if p_kind not in ('house', 'farm', 'workshop') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported construction kind');
  end if;
  if p_source is distinct from 'ai' and p_source is distinct from 'system' then
    return jsonb_build_object('ok', false, 'reason', 'invalid construction source');
  end if;
  if p_source = 'ai' and p_decision is null then
    return jsonb_build_object('ok', false, 'reason', 'an ai construction must reference an ai_decisions record');
  end if;
  if p_id is null or p_id !~ '^[a-z0-9-]{2,40}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid building id');
  end if;

  select * into ws from world_state where singleton for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'world is not initialized');
  end if;

  select * into plot from world_plots where id = p_plot for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown plot');
  end if;
  if plot.status is distinct from 'vacant' then
    return jsonb_build_object('ok', false, 'reason', 'plot is not vacant');
  end if;
  if not plot.served then
    return jsonb_build_object('ok', false, 'reason', 'plot is not connected to a road');
  end if;
  if p_door_x < plot.x or p_door_x > plot.x + plot.w - 1
     or p_door_y < plot.y or p_door_y > plot.y + plot.h - 1 then
    return jsonb_build_object('ok', false, 'reason', 'door is outside the plot');
  end if;

  select b.id into v_overlap
  from world_buildings b
  where b.x < plot.x + plot.w
    and b.x + b.w > plot.x
    and b.y < plot.y + plot.h
    and b.y + b.h > plot.y
  limit 1;
  if v_overlap is not null then
    return jsonb_build_object('ok', false, 'reason', 'plot overlaps an existing building');
  end if;

  if exists (select 1 from world_buildings where id = p_id) then
    return jsonb_build_object('ok', false, 'reason', 'building id already exists');
  end if;

  v_expected := (select count(*)::int from world_buildings) * 2;
  if p_routes is null or jsonb_typeof(p_routes) <> 'array' or jsonb_array_length(p_routes) <> v_expected then
    return jsonb_build_object('ok', false, 'reason', 'route table is incomplete');
  end if;

  v_capacity := case p_kind when 'house' then 4 else null end;
  v_open := p_kind = 'farm';

  insert into world_buildings (
    id, layout_version, kind, name, x, y, w, h, door_x, door_y,
    capacity, job_slots, role, open_air, status, construction_progress, batch_shifts
  ) values (
    p_id, ws.layout_version, p_kind, left(coalesce(nullif(p_name, ''), p_id), 80),
    plot.x, plot.y, plot.w, plot.h, p_door_x, p_door_y,
    v_capacity, 7, 'builder', v_open, 'under_construction', 0, null
  );

  for v_route in select value from jsonb_array_elements(p_routes)
  loop
    v_from := v_route ->> 'from';
    v_to := v_route ->> 'to';
    v_steps := (v_route ->> 'steps')::integer;
    if v_from is null or v_to is null or v_steps is null or v_steps <= 0 then
      raise exception 'invalid route';
    end if;
    if (v_from <> p_id and v_to <> p_id) or v_from = v_to then
      raise exception 'route must connect the new building';
    end if;
    if not exists (select 1 from world_buildings where id = v_from)
      or not exists (select 1 from world_buildings where id = v_to) then
      raise exception 'route names an unknown building';
    end if;
    insert into world_routes (from_id, to_id, steps) values (v_from, v_to, v_steps);
  end loop;

  update world_plots
  set status = 'occupied', building_id = p_id
  where id = plot.id;

  v_event := world_record_event(
    format('sim:%s:construction.started', p_id),
    'construction.started',
    'construction',
    p_source,
    format('%s construction started on a surveyed lot.', left(coalesce(nullif(p_name, ''), p_id), 80)),
    p_citizen,
    p_id,
    null,
    now(),
    ws.last_tick_world_s,
    ws.tick_seq,
    jsonb_build_object('plotId', plot.id, 'kind', p_kind),
    null,
    p_decision
  );

  with candidates as (
    select s.citizen_id
    from citizen_world_state s
    join citizens z on z.id = s.citizen_id
    where s.activity <> 'unavailable' and s.role is null
    order by z.token_id
    limit 7
  )
  update citizen_world_state s
  set role = 'builder', work_id = p_id, updated_tick = ws.tick_seq
  from candidates
  where s.citizen_id = candidates.citizen_id;
  get diagnostics v_assigned = row_count;

  if p_decision is not null then
    update ai_decisions
    set
      status = case when status in ('failed', 'rejected') then status else 'accepted' end,
      outcome_event_id = coalesce(outcome_event_id, v_event),
      event_hash = coalesce(event_hash, (select event_hash from civilization_events where id = v_event)),
      proposed_action = coalesce(proposed_action, '{}'::jsonb) || jsonb_build_object('buildingId', p_id, 'plotId', plot.id, 'buildKind', p_kind)
    where id = p_decision;
  end if;

  return jsonb_build_object(
    'ok', true,
    'buildingId', p_id,
    'plotId', plot.id,
    'kind', p_kind,
    'eventId', v_event,
    'buildersAssigned', v_assigned
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'reason', 'construction could not be recorded');
end;
$$;

do $$
declare
  role_name text;
  fn regprocedure;
begin
  foreach fn in array array[
    'world_prepare_building_activation()'::regprocedure,
    'world_assign_activated_jobs()'::regprocedure
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    foreach role_name in array array['anon', 'authenticated', 'service_role']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', fn, role_name);
      end if;
    end loop;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function world_place_building(text, text, text, text, integer, integer, jsonb, text, uuid, uuid) to service_role;
  end if;
end $$;
