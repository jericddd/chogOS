-- Phase 3: the living civilization.
--
-- Additive only. No existing table is dropped, truncated, or recreated.
-- Existing citizens, wallet rows, treasury rows, and history rows are kept.
-- Existing history rows are labeled source = 'system', category = 'membership'.
--
-- The simulation is a fixed rule system, not the AI mind. world_tick() is the
-- only normal writer of world state. Each tick runs in one transaction under an
-- advisory lock, so overlapping schedulers cannot apply a transition twice.
-- Resource and production figures are simulated and are not token balances.

-- World layout ---------------------------------------------------------------

create table world_buildings (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  layout_version text not null,
  kind text not null check (kind in (
    'house', 'hall', 'commons', 'farm', 'forest', 'quarry', 'workshop', 'storehouse', 'market'
  )),
  name text not null check (char_length(name) between 1 and 80),
  x integer not null check (x >= 0),
  y integer not null check (y >= 0),
  w integer not null check (w > 0),
  h integer not null check (h > 0),
  door_x integer not null,
  door_y integer not null,
  capacity integer check (capacity is null or capacity >= 0),
  job_slots integer check (job_slots is null or job_slots >= 0),
  role text check (role is null or role in (
    'farmer', 'woodcutter', 'stonecutter', 'crafter', 'merchant', 'builder'
  )),
  open_air boolean not null default false,
  status text not null check (status in ('active', 'under_construction')),
  construction_progress integer check (construction_progress is null or construction_progress between 0 and 100),
  batch_shifts integer check (batch_shifts is null or batch_shifts > 0),
  production_progress integer not null default 0 check (production_progress >= 0),
  batches_completed integer not null default 0 check (batches_completed >= 0),
  stock jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  updated_tick bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (door_x between x and x + w - 1 and door_y between y and y + h - 1),
  check (status <> 'under_construction' or construction_progress is not null)
);

comment on table world_buildings is
  'Persistent buildings of the chogOS map. Inserted once by world_initialize. stock and production are simulated, not balances.';

create trigger world_buildings_updated_at
  before update on world_buildings
  for each row execute function set_updated_at();

create table world_routes (
  from_id text not null references world_buildings (id) on delete cascade,
  to_id text not null references world_buildings (id) on delete cascade,
  steps integer not null check (steps > 0),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);

comment on table world_routes is
  'Road distance in tiles between building doors, computed from the versioned layout.';

-- World clock ----------------------------------------------------------------

create table world_state (
  singleton boolean primary key default true check (singleton),
  layout_version text not null,
  layout_hash text not null,
  chain_id integer not null check (chain_id in (143, 10143)),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null default 'running' check (status in ('running', 'paused')),
  speed numeric(8, 2) not null check (speed >= 1 and speed <= 1000),
  anchor_real timestamptz not null,
  anchor_world_s bigint not null check (anchor_world_s >= 0),
  walk_world_s_per_tile integer not null default 30 check (walk_world_s_per_tile > 0),
  max_lag_seconds integer not null default 150 check (max_lag_seconds >= 10),
  tick_seq bigint not null default 0,
  last_tick_at timestamptz not null,
  last_tick_world_s bigint not null,
  last_tick_gap_s numeric(10, 2),
  last_tick_processed integer not null default 0,
  last_tick_failed integer not null default 0,
  last_tick_ms integer,
  last_error text,
  last_error_at timestamptz,
  initialized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table world_state is
  'One shared simulation clock. World seconds advance at speed times real seconds while the runner is live. A long runner outage pauses the world instead of replaying it.';

create trigger world_state_updated_at
  before update on world_state
  for each row execute function set_updated_at();

-- Citizen world state --------------------------------------------------------

create table citizen_world_state (
  citizen_id uuid primary key references citizens (id) on delete restrict,
  role text check (role is null or role in (
    'farmer', 'woodcutter', 'stonecutter', 'crafter', 'merchant', 'builder'
  )),
  home_id text references world_buildings (id),
  work_id text references world_buildings (id),
  activity text not null check (activity in (
    'walking', 'working', 'gathering', 'building', 'shopping', 'socializing',
    'resting', 'sleeping', 'idle', 'unavailable'
  )),
  location_id text references world_buildings (id),
  origin_id text references world_buildings (id),
  destination_id text references world_buildings (id),
  purpose text check (purpose is null or purpose in ('work', 'shop', 'socialize', 'rest', 'sleep', 'idle')),
  started_at timestamptz not null,
  ends_at timestamptz,
  world_started_s bigint not null,
  world_ends_s bigint,
  task jsonb not null default '{}'::jsonb,
  day_index integer not null default 0,
  shifts_today integer not null default 0 check (shifts_today between 0 and 2),
  market_visits_today integer not null default 0 check (market_visits_today >= 0),
  decision_source text not null default 'simulation' check (decision_source in ('simulation', 'ai', 'system')),
  version bigint not null default 0,
  updated_tick bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((activity = 'walking') = (destination_id is not null)),
  check (activity <> 'walking' or (origin_id is not null and purpose is not null and ends_at is not null and location_id is null)),
  check (activity in ('walking', 'unavailable') or location_id is not null),
  check (activity <> 'unavailable' or (ends_at is null and location_id is null)),
  check (ends_at is null or ends_at >= started_at),
  check (world_ends_s is null or world_ends_s >= world_started_s),
  check ((ends_at is null) = (world_ends_s is null)),
  check (role is null or work_id is not null)
);

comment on table citizen_world_state is
  'Where each citizen is and what it is doing. One row per existing citizen. Written by world functions only.';

create index citizen_world_state_due
  on citizen_world_state (ends_at)
  where ends_at is not null;

create index citizen_world_state_updated_tick
  on citizen_world_state (updated_tick);

create trigger citizen_world_state_updated_at
  before update on citizen_world_state
  for each row execute function set_updated_at();

-- Phase 4 seam. Nothing in Phase 3 writes intents. A future AI process inserts
-- a pending intent through the service role; world_tick validates it with the
-- same rules as the simulation and records accepted or rejected.
create table world_intents (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  action text not null check (action in ('work', 'shop', 'socialize', 'rest', 'sleep')),
  building_id text not null references world_buildings (id),
  source text not null check (source in ('ai', 'system')),
  decision_id uuid references ai_decisions (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'expired')),
  reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  resolved_at timestamptz
);

