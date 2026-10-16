-- Phase 5b: persistent catalog road overlay.
--
-- Additive only. Does not reset the clock, rewrite events, move buildings,
-- change construction costs, or rerun verify_cutover. The model may pick a
-- catalog stub id. Coordinates come from this catalog. world_tick() remains
-- the simulation engine. Overlay tiles merge into plot service and into
-- TypeScript pathfinding; they do not replace genesis roads.
--
-- Catalog and costs match src/lib/world/roads.ts. Keep them in lockstep.

create table world_road_catalog (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  tiles jsonb not null,
  serves_plot_ids text[] not null,
  created_at timestamptz not null default now()
);

comment on table world_road_catalog is
  'Trusted road-stub definitions. The model may choose an id. It never supplies tiles.';

insert into world_road_catalog (id, name, tiles, serves_plot_ids) values
  ('east-y2-64', 'East spur to plot 64,2', '[{"x":65,"y":9},{"x":65,"y":8},{"x":65,"y":6},{"x":65,"y":5}]'::jsonb, array['plot-64-2']),
  ('east-y2-68', 'East spur to plot 68,2', '[{"x":69,"y":9},{"x":69,"y":8},{"x":69,"y":6},{"x":69,"y":5}]'::jsonb, array['plot-68-2']),
  ('east-y2-72', 'East spur to plot 72,2', '[{"x":73,"y":9},{"x":73,"y":8},{"x":73,"y":6},{"x":73,"y":5}]'::jsonb, array['plot-72-2']),
  ('east-y2-76', 'East spur to plot 76,2', '[{"x":77,"y":9},{"x":77,"y":8},{"x":77,"y":6},{"x":77,"y":5}]'::jsonb, array['plot-76-2']),
  ('east-y2-80', 'East spur to plot 80,2', '[{"x":81,"y":9},{"x":81,"y":8},{"x":81,"y":6},{"x":81,"y":5}]'::jsonb, array['plot-80-2']),
  ('east-y2-84', 'East spur to plot 84,2', '[{"x":85,"y":9},{"x":85,"y":8},{"x":85,"y":6},{"x":85,"y":5}]'::jsonb, array['plot-84-2']);

