-- Phase 5d: persistent town development projects.
--
-- Additive only. Does not reset the clock, rewrite events, move buildings,
-- unlock lots, change construction costs, or rerun verify_cutover.
-- world_tick() remains the simulation engine. This file creates and advances
-- projects after each tick from persisted stock, plots, roads, buildings, and
-- town_needs. The model may choose an eligible next action. It cannot invent
-- project types, coordinates, or completion.
--
-- Rules match src/lib/world/projects.ts. Keep them in lockstep.

create table town_projects (
  id uuid primary key default gen_random_uuid(),
  project_type text not null check (project_type in (
    'food_production', 'tool_production', 'residential', 'territorial'
  )),
  objective_key text not null check (char_length(objective_key) between 1 and 80),
  name text not null check (char_length(name) between 1 and 80),
  description text not null check (char_length(description) between 1 and 280),
  status text not null check (status in (
    'proposed', 'active', 'blocked', 'completed', 'abandoned', 'cancelled'
  )),
  priority smallint not null check (priority between 0 and 100),
  need_type text references town_needs (need_type) on delete set null,
  justification text not null check (char_length(justification) between 1 and 280),
  steps jsonb not null default '[]'::jsonb,
  current_step_id text,
  current_step_index smallint not null default 0 check (current_step_index >= 0),
  blocker text check (blocker is null or char_length(blocker) between 1 and 180),
  recommended_action text not null default 'none' check (
    recommended_action in ('work', 'build', 'none')
  ),
  recommended_kind text not null default 'none' check (
    recommended_kind in ('house', 'farm', 'workshop', 'road', 'none')
  ),
  recommended_stub_id text,
  related_building_id text references world_buildings (id) on delete set null,
  related_plot_id text,
  related_road_id text,
  related_citizen_id uuid references citizens (id) on delete set null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_evaluated_at timestamptz,
  last_event_id uuid references civilization_events (id) on delete set null,
  last_decision_id uuid references ai_decisions (id) on delete set null
);

comment on table town_projects is
  'Town-level development projects. One open row per objective_key. Steps advance only from persisted world facts. A model proposal or queued intent does not complete a step.';

create trigger town_projects_updated_at
  before update on town_projects
  for each row execute function set_updated_at();

create unique index town_projects_one_open_objective
  on town_projects (objective_key)
  where status in ('proposed', 'active', 'blocked');

create index town_projects_status on town_projects (status);
create index town_projects_type_status on town_projects (project_type, status);

create or replace function world_town_project_facts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_under jsonb;
  v_needs jsonb;
  v_roads jsonb;
  v_served jsonb;
begin
  select coalesce(
    jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'progress', construction_progress) order by id),
    '[]'::jsonb
  )
  into v_under
  from (
    select id, kind, construction_progress
    from world_buildings
    where status = 'under_construction'
    order by id
    limit 8
  ) sites;

  select coalesce(jsonb_object_agg(need_type, status), '{}'::jsonb) into v_needs from town_needs;
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_roads from world_roads;
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_served from world_plots where served;

  return jsonb_build_object(
    'food', world_stock('food'),
    'wood', world_stock('wood'),
    'stone', world_stock('stone'),
    'tools', world_stock('tools'),
    'vacantServedLots', (select count(*)::int from world_plots where served and status = 'vacant'),
    'reservedLots', (select count(*)::int from world_plots where not served),
    'farms', (select count(*)::int from world_buildings where kind = 'farm'),
    'workshops', (select count(*)::int from world_buildings where kind = 'workshop'),
    'houses', (select count(*)::int from world_buildings where kind = 'house'),
    'houseBeds', (
      select coalesce(sum(capacity), 0)::int from world_buildings
      where kind = 'house' and status = 'active'
    ),
    'pendingHouseBeds', (
      select coalesce(sum(capacity), 0)::int from world_buildings
      where kind = 'house' and status = 'under_construction'
    ),
    'assignedResidents', (
      select count(*)::int from citizen_world_state
      where activity <> 'unavailable' and home_id is not null
    ),
    'unassignedCitizens', (
      select count(*)::int from citizen_world_state
      where activity <> 'unavailable' and home_id is null
    ),
    'farmBatches', (
      select coalesce(sum(batches_completed), 0)::int from world_buildings where kind = 'farm'
    ),
    'workshopBatches', (
      select coalesce(sum(batches_completed), 0)::int from world_buildings where kind = 'workshop'
    ),
    'underConstruction', v_under,
    'placedStubIds', v_roads,
    'servedPlotIds', v_served,
    'needStatus', v_needs
  );