create unique index world_intents_one_pending
  on world_intents (citizen_id)
  where status = 'pending';

comment on table world_intents is
  'Proposed citizen actions. Validated by world_tick before any state changes. Unused until the AI mind exists.';

-- History --------------------------------------------------------------------

alter table civilization_events
  add column seq bigint generated by default as identity,
  add column source text not null default 'system'
    check (source in ('simulation', 'ai', 'onchain', 'system')),
  add column category text not null default 'membership' check (category in (
    'membership', 'citizen', 'movement', 'work', 'resource', 'construction', 'social', 'world', 'ai', 'onchain'
  )),
  add column building_id text references world_buildings (id) on delete set null,
  add column related_citizen_id uuid references citizens (id) on delete set null,
  add column world_s bigint check (world_s is null or world_s >= 0),
  add column tick_seq bigint,
  add column schema_version smallint not null default 1;

comment on column civilization_events.source is
  'simulation: rule-based world transition. system: setup or synchronization. ai: a decision by the AI mind. onchain: verified against Monad.';
comment on column civilization_events.world_s is
  'In-world seconds since Day 1 00:00 when the event happened. occurred_at and created_at stay real UTC times.';

create unique index civilization_events_seq on civilization_events (seq);
create index civilization_events_actor_seq on civilization_events (actor_citizen_id, seq desc);
create index civilization_events_related_seq on civilization_events (related_citizen_id, seq desc)
  where related_citizen_id is not null;
create index civilization_events_building_seq on civilization_events (building_id, seq desc);
create index civilization_events_category_seq on civilization_events (category, seq desc);
create index civilization_events_source_seq on civilization_events (source, seq desc);

-- Pure helpers -----------------------------------------------------------------

create function world_s_at(p_anchor_real timestamptz, p_anchor_world bigint, p_speed numeric, p_t timestamptz)
returns bigint
language sql
immutable
as $$
  select p_anchor_world + floor(extract(epoch from (p_t - p_anchor_real)) * p_speed)::bigint
$$;

create function world_real_at(p_anchor_real timestamptz, p_anchor_world bigint, p_speed numeric, p_world bigint)
returns timestamptz
language sql
immutable
as $$
  select p_anchor_real + make_interval(secs => ((p_world - p_anchor_world)::numeric / p_speed)::double precision)
$$;

create function world_hour(p_world bigint)
returns numeric
language sql
immutable
as $$
  select (p_world % 86400)::numeric / 3600
$$;

create function world_day(p_world bigint)
returns integer
language sql
immutable
as $$
  select (p_world / 86400)::integer + 1
$$;

create function world_roll(p_citizen uuid, p_version bigint, p_salt text)
returns integer
language sql
immutable
as $$
  select (('x' || substr(md5(p_citizen::text || ':' || p_version::text || ':' || p_salt), 1, 7))::bit(28)::integer % 1000)
$$;

create function world_work_activity(p_role text)
returns text
language sql
immutable
as $$
  select case
    when p_role in ('farmer', 'woodcutter', 'stonecutter') then 'gathering'
    when p_role = 'builder' then 'building'
    else 'working'
  end
$$;

create function world_action_activity(p_action text, p_role text)
returns text
language sql
immutable
as $$
  select case p_action
    when 'work' then world_work_activity(p_role)
    when 'shop' then 'shopping'
    when 'socialize' then 'socializing'
    when 'rest' then 'resting'
    when 'sleep' then 'sleeping'
    else 'idle'
  end
$$;

-- Minutes a citizen's day is shifted from the earliest schedule, 0 to 210.
-- Early citizens sleep at 21:00 and wake near 04:30. Late citizens stay up
-- until about 00:30 and wake near 08:00. Fixed per citizen, so it is reproducible.
create function world_chronotype(p_citizen uuid)
returns integer
language sql
immutable
as $$
  select world_roll(p_citizen, 0, 'chronotype') % 211
$$;

create function world_bedtime(p_citizen uuid)
returns numeric
language sql
immutable
as $$
  select 21 + world_chronotype(p_citizen)::numeric / 60
$$;

-- World seconds an activity lasts. Work is 4h to 4h30, a market visit 40 to
-- 70 minutes, socializing 60 to 120 minutes, rest 75 to 150 minutes, and
-- sleep lasts until the citizen's wake time between 04:30 and 08:30.
create function world_duration(p_action text, p_roll integer, p_world bigint, p_chrono integer)
returns bigint
language plpgsql
immutable
as $$
declare
  v_day_start bigint := (p_world / 86400) * 86400;
  v_of_day bigint := p_world % 86400;
  v_wake bigint := 16200 + p_chrono * 60 + (p_roll % 31) * 60;
  v_end bigint;
begin
  case p_action
    when 'work' then return 14400 + (p_roll % 31) * 60;
    when 'shop' then return 2400 + (p_roll % 31) * 60;
    when 'socialize' then return 3600 + (p_roll % 61) * 60;
    when 'rest' then return 4500 + (p_roll % 76) * 60;
    when 'idle' then return 600;
    when 'sleep' then
      if v_of_day < v_wake and v_of_day < 43200 then
        v_end := v_day_start + v_wake;
      else
        v_end := v_day_start + 86400 + v_wake;
      end if;
      return greatest(1800, v_end - p_world);
    else
      raise exception 'unknown action %', p_action;
  end case;
end;
$$;

create function world_citizen_label(p_citizen uuid)
returns text
language sql
stable
as $$
  select coalesce(nullif(trim(metadata_name), ''), 'Chog #' || token_id::text)
  from citizens
  where id = p_citizen
$$;

create function world_building_name(p_building text)
returns text
language sql
stable
as $$
  select name from world_buildings where id = p_building
$$;

-- Event writer ---------------------------------------------------------------

