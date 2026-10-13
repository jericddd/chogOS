-- Hosted Postgres rejects UPDATE without a WHERE clause. The expand
-- function from 20261013120000 is replaced; no data is rewritten.

create or replace function world_expand_layout_at(p_layout jsonb, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_world bigint;
  v_version text := p_layout ->> 'version';
  v_hash text := p_layout ->> 'hash';
  v_from text[];
  v_grid_w integer := coalesce((p_layout ->> 'gridW')::integer, 120);
  v_grid_h integer := coalesce((p_layout ->> 'gridH')::integer, 80);
  v_mismatch text;
  v_added integer := 0;
  v_routes integer := 0;
  v_regions integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.world_tick'));

  if v_version is null or v_hash is null or jsonb_typeof(p_layout -> 'buildings') <> 'array' then
    raise exception 'layout payload is missing a version, hash, or buildings';
  end if;

  select * into ws from world_state where singleton;
  if not found then
    return jsonb_build_object('status', 'not_initialized');
  end if;

  select coalesce(array_agg(v), array[]::text[])
  into v_from
  from jsonb_array_elements_text(coalesce(p_layout -> 'fromVersions', '[]'::jsonb)) as v;

  insert into world_regions (id, layout_version, name, kind, x, y, w, h, note)
  select r.id, v_version, r.name, r.kind, r.x, r.y, r.w, r.h, r.note
  from jsonb_to_recordset(coalesce(p_layout -> 'regions', '[]'::jsonb)) as r(
    id text, name text, kind text, x integer, y integer, w integer, h integer, note text
  )
  on conflict (id) do nothing;
  get diagnostics v_regions = row_count;

  if ws.layout_version = v_version and ws.layout_hash = v_hash then
    update world_state
    set grid_w = v_grid_w, grid_h = v_grid_h
    where singleton and (grid_w is distinct from v_grid_w or grid_h is distinct from v_grid_h);
    return jsonb_build_object(
      'status', 'already_expanded',
      'layoutVersion', ws.layout_version,
      'layoutHash', ws.layout_hash,
      'gridW', v_grid_w,
      'gridH', v_grid_h,
      'regionsInserted', v_regions
    );
  end if;

  if ws.layout_version = v_version then
    return jsonb_build_object(
      'status', 'layout_mismatch',
      'storedVersion', ws.layout_version,
      'storedHash', ws.layout_hash,
      'payloadHash', v_hash
    );
  end if;

  if not (ws.layout_version = any (v_from)) then
    return jsonb_build_object(
      'status', 'layout_mismatch',
      'storedVersion', ws.layout_version,
      'storedHash', ws.layout_hash
    );
  end if;

  select b.id into v_mismatch
  from world_buildings b
  join jsonb_to_recordset(p_layout -> 'buildings') as p(
    id text, x integer, y integer, w integer, h integer, door_x integer, door_y integer
  ) on p.id = b.id
  where b.x <> p.x or b.y <> p.y or b.w <> p.w or b.h <> p.h or b.door_x <> p.door_x or b.door_y <> p.door_y
  limit 1;
  if v_mismatch is not null then
    return jsonb_build_object('status', 'building_mismatch', 'id', v_mismatch);
  end if;

  insert into world_buildings (
    id, layout_version, kind, name, x, y, w, h, door_x, door_y, capacity, job_slots, role,
    open_air, status, construction_progress, batch_shifts
  )
  select
    b.id, v_version, b.kind, b.name, b.x, b.y, b.w, b.h, b.door_x, b.door_y,
    b.capacity, b.job_slots, b.role, coalesce(b.open, false), b.status,
    case when b.status = 'under_construction' then 0 end,
    b.batch_shifts
  from jsonb_to_recordset(p_layout -> 'buildings') as b(
    id text, kind text, name text, x integer, y integer, w integer, h integer,
    door_x integer, door_y integer, capacity integer, job_slots integer, role text,
    open boolean, status text, batch_shifts integer
  )
  on conflict (id) do nothing;
  get diagnostics v_added = row_count;

  update world_buildings set layout_version = v_version where id is not null;

  insert into world_routes (from_id, to_id, steps)
  select r."from", r."to", r.steps
  from jsonb_to_recordset(p_layout -> 'routes') as r("from" text, "to" text, steps integer)
  on conflict (from_id, to_id) do update set steps = excluded.steps;
  get diagnostics v_routes = row_count;

  v_world := world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, p_now);

  update world_state
  set
    layout_version = v_version,
    layout_hash = v_hash,
    grid_w = v_grid_w,
    grid_h = v_grid_h
  where singleton;

  perform world_record_event(
    format('world:expanded:%s', v_version),
    'world.expanded',
    'world',
    'system',
    format(
      'The observable map was expanded to %s×%s tiles. The founding settlement was not moved. New land is undeveloped.',
      v_grid_w,
      v_grid_h
    ),
    null,
    null,
    null,
    p_now,
    v_world,
    ws.tick_seq,
    jsonb_build_object(
      'fromVersion', ws.layout_version,
      'toVersion', v_version,
      'gridW', v_grid_w,
      'gridH', v_grid_h
    )
  );

  return jsonb_build_object(
    'status', 'expanded',
    'fromVersion', ws.layout_version,
    'layoutVersion', v_version,
    'layoutHash', v_hash,
    'gridW', v_grid_w,
    'gridH', v_grid_h,
    'buildingsAdded', v_added,
    'routesUpserted', v_routes,
    'regionsInserted', v_regions
  );
end;
$$;
