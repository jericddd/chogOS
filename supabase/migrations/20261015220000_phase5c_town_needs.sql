-- Phase 5c: persistent town-level needs with hysteresis.
--
-- Additive only. Does not reset the clock, rewrite events, move buildings,
-- unlock reserved y=2 lots, change construction costs, or rerun verify_cutover.
-- world_tick() remains the simulation engine. This file evaluates needs after
-- each tick from persisted Storehouse stock. The model does not decide whether
-- a shortage exists.
--
-- Thresholds match src/lib/world/needs.ts. Keep them in lockstep.

create table town_needs (
  need_type text primary key check (need_type in (
    'food_shortage', 'tools_shortage', 'materials_shortage'
  )),
  status text not null check (status in ('inactive', 'active', 'blocked', 'resolved')),
  priority smallint not null check (priority between 0 and 100),
  first_detected_at timestamptz,
  last_evaluated_at timestamptz not null default now(),
  last_status_changed_at timestamptz,
  resolved_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  blocker text check (blocker is null or char_length(blocker) between 1 and 180),
  recommended_action text check (
    recommended_action is null or recommended_action in ('work', 'build', 'none')
  ),
  recommended_kind text check (
    recommended_kind is null or recommended_kind in ('house', 'farm', 'workshop', 'none')
  ),
  last_event_id uuid references civilization_events (id) on delete set null,
  last_decision_id uuid references ai_decisions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table town_needs is
  'One row per town need type. Status uses hysteresis on Storehouse stock. A proposal or completed building does not resolve a shortage. Only actual recovered stock does.';

create trigger town_needs_updated_at
  before update on town_needs
  for each row execute function set_updated_at();

create index town_needs_status on town_needs (status);

insert into town_needs (need_type, status, priority, recommended_action, recommended_kind)
values
  ('food_shortage', 'inactive', 100, 'none', 'none'),
  ('tools_shortage', 'inactive', 80, 'none', 'none'),
  ('materials_shortage', 'inactive', 60, 'none', 'none')
on conflict (need_type) do nothing;

create or replace function world_evaluate_town_needs(
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
  -- Copied from src/lib/world/needs.ts. Do not drift.
  c_food_on integer := 40;
  c_food_off integer := 80;
  c_tools_on integer := 4;
  c_tools_off integer := 12;
  c_wood_on integer := 3;
  c_stone_on integer := 2;
  c_wood_off integer := 15;
  c_stone_off integer := 10;
  v_food integer;
  v_wood integer;
  v_stone integer;
  v_tools integer;
  v_vacant integer;
  v_reserved integer;
  v_farms integer;
  v_workshops integer;
  v_houses integer;
  v_under jsonb;
  v_evidence jsonb;
  v_type text;
  v_old town_needs%rowtype;
  v_status text;
  v_blocker text;
  v_action text;
  v_kind text;
  v_activate boolean;
  v_recover boolean;
  v_open boolean;
  v_first timestamptz;
  v_resolved timestamptz;
  v_event uuid;
  v_kind_event text;
  v_summary text;
  v_changed integer := 0;
  v_events integer := 0;
begin
  if not exists (select 1 from world_buildings where id = 'storehouse') then
    return jsonb_build_object('ok', false, 'reason', 'storehouse missing');
  end if;
  v_food := world_stock('food');
  v_wood := world_stock('wood');
  v_stone := world_stock('stone');
  v_tools := world_stock('tools');
  select count(*)::int into v_vacant from world_plots where served and status = 'vacant';
  select count(*)::int into v_reserved from world_plots where not served;
  select count(*)::int into v_farms from world_buildings where kind = 'farm';
  select count(*)::int into v_workshops from world_buildings where kind = 'workshop';
  select count(*)::int into v_houses from world_buildings where kind = 'house';
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

  v_evidence := jsonb_build_object(
    'food', v_food,
    'wood', v_wood,
    'stone', v_stone,
    'tools', v_tools,
    'vacantServedLots', v_vacant,
    'reservedLots', v_reserved,
    'farms', v_farms,
    'workshops', v_workshops,
    'houses', v_houses,
    'underConstruction', v_under
  );

  foreach v_type in array array['food_shortage', 'tools_shortage', 'materials_shortage']
  loop
    select * into v_old from town_needs where need_type = v_type;
    v_blocker := null;
    v_action := 'none';
    v_kind := 'none';

    if v_type = 'food_shortage' then
      v_activate := v_food < c_food_on;
      v_recover := v_food >= c_food_off;
      if v_farms = 0 and not exists (
        select 1 from world_buildings where kind = 'farm' and status = 'under_construction'
      ) then
        if v_vacant <= 0 then
          v_blocker := 'no vacant road-served lot for a farm';
        elsif v_wood < c_wood_on or v_stone < c_stone_on then
          v_blocker := 'not enough wood and stone for a construction shift';
        end if;
      end if;
      if v_farms > 0 or exists (
        select 1 from world_buildings where kind = 'farm' and status = 'under_construction'
      ) then
        v_action := 'work';
        if exists (select 1 from world_buildings where kind = 'farm' and status = 'under_construction') then
          v_kind := 'farm';
        end if;
      elsif v_vacant > 0 and v_wood >= c_wood_on and v_stone >= c_stone_on then
        v_action := 'build';
        v_kind := 'farm';
      elsif v_wood < c_wood_on or v_stone < c_stone_on then
        v_action := 'work';
      end if;
    elsif v_type = 'tools_shortage' then
      v_activate := v_tools < c_tools_on;
      v_recover := v_tools >= c_tools_off;
      if v_workshops = 0 and not exists (
        select 1 from world_buildings where kind = 'workshop' and status = 'under_construction'
      ) then
        if v_vacant <= 0 then
          v_blocker := 'no vacant road-served lot for a workshop';
        elsif v_wood < c_wood_on or v_stone < c_stone_on then
          v_blocker := 'not enough wood and stone for a construction shift';
        end if;
      end if;
      if v_workshops > 0 or exists (
        select 1 from world_buildings where kind = 'workshop' and status = 'under_construction'
      ) then
        v_action := 'work';
        if exists (select 1 from world_buildings where kind = 'workshop' and status = 'under_construction') then
          v_kind := 'workshop';
        end if;
      elsif v_vacant > 0 and v_wood >= c_wood_on and v_stone >= c_stone_on then
        v_action := 'build';
        v_kind := 'workshop';
      elsif v_wood < 2 then
        v_action := 'work';
      end if;
    else
      v_activate := v_wood < c_wood_on or v_stone < c_stone_on;
      v_recover := v_wood >= c_wood_off and v_stone >= c_stone_off;
      v_action := 'work';
    end if;

    v_open := coalesce(v_old.status, 'inactive') in ('active', 'blocked');
    if v_open then
      if v_recover then
        v_status := 'resolved';
      elsif v_blocker is not null then
        v_status := 'blocked';
      else
        v_status := 'active';
      end if;
    elsif v_activate then
      if v_blocker is not null then
        v_status := 'blocked';
      else
        v_status := 'active';
      end if;
    elsif coalesce(v_old.status, 'inactive') = 'resolved' then
      v_status := 'resolved';
    else
      v_status := 'inactive';
    end if;

    if v_status in ('inactive', 'resolved') then
      v_action := 'none';
      v_kind := 'none';
      v_blocker := null;
    elsif v_status <> 'blocked' then
      v_blocker := null;
    end if;

    if v_old.need_type is not null
      and v_old.status = v_status
      and v_old.evidence = v_evidence
      and coalesce(v_old.blocker, '') = coalesce(v_blocker, '')
      and coalesce(v_old.recommended_action, 'none') = v_action
      and coalesce(v_old.recommended_kind, 'none') = v_kind
    then
      continue;
    end if;

    if v_status in ('active', 'blocked') and coalesce(v_old.status, 'inactive') in ('inactive', 'resolved') then
      v_first := p_now;
    else
      v_first := v_old.first_detected_at;
    end if;

    if v_status = 'resolved' and coalesce(v_old.status, 'inactive') <> 'resolved' then
      v_resolved := p_now;
    else
      v_resolved := v_old.resolved_at;
    end if;

    v_event := v_old.last_event_id;
    if v_old.status is distinct from v_status then
      if v_status in ('active', 'blocked') and coalesce(v_old.status, 'inactive') in ('inactive', 'resolved') then
        v_kind_event := 'town.need_detected';
        v_summary := case v_type
          when 'food_shortage' then format('Town food shortage detected. Storehouse food is %s.', v_food)
          when 'tools_shortage' then format('Town tool shortage detected. Storehouse tools are %s.', v_tools)
          else format('Town construction materials are short. Wood %s, stone %s.', v_wood, v_stone)
        end;
      elsif v_status = 'blocked' and v_old.status = 'active' then
        v_kind_event := 'town.need_blocked';
        v_summary := format('Town need %s is blocked. %s', replace(v_type, '_', ' '), coalesce(v_blocker, 'No supported action can proceed.'));
      elsif v_status = 'resolved' then
        v_kind_event := 'town.need_resolved';
        v_summary := case v_type
          when 'food_shortage' then format('Town food shortage resolved. Storehouse food is %s.', v_food)
          when 'tools_shortage' then format('Town tool shortage resolved. Storehouse tools are %s.', v_tools)
          else format('Town construction materials recovered. Wood %s, stone %s.', v_wood, v_stone)
        end;
      else
        v_kind_event := null;
      end if;

      if v_kind_event is not null then
        v_event := world_record_event(
          format('system:%s:%s:%s', v_kind_event, v_type, p_tick),
          v_kind_event,
          'world',
          'system',
          v_summary,
          null,
          'storehouse',
          null,
          p_now,
          p_world,
          p_tick,
          jsonb_build_object(
            'needType', v_type,
            'status', v_status,
            'previousStatus', v_old.status,
            'blocker', to_jsonb(v_blocker),
            'evidence', v_evidence
          )
        );
        if v_event is not null then
          v_events := v_events + 1;
        end if;
      end if;
    end if;

    update town_needs
    set
      status = v_status,
      priority = case v_type
        when 'food_shortage' then 100
        when 'tools_shortage' then 80
        else 60
      end,
      first_detected_at = v_first,
      last_evaluated_at = p_now,
      last_status_changed_at = case
        when v_old.status is distinct from v_status then p_now
        else last_status_changed_at
      end,
      resolved_at = v_resolved,
      evidence = v_evidence,
      blocker = v_blocker,
      recommended_action = v_action,
      recommended_kind = v_kind,
      last_event_id = coalesce(v_event, last_event_id)
    where need_type = v_type;
    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object('ok', true, 'updated', v_changed, 'events', v_events);
end;
$$;

comment on function world_evaluate_town_needs(timestamptz, bigint, bigint) is
  'Deterministic town-need evaluator. Called after world ticks. Does not call a model and does not change Storehouse stock.';

create or replace function world_evaluate_town_needs_after_tick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform world_evaluate_town_needs(new.last_tick_at, new.last_tick_world_s, new.tick_seq);
  return new;
exception
  when others then
    return new;
end;
$$;

drop trigger if exists world_state_evaluate_town_needs on world_state;
create trigger world_state_evaluate_town_needs
  after update of last_tick_at, last_tick_world_s, tick_seq
  on world_state
  for each row
  execute function world_evaluate_town_needs_after_tick();

create or replace function world_link_town_need(p_need text, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_need not in ('food_shortage', 'tools_shortage', 'materials_shortage') then
    return jsonb_build_object('ok', false, 'reason', 'unknown town need');
  end if;
  if p_decision is null then
    return jsonb_build_object('ok', false, 'reason', 'decision id required');
  end if;
  update town_needs
  set last_decision_id = p_decision
  where need_type = p_need
    and status in ('active', 'blocked');
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'need is not open');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

comment on function world_link_town_need(text, uuid) is
  'Records that an AI decision responded to an open town need. Does not resolve the need.';

do $$
declare
  role_name text;
  fn regprocedure;
begin
  alter table town_needs enable row level security;
  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table town_needs from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table town_needs to service_role;
  end if;

  foreach fn in array array[
    'world_evaluate_town_needs(timestamptz,bigint,bigint)'::regprocedure,
    'world_evaluate_town_needs_after_tick()'::regprocedure,
    'world_link_town_need(text,uuid)'::regprocedure
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
    grant execute on function world_link_town_need(text, uuid) to service_role;
  end if;
end $$;