create function world_record_event(
  p_dedupe text,
  p_kind text,
  p_category text,
  p_source text,
  p_summary text,
  p_citizen uuid,
  p_building text,
  p_related uuid,
  p_occurred timestamptz,
  p_world bigint,
  p_tick bigint,
  p_payload jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_id uuid;
begin
  if p_citizen is not null then
    v_payload := v_payload || jsonb_build_object(
      'tokenId', (select token_id::text from citizens where id = p_citizen)
    );
  end if;
  if p_related is not null then
    v_payload := v_payload || jsonb_build_object(
      'relatedTokenId', (select token_id::text from citizens where id = p_related)
    );
  end if;
  if p_building is not null then
    v_payload := v_payload || jsonb_build_object('buildingName', world_building_name(p_building));
  end if;

  insert into civilization_events (
    dedupe_key, kind, category, source, summary, actor_citizen_id, building_id,
    related_citizen_id, occurred_at, world_s, tick_seq, chain_status, payload, schema_version
  )
  values (
    p_dedupe, p_kind, p_category, p_source, p_summary, p_citizen, p_building,
    p_related, p_occurred, p_world, p_tick, 'offchain', v_payload, 1
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Clock re-anchoring ---------------------------------------------------------

-- Moves the real-time projection of every scheduled activity so that world
-- time continues from p_world at p_now. World timestamps are not changed.
create function world_reanchor(p_now timestamptz, p_world bigint, p_speed numeric)
returns void
language plpgsql
as $$
begin
  update world_state
  set anchor_real = p_now, anchor_world_s = p_world, speed = p_speed
  where singleton;

  update citizen_world_state
  set
    started_at = world_real_at(p_now, p_world, p_speed, world_started_s),
    ends_at = case
      when world_ends_s is null then null
      else world_real_at(p_now, p_world, p_speed, world_ends_s)
    end
  where activity <> 'unavailable';
end;
$$;

-- Storehouse -----------------------------------------------------------------

-- Adds p_delta of a simulated resource, clamped to 0..400. Returns the applied change.
create function world_store(p_resource text, p_delta integer, p_tick bigint)
returns integer
language plpgsql
as $$
declare
  v_now integer;
  v_new integer;
begin
  select coalesce((stock ->> p_resource)::integer, 0)
  into v_now
  from world_buildings
  where id = 'storehouse'
  for update;
  if not found then
    raise exception 'the storehouse is missing';
  end if;
  v_new := greatest(0, least(400, v_now + p_delta));
  if v_new <> v_now then
    update world_buildings
    set stock = jsonb_set(stock, array[p_resource], to_jsonb(v_new), true), updated_tick = p_tick
    where id = 'storehouse';
  end if;
  return v_new - v_now;
end;
$$;

create function world_stock(p_resource text)
returns integer
language sql
stable
as $$
  select coalesce((stock ->> p_resource)::integer, 0) from world_buildings where id = 'storehouse'
$$;

-- Validation -----------------------------------------------------------------

-- Returns null when the action is allowed now, otherwise the reason it is not.
-- Every rule-based choice and every future AI intent passes through here.
create function world_check_action(p_citizen uuid, p_action text, p_building text, p_world bigint)
returns text
language plpgsql
stable
as $$
declare
  c citizen_world_state%rowtype;
  b world_buildings%rowtype;
  v_hour numeric := world_hour(p_world);
begin
  select * into c from citizen_world_state where citizen_id = p_citizen;
  if not found then
    return 'citizen has no world state';
  end if;
  if c.activity = 'unavailable' then
    return 'citizen is unavailable';
  end if;
  select * into b from world_buildings where id = p_building;
  if not found then
    return 'unknown building';
  end if;

  case p_action
    when 'work' then
      if c.role is null then
        return 'citizen has no job';
      end if;
      if c.work_id is distinct from b.id then
        return 'citizen is not assigned to this building';
      end if;
      if b.role is distinct from c.role then
        return 'this building does not offer that job';
      end if;
      if v_hour < 5 or v_hour >= 18 then
        return 'outside working hours';
      end if;
      if c.day_index = world_day(p_world) and c.shifts_today >= 2 then
        return 'two shifts already worked today';
      end if;
      if c.role = 'builder' then
        if b.status <> 'under_construction' then
          return 'nothing left to build here';
        end if;
        if world_stock('wood') < 3 or world_stock('stone') < 2 then
          return 'not enough wood and stone in the Storehouse';
        end if;
      elsif b.status <> 'active' then
        return 'building is not complete';
      end if;
      if c.role = 'crafter' and world_stock('wood') < 2 then
        return 'not enough wood in the Storehouse';
      end if;
    when 'shop' then
      if b.kind <> 'market' then
        return 'not a market';
      end if;
      if v_hour < 7 or v_hour >= 20 then
        return 'the market is closed';
      end if;
    when 'socialize' then
      if b.kind <> 'commons' then
        return 'not a public space';
      end if;
      if v_hour < 7 then
        return 'too early to gather';
      end if;
    when 'rest', 'sleep' then
      if c.home_id is not null then
        if b.id <> c.home_id then
          return 'not this citizen''s home';
        end if;
      elsif b.kind <> 'hall' then
        return 'a citizen without a home rests at Commons Hall';
      end if;
    when 'idle' then
      if b.kind <> 'commons' then
        return 'idle citizens wait at Commons Square';
      end if;
    else
      return 'unknown action';
  end case;
  return null;
end;
$$;

-- Decision -------------------------------------------------------------------

create function world_choose_action(
  p_citizen uuid,
  p_world bigint,
  out action text,
  out building text,
  out source text,
  out intent_id uuid
)
language plpgsql
as $$
declare
  c citizen_world_state%rowtype;
  i world_intents%rowtype;
  v_reason text;
  v_hour numeric := world_hour(p_world);
  v_day integer := world_day(p_world);
  v_shifts integer;
  v_visits integer;
  v_last text;
  v_roll integer;
  v_rest text;
  v_bed numeric := world_bedtime(p_citizen);
begin
  select * into c from citizen_world_state where citizen_id = p_citizen;
  v_rest := coalesce(c.home_id, 'commons-hall');

  select * into i
  from world_intents
  where citizen_id = p_citizen and status = 'pending'
  order by created_at
  limit 1
  for update;
  if found then
    if i.expires_at is not null and i.expires_at < now() then
      update world_intents set status = 'expired', resolved_at = now() where id = i.id;
    else
      v_reason := world_check_action(p_citizen, i.action, i.building_id, p_world);
      if v_reason is null then
        update world_intents set status = 'accepted', resolved_at = now() where id = i.id;
        action := i.action;
        building := i.building_id;
        source := i.source;
        intent_id := i.id;
        return;
      end if;
      update world_intents set status = 'rejected', reason = v_reason, resolved_at = now() where id = i.id;
    end if;
  end if;

  source := 'simulation';
  v_shifts := case when c.day_index = v_day then c.shifts_today else 0 end;
  v_visits := case when c.day_index = v_day then c.market_visits_today else 0 end;
  v_last := c.task ->> 'action';
  v_roll := world_roll(p_citizen, c.version, 'choose');

  if v_hour >= v_bed or v_hour < 4.5 then
    action := 'sleep';
    building := v_rest;
    return;
  end if;

  if c.role is not null and v_shifts < 2 and v_hour < 17 and (v_shifts = 0 or v_last is distinct from 'work') then
    if world_check_action(p_citizen, 'work', c.work_id, p_world) is null then
      action := 'work';
      building := c.work_id;
      return;
    end if;
  end if;

  if v_last = 'work' and v_shifts = 1 and v_hour < 17 then
    if v_visits < 1 and world_check_action(p_citizen, 'shop', 'market', p_world) is null then
      action := 'shop';
      building := 'market';
      return;
    end if;
    action := 'rest';
    building := v_rest;
    return;
  end if;

  if v_hour >= v_bed - 1.5 and v_roll >= 500 then
    action := 'rest';
    building := v_rest;
    return;
  end if;

  if v_roll < 450 and v_last is distinct from 'socialize'
    and world_check_action(p_citizen, 'socialize', 'commons-square', p_world) is null then
    action := 'socialize';
    building := 'commons-square';
    return;
  end if;

  if v_roll < 800 and v_visits < 1 and v_last is distinct from 'shop'
    and world_check_action(p_citizen, 'shop', 'market', p_world) is null then
    action := 'shop';
    building := 'market';
    return;
  end if;

  if v_last is distinct from 'rest' or v_roll >= 800 then
    action := 'rest';
    building := v_rest;
    return;
  end if;

  if world_check_action(p_citizen, 'socialize', 'commons-square', p_world) is null then
    action := 'socialize';
    building := 'commons-square';
    return;
  end if;

  action := 'rest';
  building := v_rest;
end;
$$;

-- Transitions ----------------------------------------------------------------

create function world_go(
  p_citizen uuid,
  p_action text,
  p_building text,
  p_t timestamptz,
  p_world bigint,
  p_tick bigint,
  p_source text,
  p_intent uuid
)
returns void
language plpgsql
as $$
declare
  c citizen_world_state%rowtype;
  ws world_state%rowtype;
  v_steps integer;
  v_ends bigint;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen for update;
  if c.location_id = p_building then
    perform world_begin(p_citizen, p_action, p_building, p_t, p_world, p_tick, p_source, false);
    return;
  end if;

  select * into ws from world_state where singleton;
  select steps into v_steps from world_routes where from_id = c.location_id and to_id = p_building;
  if v_steps is null then
    raise exception 'no road from % to %', c.location_id, p_building;
  end if;
  v_ends := p_world + v_steps * ws.walk_world_s_per_tile;

  update citizen_world_state
  set
    activity = 'walking',
    origin_id = c.location_id,
    location_id = null,
    destination_id = p_building,
    purpose = p_action,
    started_at = p_t,
    ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_ends),
    world_started_s = p_world,
    world_ends_s = v_ends,
    task = jsonb_strip_nulls(jsonb_build_object(
      'action', p_action, 'building', p_building, 'steps', v_steps, 'intent', p_intent
    )),
    decision_source = p_source,
    version = c.version + 1,
    updated_tick = p_tick
  where citizen_id = p_citizen;
end;
$$;

create function world_begin(
  p_citizen uuid,
  p_action text,
  p_building text,
  p_t timestamptz,
  p_world bigint,
  p_tick bigint,
  p_source text,
  p_arrived boolean
)
returns void
language plpgsql
as $$
declare
  c citizen_world_state%rowtype;
  ws world_state%rowtype;
  v_reason text;
  v_rest text;
  v_fallback text;
  v_day integer := world_day(p_world);
  v_shifts integer;
  v_visits integer;
  v_roll integer;
  v_duration bigint;
  v_activity text;
  v_label text;
  v_place text;
  v_kind text;
  v_category text;
  v_summary text;
  v_payload jsonb := '{}'::jsonb;
  v_related uuid;
  v_food integer;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen for update;
  select * into ws from world_state where singleton;

  v_reason := world_check_action(p_citizen, p_action, p_building, p_world);
  if v_reason is not null then
    v_rest := coalesce(c.home_id, 'commons-hall');
    if p_action in ('rest', 'sleep') and p_building = v_rest then
      raise exception 'citizen % cannot rest at %: %', p_citizen, p_building, v_reason;
    end if;
    v_fallback := case
      when p_action = 'sleep' or world_hour(p_world) >= world_bedtime(p_citizen) or world_hour(p_world) < 4.5 then 'sleep'
      else 'rest'
    end;
    perform world_go(p_citizen, v_fallback, v_rest, p_t, p_world, p_tick, 'simulation', null);
    return;
  end if;

  v_shifts := case when c.day_index = v_day then c.shifts_today else 0 end;
  v_visits := case when c.day_index = v_day then c.market_visits_today else 0 end;
  v_roll := world_roll(p_citizen, c.version + 1, 'duration');
  v_duration := world_duration(p_action, v_roll, p_world, world_chronotype(p_citizen));
  v_activity := world_action_activity(p_action, c.role);
  v_label := world_citizen_label(p_citizen);
  v_place := world_building_name(p_building);

  if p_action = 'work' then
    v_shifts := v_shifts + 1;
    if c.role = 'crafter' then
      perform world_store('wood', -2, p_tick);
      v_payload := jsonb_build_object('consumed', jsonb_build_object('wood', 2));
    elsif c.role = 'builder' then
      perform world_store('wood', -3, p_tick);
      perform world_store('stone', -2, p_tick);
      v_payload := jsonb_build_object('consumed', jsonb_build_object('wood', 3, 'stone', 2));
    end if;
    v_payload := v_payload || jsonb_build_object('shift', v_shifts, 'role', c.role);
    case c.role
      when 'farmer' then
        v_kind := 'resource.farming_started';
        v_category := 'resource';
        v_summary := format('%s began tending the fields at %s.', v_label, v_place);
      when 'woodcutter' then
        v_kind := 'resource.gathering_started';
        v_category := 'resource';
        v_summary := format('%s began cutting wood at %s.', v_label, v_place);
        v_payload := v_payload || jsonb_build_object('resource', 'wood');
      when 'stonecutter' then
        v_kind := 'resource.gathering_started';
        v_category := 'resource';
        v_summary := format('%s began cutting stone at %s.', v_label, v_place);
        v_payload := v_payload || jsonb_build_object('resource', 'stone');
      when 'builder' then
        v_kind := 'construction.work_started';
        v_category := 'construction';
        v_summary := format('%s began building %s.', v_label, v_place);
      when 'merchant' then
        v_kind := 'work.shift_started';
        v_category := 'work';
        v_summary := format('%s opened a stall at the %s.', v_label, v_place);
      else
        v_kind := 'work.shift_started';
        v_category := 'work';
        v_summary := format('%s began a shift at %s.', v_label, v_place);
    end case;
  elsif p_action = 'shop' then
    v_visits := v_visits + 1;
    v_food := -world_store('food', -1, p_tick);
    v_kind := 'citizen.market_visit';
    v_category := 'citizen';
    v_payload := jsonb_build_object('foodTaken', v_food);
    v_summary := case
      when v_food > 0 then format('%s visited the %s and took a simulated food ration.', v_label, v_place)
      else format('%s visited the %s. The Storehouse had no food.', v_label, v_place)
    end;
  elsif p_action = 'socialize' then
    select citizen_id into v_related
    from citizen_world_state
    where activity = 'socializing' and location_id = p_building and citizen_id <> p_citizen
    order by world_started_s desc, citizen_id
    limit 1;
    v_category := 'social';
    if v_related is not null then
      v_kind := 'social.met';
      v_summary := format('%s met %s at %s.', v_label, world_citizen_label(v_related), v_place);
    else
      v_kind := 'social.gathered';
      v_summary := format('%s came to %s to socialize.', v_label, v_place);
    end if;
  elsif p_action = 'rest' then
    if p_arrived then
      v_kind := 'movement.arrived_home';
      v_category := 'movement';
      v_summary := case
        when c.home_id is null then format('%s arrived at %s to rest. No home is assigned yet.', v_label, v_place)
        else format('%s arrived home at %s.', v_label, v_place)
      end;
    end if;
  elsif p_action = 'sleep' then
    v_kind := 'citizen.sleep';
    v_category := 'citizen';
    v_summary := format('%s went to sleep at %s.', v_label, v_place);
  else
    v_kind := 'citizen.idle';
    v_category := 'citizen';
    v_summary := format('%s is waiting at %s.', v_label, v_place);
  end if;

  update citizen_world_state
  set
    activity = v_activity,
    location_id = p_building,
    origin_id = null,
    destination_id = null,
    purpose = null,
    started_at = p_t,
    ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, p_world + v_duration),
    world_started_s = p_world,
    world_ends_s = p_world + v_duration,
    task = jsonb_strip_nulls(jsonb_build_object(
      'action', p_action, 'building', p_building, 'shift', case when p_action = 'work' then v_shifts end
    )),
    day_index = v_day,
    shifts_today = v_shifts,
    market_visits_today = v_visits,
    decision_source = p_source,
    version = c.version + 1,
    updated_tick = p_tick
  where citizen_id = p_citizen;

  if v_kind is null then
    return;
  end if;

  perform world_record_event(
    format('sim:%s:%s:%s', p_citizen, c.version + 1, v_kind),
    v_kind,
    v_category,
    p_source,
    v_summary,
    p_citizen,
    p_building,
    v_related,
    p_t,
    p_world,
    p_tick,
    v_payload || jsonb_build_object(
      'action', p_action,
      'activity', v_activity,
      'durationWorldMinutes', v_duration / 60,
      'arrived', p_arrived
    )
  );
