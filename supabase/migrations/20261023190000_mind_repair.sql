-- Close new jail construction, detention, and punitive fines.
-- Existing laws, breaches, and sentences stay. Dating is stored from repeated meetings.
--
-- This file replaces civic functions and must follow 20261023040000_civic_places.sql.
-- Filename order already does that. The guard refuses an out-of-order apply so
-- CREATE OR REPLACE cannot invent world_levy_fine before the civic migration's
-- CREATE FUNCTION, and cannot restore jail construction afterwards.

do $$
begin
  if to_regclass('public.world_laws') is null
     or to_regclass('public.world_sentences') is null
     or to_regprocedure('public.world_open_civic_places()') is null
     or to_regprocedure('public.world_civic_snapshot()') is null
     or to_regprocedure('public.world_levy_fine(uuid,uuid)') is null
     or to_regprocedure('public.world_detain_citizen(uuid,uuid)') is null then
    raise exception '20261023040000_civic_places.sql must be applied before 20261023190000_mind_repair.sql';
  end if;
end $$;

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
  if p_kind not in ('house', 'farm', 'workshop', 'park', 'amusement', 'bank', 'jail') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported construction kind');
  end if;
  if p_kind = 'jail' then
    return jsonb_build_object('ok', false, 'reason', 'jail construction is disabled');
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

  v_capacity := case p_kind when 'house' then 4 when 'jail' then 4 else null end;
  v_open := p_kind in ('farm', 'park', 'amusement');

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

create or replace function world_levy_fine(p_citizen uuid, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object('ok', false, 'reason', 'punitive fines are disabled');
end;
$$;

create or replace function world_detain_citizen(p_citizen uuid, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object('ok', false, 'reason', 'detention is disabled');
end;
$$;

create table if not exists citizen_bonds (
  citizen_low uuid not null references citizens (id) on delete cascade,
  citizen_high uuid not null references citizens (id) on delete cascade,
  meetings integer not null default 0 check (meetings >= 0),
  stage text not null check (stage in ('met', 'familiar', 'interested', 'dating')),
  low_initiated boolean not null default false,
  high_initiated boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (citizen_low, citizen_high),
  check (citizen_low < citizen_high)
);

comment on table citizen_bonds is
  'Persistent familiarity from repeated social.met events. Dating is a simulated relationship, not a wallet, payout, or onchain authority.';

create or replace function world_progress_bond(p_actor uuid, p_related uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  low_id uuid;
  high_id uuid;
  v_meetings integer;
  v_low_initiated boolean;
  v_high_initiated boolean;
  actor_soc integer;
  partner_soc integer;
  actor_coop integer;
  partner_coop integer;
  mutual boolean;
  both_started boolean;
  elsewhere boolean;
  v_stage text;
begin
  if p_actor is null or p_related is null or p_actor = p_related then
    return jsonb_build_object('ok', false, 'reason', 'a bond needs two citizens');
  end if;
  if p_actor < p_related then
    low_id := p_actor;
    high_id := p_related;
  else
    low_id := p_related;
    high_id := p_actor;
  end if;

  insert into citizen_bonds (citizen_low, citizen_high, meetings, stage, low_initiated, high_initiated)
  values (low_id, high_id, 0, 'met', false, false)
  on conflict (citizen_low, citizen_high) do nothing;

  update citizen_bonds
  set
    meetings = citizen_bonds.meetings + 1,
    low_initiated = citizen_bonds.low_initiated or p_actor = citizen_bonds.citizen_low,
    high_initiated = citizen_bonds.high_initiated or p_actor = citizen_bonds.citizen_high,
    updated_at = now()
  where citizen_low = low_id and citizen_high = high_id
  returning meetings, low_initiated, high_initiated
  into v_meetings, v_low_initiated, v_high_initiated;

  select sociability, cooperation into actor_soc, actor_coop
  from citizen_personalities where citizen_id = p_actor;
  select sociability, cooperation into partner_soc, partner_coop
  from citizen_personalities where citizen_id = p_related;
  mutual := coalesce(actor_soc, 0) >= 55 and coalesce(actor_coop, 0) >= 40
    and coalesce(partner_soc, 0) >= 55 and coalesce(partner_coop, 0) >= 40;
  both_started := v_low_initiated and v_high_initiated;
  select exists (
    select 1 from citizen_bonds other
    where other.stage = 'dating'
      and (other.citizen_low in (low_id, high_id) or other.citizen_high in (low_id, high_id))
      and (other.citizen_low, other.citizen_high) is distinct from (low_id, high_id)
  ) into elsewhere;

  if v_meetings >= 6 and mutual and both_started and not coalesce(elsewhere, false) then
    v_stage := 'dating';
  elsif v_meetings >= 5 and mutual and both_started then
    v_stage := 'interested';
  elsif v_meetings >= 3 then
    v_stage := 'familiar';
  else
    v_stage := 'met';
  end if;

  update citizen_bonds
  set stage = v_stage, updated_at = now()
  where citizen_low = low_id and citizen_high = high_id;

  return jsonb_build_object(
    'ok', true,
    'stage', v_stage,
    'meetings', v_meetings,
    'dating', v_stage = 'dating'
  );
end;
$$;

create or replace function world_note_bond()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'social.met' and new.actor_citizen_id is not null and new.related_citizen_id is not null then
    perform world_progress_bond(new.actor_citizen_id, new.related_citizen_id);
  end if;
  return new;
end;
$$;

drop trigger if exists world_bonds_on_event on civilization_events;
create trigger world_bonds_on_event
  after insert on civilization_events
  for each row
  execute function world_note_bond();

revoke all on table citizen_bonds from public, anon, authenticated;
grant select on table citizen_bonds to service_role;
revoke all on function world_progress_bond(uuid, uuid) from public, anon, authenticated;
grant execute on function world_progress_bond(uuid, uuid) to service_role;
revoke all on function world_levy_fine(uuid, uuid) from public, anon, authenticated;
grant execute on function world_levy_fine(uuid, uuid) to service_role;
revoke all on function world_detain_citizen(uuid, uuid) from public, anon, authenticated;
grant execute on function world_detain_citizen(uuid, uuid) to service_role;