end;
$$;

create or replace function world_project_step(
  p_id text,
  p_title text,
  p_status text,
  p_action text default 'none',
  p_kind text default 'none',
  p_stub text default null,
  p_plot text default null,
  p_skipped boolean default false
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p_id,
    'title', p_title,
    'status', p_status,
    'action', p_action,
    'buildKind', p_kind,
    'roadStubId', to_jsonb(p_stub),
    'plotId', to_jsonb(p_plot),
    'buildingId', 'null'::jsonb,
    'blocker', 'null'::jsonb,
    'skipped', p_skipped,
    'completedAt', 'null'::jsonb,
    'eventId', 'null'::jsonb
  );
$$;

create or replace function world_advance_town_projects(
  p_now timestamptz,
  p_world bigint,
  p_tick bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_food_on integer := 40;
  c_food_off integer := 80;
  c_tools_on integer := 4;
  c_tools_off integer := 12;
  c_wood integer := 3;
  c_stone integer := 2;
  c_max_open integer := 2;
  v_facts jsonb;
  v_food integer;
  v_wood integer;
  v_stone integer;
  v_tools integer;
  v_vacant integer;
  v_reserved integer;
  v_farms integer;
  v_workshops integer;
  v_unassigned integer;
  v_pending_beds integer;
  v_open integer;
  v_proj town_projects%rowtype;
  v_steps jsonb;
  v_step jsonb;
  v_len integer;
  v_i integer;
  v_status text;
  v_blocker text;
  v_action text;
  v_kind text;
  v_stub text;
  v_plot text;
  v_building text;
  v_step_status text;
  v_new_status text;
  v_current_id text;
  v_current_idx integer;
  v_rec_action text;
  v_rec_kind text;
  v_rec_stub text;
  v_event uuid;
  v_kind_event text;
  v_summary text;
  v_created integer := 0;
  v_updated integer := 0;
  v_events integer := 0;
  v_ready boolean;
  v_type text;
  v_name text;
  v_desc text;
  v_just text;
  v_need text;
  v_obj text;
  v_priority smallint;
  v_id uuid;
  v_exists uuid;
  v_started boolean;
  v_gone boolean;
  v_all_done boolean;
  v_patch jsonb;
begin
  if not exists (select 1 from world_buildings where id = 'storehouse') then
    return jsonb_build_object('ok', false, 'reason', 'storehouse missing');
  end if;

  v_facts := world_town_project_facts();
  v_food := (v_facts->>'food')::int;
  v_wood := (v_facts->>'wood')::int;
  v_stone := (v_facts->>'stone')::int;
  v_tools := (v_facts->>'tools')::int;
  v_vacant := (v_facts->>'vacantServedLots')::int;
  v_reserved := (v_facts->>'reservedLots')::int;
  v_farms := (v_facts->>'farms')::int;
  v_workshops := (v_facts->>'workshops')::int;
  v_unassigned := (v_facts->>'unassignedCitizens')::int;
  v_pending_beds := (v_facts->>'pendingHouseBeds')::int;

  for v_proj in
    select * from town_projects
    where status in ('proposed', 'active', 'blocked')
    order by priority desc, created_at
  loop
    v_started := v_proj.related_building_id is not null
      or exists (
        select 1 from jsonb_array_elements(v_proj.steps) s
        where s->>'id' in ('place_building', 'place_road')
          and s->>'status' in ('completed', 'skipped')
      );
    v_gone := false;
    if v_proj.project_type = 'food_production' and not v_started
      and v_food >= c_food_off
      and coalesce(v_facts#>>'{needStatus,food_shortage}', 'inactive') not in ('active', 'blocked')
      and v_food >= c_food_on
    then
      v_gone := true;
    elsif v_proj.project_type = 'tool_production' and not v_started
      and v_tools >= c_tools_off
      and coalesce(v_facts#>>'{needStatus,tools_shortage}', 'inactive') not in ('active', 'blocked')
      and v_tools >= c_tools_on
    then
      v_gone := true;
    elsif v_proj.project_type = 'residential' and not v_started and v_unassigned = 0 then
      v_gone := true;
    elsif v_proj.project_type = 'territorial' and not v_started and v_reserved <= 0 then
      v_gone := true;
    end if;

    if v_gone then
      v_event := world_record_event(
        format('system:town.project_abandoned:%s:%s', v_proj.id, p_tick),
        'town.project_abandoned',
        'world',
        'system',
        format('Town project %s was abandoned because its original condition recovered.', v_proj.name),
        null,
        coalesce(v_proj.related_building_id, 'storehouse'),
        null,
        p_now,
        p_world,
        p_tick,
        jsonb_build_object('projectId', v_proj.id, 'projectType', v_proj.project_type, 'objectiveKey', v_proj.objective_key)
      );
      update town_projects
      set
        status = 'abandoned',
        blocker = 'the original condition recovered before this project started work',
        recommended_action = 'none',
        recommended_kind = 'none',
        last_evaluated_at = p_now,
        evidence = v_facts,
        last_event_id = coalesce(v_event, last_event_id)
      where id = v_proj.id;
      v_updated := v_updated + 1;
      if v_event is not null then
        v_events := v_events + 1;
      end if;
      continue;
    end if;

    v_steps := v_proj.steps;
    v_len := coalesce(jsonb_array_length(v_steps), 0);
    if v_len = 0 then
      continue;
    end if;
    v_building := v_proj.related_building_id;
    v_new_status := 'pending';
    v_blocker := null;
    v_all_done := true;
    v_current_id := null;
    v_current_idx := v_len;
    v_rec_action := 'none';
    v_rec_kind := 'none';
    v_rec_stub := null;
    v_blocker := null;

    for v_i in 0..greatest(v_len - 1, 0) loop
      if v_len = 0 then
        exit;
      end if;
      v_step := v_steps->v_i;
      if v_step->>'status' in ('completed', 'skipped') then
        continue;
      end if;

      v_step_status := v_step->>'status';
      v_new_status := v_step_status;
      v_blocker := null;
      v_stub := coalesce(v_step->>'roadStubId', v_proj.related_road_id);
      v_plot := coalesce(v_step->>'plotId', v_proj.related_plot_id);
      v_kind := coalesce(v_step->>'buildKind', 'none');

      if v_step->>'id' in ('confirm_need', 'confirm_housing') then
        v_new_status := 'completed';
      elsif v_step->>'id' = 'ensure_lot' then
        if v_vacant > 0 then
          v_new_status := 'completed';
        else
          v_new_status := 'blocked';
          v_blocker := case when v_reserved > 0 then 'waiting for a road-served lot' else 'no vacant road-served lot' end;
        end if;
      elsif v_step->>'id' = 'place_road' then
        if v_stub is not null and exists (select 1 from world_roads where id = v_stub) then
          v_new_status := 'completed';
        elsif v_wood < c_wood or v_stone < c_stone then
          v_new_status := 'blocked';
          v_blocker := 'not enough wood and stone for a catalog road';
        elsif v_stub is null then
          v_new_status := 'blocked';
          v_blocker := 'no catalog road stub remains';
        else
          v_new_status := 'eligible';
        end if;
      elsif v_step->>'id' = 'verify_connection' then
        if v_stub is not null and exists (select 1 from world_roads where id = v_stub) then
          v_new_status := 'completed';
        else
          v_new_status := 'blocked';
          v_blocker := 'road overlay is not persisted yet';
        end if;
      elsif v_step->>'id' = 'unlock_plot' then
        if v_stub is null or not exists (select 1 from world_roads where id = v_stub) then
          v_new_status := 'blocked';
          v_blocker := 'a proposed road is not a placed road';
        elsif v_plot is not null and exists (select 1 from world_plots where id = v_plot and served) then
          v_new_status := 'completed';
        else
          v_new_status := 'blocked';
          v_blocker := 'the lot door does not yet touch a connected road';
        end if;
      elsif v_step->>'id' = 'place_building' then
        if v_kind not in ('house', 'farm', 'workshop') then
          v_new_status := 'skipped';
        else
          select b.id into v_building
          from world_buildings b
          where (v_proj.related_building_id is not null and b.id = v_proj.related_building_id)
             or (
               b.kind = v_kind
               and (
                 (v_kind = 'house' and b.id ~ '^house-[0-9]+$' and substring(b.id from '[0-9]+$')::int > 15)
                 or (v_kind = 'farm' and b.id ~ '^farm-[0-9]+$')
                 or (v_kind = 'workshop' and b.id ~ '^workshop-[0-9]+$')
               )
             )
          order by b.created_at desc
          limit 1;
          if v_building is not null then
            v_new_status := 'completed';
          elsif v_vacant <= 0 then
            v_new_status := 'blocked';
            v_blocker := case when v_reserved > 0 then 'waiting for a road-served lot' else 'no vacant road-served lot' end;
          elsif v_wood < c_wood or v_stone < c_stone then
            v_new_status := 'blocked';
            v_blocker := 'not enough wood and stone for a construction shift';
          else
            v_new_status := 'eligible';
          end if;
        end if;
      elsif v_step->>'id' = 'complete_building' then
        v_kind := coalesce(
          (select s->>'buildKind' from jsonb_array_elements(v_steps) s where s->>'id' = 'place_building' limit 1),
          'none'
        );
        if v_kind not in ('house', 'farm', 'workshop') then
          v_new_status := 'skipped';
        else
          select b.id, b.status into v_building, v_status
          from world_buildings b
          where (v_proj.related_building_id is not null and b.id = v_proj.related_building_id)
             or (
               b.kind = v_kind
               and (
                 (v_kind = 'house' and b.id ~ '^house-[0-9]+$' and substring(b.id from '[0-9]+$')::int > 15)
                 or (v_kind = 'farm' and b.id ~ '^farm-[0-9]+$')
                 or (v_kind = 'workshop' and b.id ~ '^workshop-[0-9]+$')
               )
             )
          order by b.created_at desc
          limit 1;
          if v_status = 'active' then
            v_new_status := 'completed';
          elsif v_building is not null then
            v_new_status := 'blocked';
            v_blocker := 'construction is still in progress';
          else
            v_new_status := 'blocked';
            v_blocker := 'no building has started';
          end if;
        end if;
      elsif v_step->>'id' = 'observe_production' then
        v_kind := case when v_proj.project_type = 'tool_production' then 'workshop' else 'farm' end;
        select b.id, b.status, b.batches_completed
        into v_building, v_status, v_open
        from world_buildings b
        where v_proj.related_building_id is not null and b.id = v_proj.related_building_id
        limit 1;
        if v_building is not null then
          if v_status <> 'active' then
            v_new_status := 'blocked';
            v_blocker := 'the new workplace is not complete';
          elsif coalesce(v_open, 0) > 0 then
            v_new_status := 'completed';
          else
            v_new_status := 'blocked';
            v_blocker := 'waiting for a real production batch';
          end if;
        else
          if (v_proj.project_type = 'food_production' and v_food >= c_food_off)
            or (v_proj.project_type = 'tool_production' and v_tools >= c_tools_off)
          then
            v_new_status := 'completed';
          else
            v_new_status := 'eligible';
          end if;
        end if;
      elsif v_step->>'id' = 'assign_residents' then
        select b.id, b.status into v_building, v_status
        from world_buildings b
        where v_proj.related_building_id is not null and b.id = v_proj.related_building_id
        limit 1;
        if v_status = 'active' then
          v_new_status := 'completed';
        else
          v_new_status := 'blocked';
          v_blocker := 'the house is not complete';
        end if;
      end if;

      v_patch := jsonb_build_object(
        'status', v_new_status,
        'blocker', to_jsonb(v_blocker),
        'buildingId', to_jsonb(v_building),
        'skipped', (v_new_status = 'skipped')
      );
      if v_new_status in ('completed', 'skipped') and v_step_status not in ('completed', 'skipped') then
        v_kind_event := 'town.project_step_completed';
        v_summary := format('Town project %s completed step %s.', v_proj.name, v_step->>'id');
        v_event := world_record_event(
          format('system:%s:%s:%s:%s', v_kind_event, v_proj.id, v_step->>'id', p_tick),
          v_kind_event,
          'world',
          'system',
          v_summary,
          null,
          coalesce(v_building, v_proj.related_building_id, 'storehouse'),
          null,
          p_now,
          p_world,
          p_tick,
          jsonb_build_object(
            'projectId', v_proj.id,
            'projectType', v_proj.project_type,
            'stepId', v_step->>'id',
            'status', v_new_status
          )
        );
        if v_event is not null then
          v_events := v_events + 1;
        end if;
        v_patch := v_patch || jsonb_build_object('completedAt', p_now, 'eventId', v_event);
        v_steps := jsonb_set(v_steps, array[v_i::text], v_step || v_patch, false);
        if v_building is not null then
          v_proj.related_building_id := v_building;
        end if;
        continue;
      end if;

      v_steps := jsonb_set(v_steps, array[v_i::text], v_step || v_patch, false);
      v_all_done := false;
      v_current_id := v_step->>'id';
      v_current_idx := v_i;
      if v_new_status = 'eligible' then
        v_rec_action := coalesce(v_step->>'action', 'none');
        v_rec_kind := coalesce(v_step->>'buildKind', 'none');
        v_rec_stub := v_stub;
        if v_new_status = 'eligible' and v_step->>'id' = 'observe_production' then
          v_rec_action := 'work';
          v_rec_kind := 'none';
        end if;
      else
        v_rec_action := 'none';
        v_rec_kind := 'none';
        v_rec_stub := null;
      end if;
      if v_new_status in ('blocked', 'failed') then
        v_blocker := v_blocker;
      else
        v_blocker := null;
      end if;
      exit;
    end loop;

    if v_len > 0 and v_all_done then
      v_status := 'completed';
      v_current_id := null;
      v_current_idx := v_len;
      v_rec_action := 'none';
      v_rec_kind := 'none';
      v_rec_stub := null;
      v_blocker := null;
    elsif v_new_status = 'blocked' or v_new_status = 'failed' then
      v_status := 'blocked';
    elsif v_new_status = 'eligible' then
      v_status := 'active';
    else
      v_status := 'proposed';
    end if;

    v_kind_event := null;
    v_event := null;
    if v_proj.status is distinct from v_status then
      if v_status = 'blocked' then
        v_kind_event := 'town.project_blocked';
        v_summary := format('Town project %s is blocked. %s', v_proj.name, coalesce(v_blocker, 'A prerequisite is unmet.'));
      elsif v_status = 'completed' then
        v_kind_event := 'town.project_completed';
        v_summary := format('Town project %s reached its completion condition.', v_proj.name);
      elsif v_status = 'active' and v_proj.status in ('proposed', 'blocked') then
        v_kind_event := 'town.project_step_eligible';
        v_summary := format('Town project %s has an eligible next step.', v_proj.name);
      end if;
      if v_kind_event is not null then
        v_event := world_record_event(
          format('system:%s:%s:%s', v_kind_event, v_proj.id, p_tick),
          v_kind_event,
          'world',
          'system',
          v_summary,
          null,
          coalesce(v_proj.related_building_id, 'storehouse'),
          null,
          p_now,
          p_world,
          p_tick,
          jsonb_build_object(
            'projectId', v_proj.id,
            'projectType', v_proj.project_type,
            'status', v_status,
            'previousStatus', v_proj.status,
            'blocker', to_jsonb(v_blocker),
            'stepId', to_jsonb(v_current_id)
          )
        );
        if v_event is not null then
          v_events := v_events + 1;
        end if;
      end if;
    end if;

    update town_projects
    set
      steps = v_steps,
      current_step_id = v_current_id,
      current_step_index = v_current_idx,
      status = v_status,
      blocker = v_blocker,
      recommended_action = v_rec_action,
      recommended_kind = v_rec_kind,
      recommended_stub_id = v_rec_stub,
      related_building_id = coalesce(v_building, related_building_id),
      evidence = v_facts,
      last_evaluated_at = p_now,
      completed_at = case when v_status = 'completed' then coalesce(completed_at, p_now) else completed_at end,
      last_event_id = coalesce(v_event, last_event_id)
    where id = v_proj.id;
    v_updated := v_updated + 1;
  end loop;

  select count(*)::int into v_open from town_projects where status in ('proposed', 'active', 'blocked');

  foreach v_type in array array['food_production', 'tool_production', 'residential', 'territorial']
  loop
    if v_open >= c_max_open then
      exit;
    end if;
    if exists (
      select 1 from town_projects
      where project_type = v_type and status in ('proposed', 'active', 'blocked')
    ) then
      continue;
    end if;

    v_need := null;
    v_stub := null;
    v_plot := null;
    v_ready := false;
    if v_type = 'food_production' then
      if not (
        coalesce(v_facts#>>'{needStatus,food_shortage}', 'inactive') in ('active', 'blocked')
        or v_food < c_food_on
      ) then
        continue;
      end if;
      v_need := 'food_shortage';
      v_obj := 'food_production';
      v_priority := 100;
      v_name := 'Expand food production';
      v_desc := 'Improve food capacity only while Storehouse food is actually short. A finished farm is not food.';
      v_just := format('Storehouse food is %s (shortage below %s, recovers at %s).', v_food, c_food_on, c_food_off);
      v_ready := v_farms > 0 or exists (select 1 from world_buildings where kind = 'farm' and status = 'under_construction');
      v_steps := jsonb_build_array(
        world_project_step('confirm_need', 'Confirm the food shortage from Storehouse stock', 'completed'),
        world_project_step('ensure_lot', case when v_ready then 'Existing workplaces cover this need' else 'Wait for a vacant road-served lot' end, case when v_ready then 'skipped' else 'pending' end, 'none', 'none', null, null, v_ready),
        world_project_step('place_building', case when v_ready then 'farm capacity already exists' else 'Start a farm on a served lot' end, case when v_ready then 'skipped' else 'pending' end, case when v_ready then 'none' else 'build' end, case when v_ready then 'none' else 'farm' end, null, null, v_ready),
        world_project_step('complete_building', case when v_ready then 'No new building is required' else 'Finish the farm' end, case when v_ready then 'skipped' else 'pending' end, 'none', 'none', null, null, v_ready),
        world_project_step('observe_production', 'Wait for a real food batch or recovered stock', 'pending', 'work')
      );
    elsif v_type = 'tool_production' then
      if not (
        coalesce(v_facts#>>'{needStatus,tools_shortage}', 'inactive') in ('active', 'blocked')
        or v_tools < c_tools_on
      ) then
        continue;
      end if;
      v_need := 'tools_shortage';
      v_obj := 'tool_production';
      v_priority := 80;
      v_name := 'Expand tool production';
      v_desc := 'Improve tool capacity only while Storehouse tools are actually short. A finished workshop is not tools.';
      v_just := format('Storehouse tools are %s (shortage below %s, recovers at %s).', v_tools, c_tools_on, c_tools_off);
      v_ready := v_workshops > 0 or exists (select 1 from world_buildings where kind = 'workshop' and status = 'under_construction');
      v_steps := jsonb_build_array(
        world_project_step('confirm_need', 'Confirm the tool shortage from Storehouse stock', 'completed'),
        world_project_step('ensure_lot', case when v_ready then 'Existing workplaces cover this need' else 'Wait for a vacant road-served lot' end, case when v_ready then 'skipped' else 'pending' end, 'none', 'none', null, null, v_ready),
        world_project_step('place_building', case when v_ready then 'workshop capacity already exists' else 'Start a workshop on a served lot' end, case when v_ready then 'skipped' else 'pending' end, case when v_ready then 'none' else 'build' end, case when v_ready then 'none' else 'workshop' end, null, null, v_ready),
        world_project_step('complete_building', case when v_ready then 'No new building is required' else 'Finish the workshop' end, case when v_ready then 'skipped' else 'pending' end, 'none', 'none', null, null, v_ready),
        world_project_step('observe_production', 'Wait for a real tool batch or recovered stock', 'pending', 'work')
      );
    elsif v_type = 'residential' then
      if v_unassigned <= v_pending_beds or (v_vacant <= 0 and v_reserved <= 0) then
        continue;
      end if;
      v_obj := 'residential';
      v_priority := 50;
      v_name := 'Expand housing assignments';
      v_desc := 'Add a house only when citizens without a house assignment exceed unfinished house beds. Commons Hall remains a valid shelter.';
      v_just := format('%s citizens have no house assignment and %s beds are already under construction.', v_unassigned, v_pending_beds);
      v_steps := jsonb_build_array(
        world_project_step('confirm_housing', 'Confirm housing pressure from actual assignments', 'completed'),
        world_project_step('ensure_lot', 'Wait for a vacant road-served lot', 'pending'),
        world_project_step('place_building', 'Start a house on a served lot', 'pending', 'build', 'house'),
        world_project_step('complete_building', 'Finish the house', 'pending'),
        world_project_step('assign_residents', 'Wait until the house is complete and assignments can update', 'pending')
      );
    else
      if v_reserved <= 0 then
        continue;
      end if;
      select c.id, c.serves_plot_ids[1]
      into v_stub, v_plot
      from world_road_catalog c
      where not exists (select 1 from world_roads r where r.id = c.id)
        and not exists (
          select 1 from town_projects p
          where p.objective_key = 'territorial:' || c.id
            and p.status in ('proposed', 'active', 'blocked', 'completed')
        )
      order by c.id
      limit 1;
      if v_stub is null then
        continue;
      end if;
      v_obj := 'territorial:' || v_stub;
      v_priority := 30;
      v_name := format('Open %s', coalesce(v_plot, v_stub));
      v_desc := 'Place a catalog road stub so a reserved surveyed lot can be served. Forest and meadow stay scenery.';
      v_just := format('%s reserved lots remain. Catalog stub %s is the next unused spur.', v_reserved, v_stub);
      v_steps := jsonb_build_array(
        world_project_step('place_road', format('Place catalog road %s', v_stub), 'pending', 'build', 'road', v_stub, v_plot),
        world_project_step('verify_connection', 'Verify the overlay is persisted and connected', 'pending', 'none', 'none', v_stub, v_plot),
        world_project_step('unlock_plot', format('Wait until %s is road-served', coalesce(v_plot, 'the lot')), 'pending', 'none', 'none', v_stub, v_plot)
      );
    end if;

    select id into v_exists from town_projects where objective_key = v_obj and status in ('proposed', 'active', 'blocked') limit 1;
    if v_exists is not null then
      continue;
    end if;

    insert into town_projects (
      project_type, objective_key, name, description, status, priority, need_type,
      justification, steps, related_plot_id, related_road_id, evidence, last_evaluated_at
    )
    values (
      v_type, v_obj, left(v_name, 80), v_desc, 'proposed', v_priority, v_need,
      left(v_just, 280), v_steps, v_plot, v_stub, v_facts, p_now
    )
    returning id into v_id;

    v_event := world_record_event(
      format('system:town.project_created:%s', v_id),
      'town.project_created',
      'world',
      'system',
      format('Town project created: %s.', v_name),
      null,
      'storehouse',
      null,
      p_now,
      p_world,
      p_tick,
      jsonb_build_object(
        'projectId', v_id,
        'projectType', v_type,
        'objectiveKey', v_obj,
        'source', 'system'
      )
    );
    update town_projects set last_event_id = coalesce(v_event, last_event_id) where id = v_id;
    v_created := v_created + 1;
    v_open := v_open + 1;
    if v_event is not null then
      v_events := v_events + 1;
    end if;
  end loop;

  -- Refresh newly inserted rows so the first eligible step is marked this tick.
  if v_created > 0 then
    perform world_advance_town_projects_refresh_open(p_now, p_world, p_tick, v_facts);
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'updated', v_updated, 'events', v_events);
end;
$$;

-- Second pass for rows inserted this call so we do not recurse the full creator.
create or replace function world_advance_town_projects_refresh_open(
  p_now timestamptz,
  p_world bigint,
  p_tick bigint,
  p_facts jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c_wood integer := 3;
  c_stone integer := 2;
  v_proj town_projects%rowtype;
  v_steps jsonb;
  v_step jsonb;
  v_len integer;
  v_i integer;
  v_new_status text;
  v_blocker text;
  v_stub text;
  v_vacant integer;
  v_wood integer;
  v_stone integer;
  v_rec_action text;
  v_rec_kind text;
  v_rec_stub text;
  v_status text;
  v_current_id text;
  v_current_idx integer;
  v_event uuid;
begin
  v_vacant := (p_facts->>'vacantServedLots')::int;
  v_wood := (p_facts->>'wood')::int;
  v_stone := (p_facts->>'stone')::int;
  for v_proj in
    select * from town_projects
    where status = 'proposed'
    order by created_at desc
  loop
    v_steps := v_proj.steps;
    v_len := jsonb_array_length(v_steps);
    v_rec_action := 'none';
    v_rec_kind := 'none';
    v_rec_stub := null;
    v_blocker := null;
    v_current_id := null;
    v_current_idx := 0;
    v_status := 'proposed';
    for v_i in 0..greatest(v_len - 1, 0) loop
      v_step := v_steps->v_i;
      if v_step->>'status' in ('completed', 'skipped') then
        continue;
      end if;
      v_stub := coalesce(v_step->>'roadStubId', v_proj.related_road_id);
      v_new_status := 'pending';
      if v_step->>'id' = 'ensure_lot' then
        if v_vacant > 0 then
          v_new_status := 'completed';
        else
          v_new_status := 'blocked';
          v_blocker := 'waiting for a road-served lot';
        end if;
      elsif v_step->>'id' = 'place_road' then
        if v_wood < c_wood or v_stone < c_stone then
          v_new_status := 'blocked';
          v_blocker := 'not enough wood and stone for a catalog road';
        else
          v_new_status := 'eligible';
        end if;
      elsif v_step->>'id' = 'place_building' then
        if v_vacant <= 0 then
          v_new_status := 'blocked';
          v_blocker := 'waiting for a road-served lot';
        elsif v_wood < c_wood or v_stone < c_stone then
          v_new_status := 'blocked';
          v_blocker := 'not enough wood and stone for a construction shift';
        else
          v_new_status := 'eligible';
        end if;
      elsif v_step->>'id' = 'observe_production' then
        v_new_status := 'eligible';
      else
        v_new_status := coalesce(v_step->>'status', 'pending');
      end if;
      v_steps := jsonb_set(
        v_steps,
        array[v_i::text],
        v_step || jsonb_build_object('status', v_new_status, 'blocker', to_jsonb(v_blocker)),
        false
      );
      v_current_id := v_step->>'id';
      v_current_idx := v_i;
      if v_new_status = 'eligible' then
        v_status := 'active';
        v_rec_action := coalesce(v_step->>'action', 'none');
        v_rec_kind := coalesce(v_step->>'buildKind', 'none');
        v_rec_stub := v_stub;
        v_event := world_record_event(
          format('system:town.project_step_eligible:%s:%s', v_proj.id, p_tick),
          'town.project_step_eligible',
          'world',
          'system',
          format('Town project %s has an eligible next step.', v_proj.name),
          null,
          'storehouse',
          null,
          p_now,
          p_world,
          p_tick,
          jsonb_build_object('projectId', v_proj.id, 'stepId', v_current_id)
        );
      elsif v_new_status = 'blocked' then
        v_status := 'blocked';
      elsif v_new_status = 'completed' then
        v_steps := jsonb_set(
          v_steps,
          array[v_i::text],
          v_step || jsonb_build_object('status', 'completed', 'completedAt', p_now, 'blocker', 'null'::jsonb),
          false
        );
        continue;
      end if;
      exit;
    end loop;
    update town_projects
    set
      steps = v_steps,
      status = v_status,
      current_step_id = v_current_id,
      current_step_index = v_current_idx,
      blocker = v_blocker,
      recommended_action = v_rec_action,
      recommended_kind = v_rec_kind,
      recommended_stub_id = v_rec_stub,
      last_evaluated_at = p_now,
      last_event_id = coalesce(v_event, last_event_id)
    where id = v_proj.id;
  end loop;
end;
$$;

comment on function world_advance_town_projects(timestamptz, bigint, bigint) is
  'Deterministic town-project planner. Called after world ticks. Does not call a model and does not place buildings or roads.';

create or replace function world_advance_town_projects_after_tick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform world_advance_town_projects(new.last_tick_at, new.last_tick_world_s, new.tick_seq);
  return new;
exception
  when others then
    return new;
end;
$$;

drop trigger if exists world_state_evaluate_town_projects on world_state;
create trigger world_state_evaluate_town_projects
  after update of last_tick_at, last_tick_world_s, tick_seq
  on world_state
  for each row
  execute function world_advance_town_projects_after_tick();

create or replace function world_link_town_project(p_project uuid, p_decision uuid, p_citizen uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_project is null or p_decision is null then
    return jsonb_build_object('ok', false, 'reason', 'project and decision ids required');
  end if;
  update town_projects
  set last_decision_id = p_decision, related_citizen_id = coalesce(p_citizen, related_citizen_id)
  where id = p_project
    and status in ('proposed', 'active', 'blocked');
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'project is not open');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

comment on function world_link_town_project(uuid, uuid, uuid) is
  'Records that an AI decision responded to an open town project. Does not complete a step.';

do $$
declare
  role_name text;
  fn regprocedure;
begin
  alter table town_projects enable row level security;
  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table town_projects from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table town_projects to service_role;
  end if;

  foreach fn in array array[
    'world_town_project_facts()'::regprocedure,
    'world_project_step(text,text,text,text,text,text,text,boolean)'::regprocedure,
    'world_advance_town_projects(timestamptz,bigint,bigint)'::regprocedure,
    'world_advance_town_projects_refresh_open(timestamptz,bigint,bigint,jsonb)'::regprocedure,
    'world_advance_town_projects_after_tick()'::regprocedure,
    'world_link_town_project(uuid,uuid,uuid)'::regprocedure
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
    grant execute on function world_link_town_project(uuid, uuid, uuid) to service_role;
  end if;
end $$;