end;
$$;

-- Applies the effects of a finished activity. Only work has effects.
create function world_complete(p_citizen uuid, p_t timestamptz, p_world bigint, p_tick bigint)
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

  perform world_record_event(
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
    jsonb_build_object('shift', (c.task ->> 'shift')::integer, 'role', c.role, 'activity', c.activity)
  );

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
      jsonb_build_object('capacity', b.capacity, 'nextSite', v_next)
    );

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

-- Processes the one transition that is due for this citizen, at its scheduled time.
create function world_step(p_citizen uuid, p_tick bigint)
returns void
language plpgsql
as $$
declare
  c citizen_world_state%rowtype;
  v_choice record;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen for update;
  if c.ends_at is null or c.activity = 'unavailable' then
    return;
  end if;

  if c.activity = 'walking' then
    update citizen_world_state
    set activity = 'idle', location_id = c.destination_id, origin_id = null, destination_id = null, purpose = null
    where citizen_id = p_citizen;
    perform world_begin(p_citizen, c.purpose, c.destination_id, c.ends_at, c.world_ends_s, p_tick, c.decision_source, true);
    return;
  end if;

  perform world_complete(p_citizen, c.ends_at, c.world_ends_s, p_tick);
  select * into v_choice from world_choose_action(p_citizen, c.world_ends_s);
  perform world_go(
    p_citizen, v_choice.action, v_choice.building, c.ends_at, c.world_ends_s, p_tick, v_choice.source, v_choice.intent_id
  );