create table world_roads (
  id text primary key references world_road_catalog (id),
  stub_id text not null unique references world_road_catalog (id),
  layout_version text not null,
  tiles jsonb not null,
  status text not null check (status in ('complete')),
  served_plot_ids text[] not null default '{}',
  source text not null check (source in ('ai', 'system')),
  decision_id uuid references ai_decisions (id) on delete set null,
  citizen_id uuid references citizens (id) on delete set null,
  event_id uuid references civilization_events (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

comment on table world_roads is
  'Completed runtime road overlay. Atomic catalog placement. Not a painted browser layer.';

create index world_roads_status on world_roads (status);

-- Base layout roads copied from src/lib/world/layout.ts ROADS.
create or replace function world_is_base_road(px integer, py integer)
returns boolean
language sql
immutable
as $$
  select
    px >= 0 and py >= 0 and px < 120 and py < 80 and (
      (px between 1 and 58 and py between 19 and 20)
      or (px between 29 and 30 and py between 1 and 38)
      or (px between 1 and 28 and py = 7)
      or (px between 1 and 28 and py = 14)
      or (px between 31 and 58 and py = 10)
      or (px between 1 and 58 and py = 31)
      or (px = 1 and py between 7 and 31)
      or (px between 59 and 116 and py between 19 and 20)
      or (px between 59 and 116 and py = 10)
      or (px between 59 and 116 and py = 31)
      or (px between 29 and 30 and py between 38 and 75)
      or (px between 90 and 91 and py between 10 and 71)
      or (px between 110 and 111 and py between 10 and 57)
      or (px between 29 and 111 and py between 55 and 56)
      or (px between 64 and 111 and py = 7)
      or (px between 1 and 28 and py = 50)
    );
$$;

create or replace function world_is_overlay_road(px integer, py integer)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from world_roads r
    cross join lateral jsonb_array_elements(r.tiles) t
    where r.status = 'complete'
      and (t ->> 'x')::integer = px
      and (t ->> 'y')::integer = py
  );
$$;

create or replace function world_is_road(px integer, py integer)
returns boolean
language sql
stable
as $$
  select world_is_base_road(px, py) or world_is_overlay_road(px, py);
$$;

create or replace function world_refresh_plot_service()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plot world_plots%rowtype;
  v_now timestamptz := now();
  v_world bigint;
  v_tick bigint;
  v_event uuid;
  v_ids text[] := '{}';
  v_dx integer;
  v_dy integer;
  v_served boolean;
begin
  select last_tick_world_s, tick_seq into v_world, v_tick from world_state where singleton;
  for plot in
    select * from world_plots where not served
  loop
    v_served := false;
    for v_dx in 0 .. plot.w - 1 loop
      for v_dy in 0 .. plot.h - 1 loop
        if world_is_road(plot.x + v_dx + 1, plot.y + v_dy) and not (
             plot.x + v_dx + 1 >= plot.x and plot.x + v_dx + 1 < plot.x + plot.w
             and plot.y + v_dy >= plot.y and plot.y + v_dy < plot.y + plot.h
           )
        then
          v_served := true;
        elsif world_is_road(plot.x + v_dx - 1, plot.y + v_dy) and not (
             plot.x + v_dx - 1 >= plot.x and plot.x + v_dx - 1 < plot.x + plot.w
             and plot.y + v_dy >= plot.y and plot.y + v_dy < plot.y + plot.h
           )
        then
          v_served := true;
        elsif world_is_road(plot.x + v_dx, plot.y + v_dy + 1) and not (
             plot.x + v_dx >= plot.x and plot.x + v_dx < plot.x + plot.w
             and plot.y + v_dy + 1 >= plot.y and plot.y + v_dy + 1 < plot.y + plot.h
           )
        then
          v_served := true;
        elsif world_is_road(plot.x + v_dx, plot.y + v_dy - 1) and not (
             plot.x + v_dx >= plot.x and plot.x + v_dx < plot.x + plot.w
             and plot.y + v_dy - 1 >= plot.y and plot.y + v_dy - 1 < plot.y + plot.h
           )
        then
          v_served := true;
        end if;
        exit when v_served;
      end loop;
      exit when v_served;
    end loop;

    if not v_served then
      continue;
    end if;

    update world_plots
    set
      served = true,
      status = case when status = 'reserved' then 'vacant' else status end
    where id = plot.id;

    v_ids := array_append(v_ids, plot.id);
    v_event := world_record_event(
      format('sim:%s:plot.served', plot.id),
      'plot.served',
      'world',
      'simulation',
      format('Plot %s is now served by a completed road.', plot.id),
      null,
      null,
      null,
      v_now,
      v_world,
      v_tick,
      jsonb_build_object('plotId', plot.id, 'x', plot.x, 'y', plot.y)
    );
  end loop;

  return jsonb_build_object('ok', true, 'served', to_jsonb(v_ids));
end;
$$;

comment on function world_refresh_plot_service() is
  'Marks a plot served only when a real road tile is cardinally adjacent to its footprint. Already served plots stay served.';

create or replace function world_place_road(
  p_stub text,
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
  catalog world_road_catalog%rowtype;
  ws world_state%rowtype;
  v_tile jsonb;
  v_tiles jsonb;
  v_x integer;
  v_y integer;
  v_nx integer;
  v_ny integer;
  v_connected boolean := false;
  v_stub boolean;
  v_other jsonb;
  v_event uuid;
  v_refresh jsonb;
  v_served text[];
  v_wood integer;
  v_stone integer;
  v_off integer;
  v_w integer := 120;
  v_h integer := 80;
  v_seen boolean[];
  v_queue integer[];
  v_head integer;
  v_cur integer;
  v_i integer;
  v_cx integer;
  v_cy integer;
  c_wood integer := 3;
  c_stone integer := 2;
begin
  if p_source is distinct from 'ai' and p_source is distinct from 'system' then
    return jsonb_build_object('ok', false, 'reason', 'invalid construction source');
  end if;
  if p_source = 'ai' and p_decision is null then
    return jsonb_build_object('ok', false, 'reason', 'an ai construction must reference an ai_decisions record');
  end if;

  select * into catalog from world_road_catalog where id = p_stub;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown road stub');
  end if;

  select * into ws from world_state where singleton for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'world is not initialized');
  end if;

  if exists (select 1 from world_roads where id = catalog.id) then
    return jsonb_build_object('ok', false, 'reason', 'road stub already placed');
  end if;

  v_tiles := catalog.tiles;
  if jsonb_typeof(v_tiles) <> 'array' or jsonb_array_length(v_tiles) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'road stub is disconnected');
  end if;

  for v_tile in select value from jsonb_array_elements(v_tiles)
  loop
    v_x := (v_tile ->> 'x')::integer;
    v_y := (v_tile ->> 'y')::integer;
    if v_x is null or v_y is null or v_x < 0 or v_y < 0 or v_x >= 120 or v_y >= 80 then
      return jsonb_build_object('ok', false, 'reason', 'road stub leaves the map');
    end if;
    if world_is_base_road(v_x, v_y) then
      return jsonb_build_object('ok', false, 'reason', 'road stub overlaps an existing road');
    end if;
    if world_is_overlay_road(v_x, v_y) then
      return jsonb_build_object('ok', false, 'reason', 'road stub overlaps a constructed road');
    end if;
    if v_y in (35, 36) then
      return jsonb_build_object('ok', false, 'reason', 'road stub overlaps water');
    end if;
    if exists (
      select 1 from world_buildings b
      where v_x >= b.x and v_x < b.x + b.w and v_y >= b.y and v_y < b.y + b.h
    ) then
      return jsonb_build_object('ok', false, 'reason', 'road stub overlaps a building');
    end if;
  end loop;

  -- Reachability from the founding boulevard, not from an isolated painted strip.
  v_seen := array_fill(false, array[v_w * v_h]);
  v_queue := array[19 * v_w + 29];
  v_seen[19 * v_w + 29 + 1] := true;
  v_head := 1;
  while v_head <= coalesce(array_length(v_queue, 1), 0) loop
    v_cur := v_queue[v_head];
    v_head := v_head + 1;
    v_cx := v_cur % v_w;
    v_cy := v_cur / v_w;
    for v_off in 1..4 loop
      v_nx := v_cx + case v_off when 1 then 1 when 2 then -1 else 0 end;
      v_ny := v_cy + case v_off when 3 then 1 when 4 then -1 else 0 end;
      if v_nx < 0 or v_ny < 0 or v_nx >= v_w or v_ny >= v_h then
        continue;
      end if;
      v_i := v_ny * v_w + v_nx;
      if v_seen[v_i + 1] then
        continue;
      end if;
      v_stub := false;
      for v_other in select value from jsonb_array_elements(v_tiles)
      loop
        if (v_other ->> 'x')::integer = v_nx and (v_other ->> 'y')::integer = v_ny then
          v_stub := true;
        end if;
      end loop;
      if not v_stub and not world_is_road(v_nx, v_ny) then
        continue;
      end if;
      v_seen[v_i + 1] := true;
      v_queue := array_append(v_queue, v_i);
    end loop;
  end loop;

  v_connected := true;
  for v_tile in select value from jsonb_array_elements(v_tiles)
  loop
    v_x := (v_tile ->> 'x')::integer;
    v_y := (v_tile ->> 'y')::integer;
    if not v_seen[v_y * v_w + v_x + 1] then
      v_connected := false;
    end if;
  end loop;
  if not v_connected then
    return jsonb_build_object('ok', false, 'reason', 'road stub does not connect to the existing road network');
  end if;

  v_wood := world_stock('wood');
  v_stone := world_stock('stone');
  if v_wood < c_wood or v_stone < c_stone then
    return jsonb_build_object('ok', false, 'reason', 'not enough wood and stone in the Storehouse');
  end if;
  if world_store('wood', -c_wood, ws.tick_seq) <> -c_wood
     or world_store('stone', -c_stone, ws.tick_seq) <> -c_stone then
    return jsonb_build_object('ok', false, 'reason', 'not enough wood and stone in the Storehouse');
  end if;

  insert into world_roads (
    id, stub_id, layout_version, tiles, status, source, decision_id, citizen_id
  ) values (
    catalog.id, catalog.id, ws.layout_version, catalog.tiles, 'complete', p_source, p_decision, p_citizen
  );

  v_refresh := world_refresh_plot_service();
  v_served := coalesce(array(
    select jsonb_array_elements_text(coalesce(v_refresh -> 'served', '[]'::jsonb))
  ), '{}'::text[]);

  v_event := world_record_event(
    format('sim:%s:road.placed', catalog.id),
    'road.placed',
    'construction',
    p_source,
    format('%s completed. Storehouse paid %s wood and %s stone.', catalog.name, c_wood, c_stone),
    p_citizen,
    null,
    null,
    now(),
    ws.last_tick_world_s,
    ws.tick_seq,
    jsonb_build_object(
      'stubId', catalog.id,
      'tiles', catalog.tiles,
      'servedPlotIds', to_jsonb(v_served),
      'wood', c_wood,
      'stone', c_stone
    ),
    null,
    p_decision
  );

  update world_roads
  set
    served_plot_ids = v_served,
    event_id = v_event
  where id = catalog.id;

  if p_decision is not null then
    update ai_decisions
    set
      status = case when status in ('failed', 'rejected') then status else 'accepted' end,
      outcome_event_id = coalesce(outcome_event_id, v_event),
      event_hash = coalesce(event_hash, (select event_hash from civilization_events where id = v_event)),
      proposed_action = coalesce(proposed_action, '{}'::jsonb) || jsonb_build_object('buildKind', 'road', 'roadStubId', catalog.id)
    where id = p_decision;
  end if;

  return jsonb_build_object(
    'ok', true,
    'roadId', catalog.id,
    'stubId', catalog.id,
    'servedPlotIds', to_jsonb(v_served),
    'eventId', v_event,
    'wood', c_wood,
    'stone', c_stone
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'reason', 'road could not be recorded');
end;
$$;

comment on function world_place_road(text, text, uuid, uuid) is
  'Places one catalog road stub atomically. Revalidates geometry and stock. Does not accept model coordinates.';

do $$
declare
  role_name text;
  fn regprocedure;
begin
  alter table world_road_catalog enable row level security;
  alter table world_roads enable row level security;
  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table world_road_catalog from %I', role_name);
      execute format('revoke all on table world_roads from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table world_road_catalog to service_role;
    grant select on table world_roads to service_role;
  end if;

  foreach fn in array array[
    'world_is_base_road(integer,integer)'::regprocedure,
    'world_is_overlay_road(integer,integer)'::regprocedure,
    'world_is_road(integer,integer)'::regprocedure,
    'world_refresh_plot_service()'::regprocedure,
    'world_place_road(text,text,uuid,uuid)'::regprocedure
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
    grant execute on function world_place_road(text, text, uuid, uuid) to service_role;
  end if;
end $$;