end;
$$;

-- Population -----------------------------------------------------------------

create function world_eligible(p_chain integer, p_contract text)
returns table (citizen_id uuid)
language sql
stable
as $$
  select id
  from citizens
  where chain_id = p_chain
    and lower(nft_contract) = lower(p_contract)
    and enrollment_status = 'active'
    and (origin = 'community' or founding_membership_active)
$$;

create function world_open_home()
returns text
language sql
stable
as $$
  select b.id
  from world_buildings b
  where b.kind = 'house' and b.status = 'active'
    and (select count(*) from citizen_world_state s where s.home_id = b.id) < coalesce(b.capacity, 0)
  order by b.id
  limit 1
$$;

create function world_open_job(out building text, out role text)
language sql
stable
as $$
  select b.id, b.role
  from world_buildings b
  where b.role is not null
    and (
      (b.role <> 'builder' and b.status = 'active')
      or (b.role = 'builder' and b.id = (
        select id from world_buildings where status = 'under_construction' order by id limit 1
      ))
    )
    and (select count(*) from citizen_world_state s where s.work_id = b.id) < coalesce(b.job_slots, 0)
  order by (select count(*) from citizen_world_state s where s.work_id = b.id), b.id
  limit 1
$$;

-- Adds newly eligible citizens and marks citizens who lost eligibility. Never deletes rows.
create function world_sync_population(p_now timestamptz, p_tick bigint)
returns integer
language plpgsql
as $$
declare
  ws world_state%rowtype;
  v_world bigint;
  v_row record;
  v_home text;
  v_job record;
  v_changes integer := 0;
  v_ends bigint;
begin
  select * into ws from world_state where singleton;
  v_world := world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, p_now);
  v_ends := v_world + 600;

  for v_row in
    select s.citizen_id
    from citizen_world_state s
    where s.activity <> 'unavailable'
      and s.citizen_id not in (select citizen_id from world_eligible(ws.chain_id, ws.nft_contract))
    order by s.citizen_id
  loop
    update citizen_world_state
    set
      activity = 'unavailable', location_id = null, origin_id = null, destination_id = null, purpose = null,
      ends_at = null, world_ends_s = null, started_at = p_now, world_started_s = v_world,
      home_id = null, work_id = null, role = null, task = '{}'::jsonb, decision_source = 'system',
      version = version + 1, updated_tick = p_tick
    where citizen_id = v_row.citizen_id;
    perform world_record_event(
      format('system:%s:unavailable:%s', v_row.citizen_id, p_tick),
      'citizen.unavailable',
      'citizen',
      'system',
      format('%s is no longer an active citizen record, so it left the world map.', world_citizen_label(v_row.citizen_id)),
      v_row.citizen_id, null, null, p_now, v_world, p_tick, '{}'::jsonb
    );
    v_changes := v_changes + 1;
  end loop;

  for v_row in
    select e.citizen_id, s.citizen_id is not null as is_return
    from world_eligible(ws.chain_id, ws.nft_contract) e
    left join citizen_world_state s on s.citizen_id = e.citizen_id
    where s.citizen_id is null or s.activity = 'unavailable'
    order by e.citizen_id
  loop
    v_home := world_open_home();
    select * into v_job from world_open_job();
    if v_row.is_return then
      update citizen_world_state
      set
        activity = 'idle', location_id = 'commons-square', home_id = v_home, work_id = v_job.building,
        role = v_job.role, started_at = p_now, world_started_s = v_world,
        ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_ends), world_ends_s = v_ends,
        task = '{"action":"idle","building":"commons-square"}'::jsonb, decision_source = 'system',
        version = version + 1, updated_tick = p_tick
      where citizen_id = v_row.citizen_id;
    else
      insert into citizen_world_state (
        citizen_id, role, home_id, work_id, activity, location_id, started_at, ends_at,
        world_started_s, world_ends_s, task, day_index, decision_source, version, updated_tick
      )
      values (
        v_row.citizen_id, v_job.role, v_home, v_job.building, 'idle', 'commons-square', p_now,
        world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_ends), v_world, v_ends,
        '{"action":"idle","building":"commons-square"}'::jsonb, world_day(v_world), 'system', 1, p_tick
      );
    end if;
    perform world_record_event(
      format('system:%s:joined:%s', v_row.citizen_id, p_tick),
      case when v_row.is_return then 'citizen.returned' else 'citizen.joined_world' end,
      'citizen',
      'system',
      format('%s arrived at Commons Square as a verified citizen.', world_citizen_label(v_row.citizen_id)),
      v_row.citizen_id, 'commons-square', null, p_now, v_world, p_tick,
      jsonb_strip_nulls(jsonb_build_object('home', v_home, 'work', v_job.building, 'role', v_job.role))
    );
    v_changes := v_changes + 1;
  end loop;

  return v_changes;
end;
$$;

-- Tick -----------------------------------------------------------------------

create function world_tick_at(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_tick bigint;
  v_gap numeric;
  v_resumed boolean := false;
  v_processed integer := 0;
  v_failed integer := 0;
  v_joined integer := 0;
  v_citizen uuid;
  v_error text;
  v_retry bigint;
  v_started timestamptz := clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtext('chogos.world_tick')) then
    return jsonb_build_object('status', 'busy');
  end if;

  select * into ws from world_state where singleton for update;
  if not found then
    return jsonb_build_object('status', 'not_initialized');
  end if;
  if ws.status = 'paused' then
    return jsonb_build_object('status', 'paused', 'tick', ws.tick_seq);
  end if;
  if p_now < ws.last_tick_at + interval '1 second' then
    return jsonb_build_object('status', 'too_soon', 'tick', ws.tick_seq);
  end if;

  v_tick := ws.tick_seq + 1;
  v_gap := extract(epoch from (p_now - ws.last_tick_at));

  if v_gap > ws.max_lag_seconds then
    perform world_reanchor(p_now, ws.last_tick_world_s, ws.speed);
    perform world_record_event(
      format('system:world.resumed:%s', v_tick),
      'world.resumed',
      'world',
      'system',
      format('The simulation runner resumed after %s seconds offline. The world was paused, not replayed.', round(v_gap)),
      null, null, null, p_now, ws.last_tick_world_s, v_tick,
      jsonb_build_object('offlineSeconds', round(v_gap), 'reason', 'runner_gap')
    );
    select * into ws from world_state where singleton;
    v_resumed := true;
  end if;

  v_joined := world_sync_population(p_now, v_tick);

  loop
    exit when v_processed + v_failed >= 600;
    select citizen_id into v_citizen
    from citizen_world_state
    where ends_at is not null and ends_at <= p_now and activity <> 'unavailable'
    order by ends_at, citizen_id
    limit 1;
    exit when not found;
    begin
      perform world_step(v_citizen, v_tick);
      v_processed := v_processed + 1;
    exception when others then
      get stacked diagnostics v_error = message_text;
      v_failed := v_failed + 1;
      v_retry := world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, p_now + interval '30 seconds');
      update citizen_world_state
      set
        ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_retry),
        world_ends_s = greatest(world_started_s, v_retry)
      where citizen_id = v_citizen;
    end;
  end loop;

  update world_state
  set
    tick_seq = v_tick,
    last_tick_gap_s = v_gap,
    last_tick_at = p_now,
    last_tick_world_s = world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, p_now),
    last_tick_processed = v_processed,
    last_tick_failed = v_failed,
    last_tick_ms = (extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer,
    last_error = case when v_failed > 0 then left(v_error, 500) else last_error end,
    last_error_at = case when v_failed > 0 then p_now else last_error_at end
  where singleton;

  if v_processed + v_joined > 0 or v_resumed then
    begin
      if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
        execute 'select realtime.send($1, $2, $3, false)'
        using jsonb_build_object('tick', v_tick, 'processed', v_processed), 'tick', 'chogos-world';
      end if;
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'tick', v_tick,
    'processed', v_processed,
    'failed', v_failed,
    'joined', v_joined,
    'resumed', v_resumed
  );
end;
$$;

create function world_tick()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select world_tick_at(now())
$$;

-- Initialization -------------------------------------------------------------

create function world_initialize_at(
  p_layout jsonb,
  p_chain_id integer,
  p_nft_contract text,
  p_speed numeric,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_start bigint := 5 * 3600 + 40 * 60;
  v_count integer;
  v_housed integer;
  v_employed integer;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.world_tick'));

  select * into ws from world_state where singleton;
  if found then
    if ws.layout_version <> p_layout ->> 'version' or ws.layout_hash <> p_layout ->> 'hash' then
      return jsonb_build_object(
        'status', 'layout_mismatch',
        'storedVersion', ws.layout_version,
        'storedHash', ws.layout_hash
      );
    end if;
    return jsonb_build_object('status', 'already_initialized', 'initializedAt', ws.initialized_at);
  end if;

  if p_layout ->> 'version' is null or jsonb_typeof(p_layout -> 'buildings') <> 'array' then
    raise exception 'layout payload is missing a version or buildings';
  end if;

  insert into world_buildings (
    id, layout_version, kind, name, x, y, w, h, door_x, door_y, capacity, job_slots, role,
    open_air, status, construction_progress, batch_shifts
  )
  select
    b.id, p_layout ->> 'version', b.kind, b.name, b.x, b.y, b.w, b.h, b.door_x, b.door_y,
    b.capacity, b.job_slots, b.role, coalesce(b.open, false), b.status,
    case when b.status = 'under_construction' then 0 end,
    b.batch_shifts
  from jsonb_to_recordset(p_layout -> 'buildings') as b(
    id text, kind text, name text, x integer, y integer, w integer, h integer,
    door_x integer, door_y integer, capacity integer, job_slots integer, role text,
    open boolean, status text, batch_shifts integer
  )
  on conflict (id) do nothing;

  if not exists (select 1 from world_buildings where id = 'storehouse')
    or not exists (select 1 from world_buildings where id = 'commons-hall')
    or not exists (select 1 from world_buildings where id = 'commons-square')
    or not exists (select 1 from world_buildings where id = 'market') then
    raise exception 'layout must include storehouse, commons-hall, commons-square, and market';
  end if;

  update world_buildings
  set stock = '{"food": 80, "wood": 60, "stone": 40, "tools": 0}'::jsonb
  where id = 'storehouse';

  insert into world_routes (from_id, to_id, steps)
  select r."from", r."to", r.steps
  from jsonb_to_recordset(p_layout -> 'routes') as r("from" text, "to" text, steps integer)
  on conflict do nothing;

  insert into world_state (
    layout_version, layout_hash, chain_id, nft_contract, status, speed, anchor_real, anchor_world_s,
    last_tick_at, last_tick_world_s, initialized_at
  )
  values (
    p_layout ->> 'version', p_layout ->> 'hash', p_chain_id, p_nft_contract, 'running', p_speed, p_now, v_start,
    p_now, v_start, p_now
  );

  with eligible as (
    select
      e.citizen_id as id,
      row_number() over (order by md5(e.citizen_id::text || ':home')) as home_rank,
      row_number() over (order by md5(e.citizen_id::text || ':job')) as job_rank
    from world_eligible(p_chain_id, p_nft_contract) e
  ),
  beds as (
    select b.id as building_id, row_number() over (order by b.id, g) as rank
    from world_buildings b
    cross join lateral generate_series(1, coalesce(b.capacity, 0)) g
    where b.kind = 'house' and b.status = 'active'
  ),
  jobs as (
    select b.id as building_id, b.role, row_number() over (order by g, b.id) as rank
    from world_buildings b
    cross join lateral generate_series(1, coalesce(b.job_slots, 0)) g
    where b.role is not null
      and (
        (b.role <> 'builder' and b.status = 'active')
        or (b.role = 'builder' and b.id = (
          select id from world_buildings where status = 'under_construction' order by id limit 1
        ))
      )
  ),
  placed as (
    select
      e.id,
      j.role,
      bd.building_id as home_id,
      j.building_id as work_id,
      v_start + 300 + (world_roll(e.id, 0, 'wake') % 80) * 60 as wake
    from eligible e
    left join beds bd on bd.rank = e.home_rank
    left join jobs j on j.rank = e.job_rank
  )
  insert into citizen_world_state (
    citizen_id, role, home_id, work_id, activity, location_id, started_at, ends_at,
    world_started_s, world_ends_s, task, day_index, decision_source, version, updated_tick
  )
  select
    p.id, p.role, p.home_id, p.work_id, 'sleeping', coalesce(p.home_id, 'commons-hall'), p_now,
    world_real_at(p_now, v_start, p_speed, p.wake), v_start, p.wake,
    jsonb_build_object('action', 'sleep', 'building', coalesce(p.home_id, 'commons-hall'), 'initial', true),
    world_day(v_start), 'system', 0, 0
  from placed p;

  select count(*), count(home_id), count(work_id)
  into v_count, v_housed, v_employed
  from citizen_world_state;

  perform world_record_event(
    format('world:initialized:%s', p_layout ->> 'version'),
    'world.initialized',
    'world',
    'system',
    format(
      'The chogOS world was laid out with %s buildings. %s verified citizens were placed: %s in houses, %s sheltering at Commons Hall, %s with a job.',
      (select count(*) from world_buildings), v_count, v_housed, v_count - v_housed, v_employed
    ),
    null, null, null, p_now, v_start, 0,
    jsonb_build_object(
      'layoutVersion', p_layout ->> 'version',
      'buildings', (select count(*) from world_buildings),
      'citizens', v_count,
      'housed', v_housed,
      'employed', v_employed,
      'speed', p_speed,
      'initialStock', (select stock from world_buildings where id = 'storehouse')
    )
  );

  return jsonb_build_object(
    'status', 'initialized',
    'citizens', v_count,
    'housed', v_housed,
    'employed', v_employed
  );
end;
$$;

create function world_initialize(p_layout jsonb, p_chain_id integer, p_nft_contract text, p_speed numeric)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select world_initialize_at(p_layout, p_chain_id, p_nft_contract, p_speed, now())
$$;

-- Operator controls. Service role only. Not exposed through any public route.

create function world_set_speed(p_speed numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_world bigint;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.world_tick'));
  select * into ws from world_state where singleton for update;
  if not found then
    return jsonb_build_object('status', 'not_initialized');
  end if;
  if p_speed < 1 or p_speed > 1000 then
    raise exception 'speed must be between 1 and 1000';
  end if;
  v_world := world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, now());
  perform world_reanchor(now(), v_world, p_speed);
  perform world_record_event(
    format('system:world.speed_changed:%s:%s', ws.tick_seq, p_speed),
    'world.speed_changed',
    'world',
    'system',
    format('Simulation speed changed from %sx to %sx.', ws.speed, p_speed),
    null, null, null, now(), v_world, ws.tick_seq,
    jsonb_build_object('from', ws.speed, 'to', p_speed)
  );
  return jsonb_build_object('status', 'ok', 'speed', p_speed);
end;
$$;

create function world_set_status(p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.world_tick'));
  select * into ws from world_state where singleton for update;
  if not found then
    return jsonb_build_object('status', 'not_initialized');
  end if;
  if p_status = ws.status then
    return jsonb_build_object('status', 'unchanged');
  end if;
  if p_status = 'paused' then
    update world_state set status = 'paused' where singleton;
    perform world_record_event(
      format('system:world.paused:%s', ws.tick_seq),
      'world.paused', 'world', 'system', 'An operator paused the simulation.',
      null, null, null, now(), ws.last_tick_world_s, ws.tick_seq, '{}'::jsonb
    );
  elsif p_status = 'running' then
    perform world_reanchor(now(), ws.last_tick_world_s, ws.speed);
    update world_state set status = 'running', last_tick_at = now() where singleton;
    perform world_record_event(
      format('system:world.resumed:%s:operator', ws.tick_seq),
      'world.resumed', 'world', 'system', 'An operator resumed the simulation. Paused time was not replayed.',
      null, null, null, now(), ws.last_tick_world_s, ws.tick_seq,
      jsonb_build_object('reason', 'operator')
    );
  else
    raise exception 'status must be running or paused';
  end if;
  return jsonb_build_object('status', 'ok', 'worldStatus', p_status);
end;
$$;

-- Read-only scheduler report for operators. The service role cannot read the
-- cron schema directly.
create function world_cron_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_run jsonb;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('scheduler', 'none');
  end if;
  execute $q$
    select jsonb_build_object('jobId', jobid, 'schedule', schedule, 'active', active)
    from cron.job where jobname = 'chogos-world-tick'
  $q$ into v_job;
  if v_job is null then
    return jsonb_build_object('scheduler', 'pg_cron', 'job', null);
  end if;
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select jsonb_build_object('status', status, 'startedAt', start_time, 'message', left(return_message, 200))
      from cron.job_run_details where jobid = $1 order by start_time desc limit 1
    $q$ into v_run using (v_job ->> 'jobId')::bigint;
  end if;
  return jsonb_build_object('scheduler', 'pg_cron', 'job', v_job, 'lastRun', v_run);
end;
$$;

-- Access ---------------------------------------------------------------------
-- The browser never reads these tables directly. The server reads them with the
-- service role, which may select but not write. Writes happen only inside the
-- security definer functions above.

do $$
declare
  table_name text;
  role_name text;
  fn regprocedure;
begin
  foreach table_name in array array[
    'world_buildings',
    'world_routes',
    'world_state',
    'citizen_world_state',
    'world_intents'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    foreach role_name in array array['anon', 'authenticated', 'service_role']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on table %I to service_role', table_name);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant insert on table world_intents to service_role;
  end if;

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'world\_%'
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
    grant execute on function world_tick() to service_role;
    grant execute on function world_initialize(jsonb, integer, text, numeric) to service_role;
    grant execute on function world_set_speed(numeric) to service_role;
    grant execute on function world_set_status(text) to service_role;
    grant execute on function world_cron_status() to service_role;
  end if;
end $$;

-- Runner ---------------------------------------------------------------------
-- Schedules world_tick() inside Supabase so the world advances with no viewer
-- and no app server. Sub-minute schedules need pg_cron 1.5 or later. If that
-- fails, the job runs every minute and transitions still happen at their
-- scheduled times, because each tick catches up within max_lag_seconds.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
    and not exists (select 1 from pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
exception when others then
  raise notice 'pg_cron could not be enabled here: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('chogos-world-tick', '5 seconds', 'select public.world_tick()');
    exception when others then
      perform cron.schedule('chogos-world-tick', '* * * * *', 'select public.world_tick()');
    end;
  end if;
exception when others then
  raise notice 'world_tick could not be scheduled here: %', sqlerrm;
end $$;
