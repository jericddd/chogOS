-- Phase 4: persistent citizen minds, outcome feedback, construction plots,
-- and a cloud-side decision seam. Additive. Does not reinitialize citizens,
-- reset the clock, shrink the map, drop history, or rerun event cutover.
-- world_tick() remains the only normal writer of simulation transitions.
-- Model HTTP calls stay outside this file.

-- Personalities --------------------------------------------------------------

create table citizen_personalities (
  citizen_id uuid primary key references citizens (id) on delete cascade,
  sociability smallint not null check (sociability between 0 and 100),
  curiosity smallint not null check (curiosity between 0 and 100),
  industriousness smallint not null check (industriousness between 0 and 100),
  cooperation smallint not null check (cooperation between 0 and 100),
  caution smallint not null check (caution between 0 and 100),
  planning smallint not null check (planning between 0 and 100),
  resourcefulness smallint not null check (resourcefulness between 0 and 100),
  preferred_activity text not null check (preferred_activity in ('work', 'shop', 'socialize', 'rest')),
  init_method text not null check (init_method in ('deterministic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table citizen_personalities is
  'Stable traits derived from citizen id. Repeated init must not change an existing row. Traits bias action ranking; they are not the model.';

create trigger citizen_personalities_updated_at
  before update on citizen_personalities
  for each row execute function set_updated_at();

-- Goals ----------------------------------------------------------------------

create table citizen_goals (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  kind text not null check (kind in (
    'skill_craft', 'skill_gather', 'community_facility', 'housing', 'resource_production', 'cooperation'
  )),
  title text not null check (char_length(title) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 240),
  status text not null check (status in (
    'proposed', 'active', 'blocked', 'completed', 'abandoned', 'superseded'
  )),
  progress smallint not null default 0 check (progress between 0 and 100),
  related_building_id text references world_buildings (id) on delete set null,
  source text not null check (source in ('system', 'ai')),
  decision_id uuid references ai_decisions (id) on delete set null,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table citizen_goals is
  'Bounded citizen objectives. Completion requires persisted simulation outcomes, not a model sentence.';

create trigger citizen_goals_updated_at
  before update on citizen_goals
  for each row execute function set_updated_at();

create unique index citizen_goals_one_open_kind
  on citizen_goals (citizen_id, kind)
  where status in ('proposed', 'active', 'blocked');

create index citizen_goals_citizen_status
  on citizen_goals (citizen_id, status);

-- Skills: experience for deterministic progression ---------------------------

alter table citizen_skills
  add column if not exists experience integer not null default 0 check (experience >= 0);

comment on column citizen_skills.experience is
  'Accumulated from completed simulation work. Level is derived. The model cannot write this column.';

create table citizen_skill_awards (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  skill_name text not null check (char_length(skill_name) between 1 and 80),
  event_id uuid not null references civilization_events (id) on delete restrict,
  xp integer not null check (xp > 0),
  created_at timestamptz not null default now(),
  unique (event_id, skill_name)
);

comment on table citizen_skill_awards is
  'Idempotent skill grants. Replaying an event cannot award the same skill twice.';

-- Memories: provenance columns ----------------------------------------------

alter table ai_memories
  add column if not exists category text
    check (category is null or category in (
      'completed_task', 'failed_task', 'rejected_proposal', 'construction',
      'resource', 'goal', 'obstacle', 'environment'
    )),
  add column if not exists source_event_id uuid references civilization_events (id) on delete set null,
  add column if not exists related_building_id text references world_buildings (id) on delete set null,
  add column if not exists goal_id uuid references citizen_goals (id) on delete set null,
  add column if not exists world_s bigint,
  add column if not exists outcome text
    check (outcome is null or outcome in ('success', 'failure', 'rejected', 'blocked', 'expired'));

create unique index if not exists ai_memories_event_once
  on ai_memories (citizen_id, source_event_id, category)
  where source_event_id is not null and citizen_id is not null;

create unique index if not exists ai_memories_reject_once
  on ai_memories (citizen_id, related_building_id, category, outcome)
  where source_event_id is null
    and citizen_id is not null
    and category in ('rejected_proposal', 'obstacle');

create index if not exists ai_memories_citizen_rank
  on ai_memories (citizen_id, importance desc, created_at desc)
  where citizen_id is not null;

-- Decision lifecycle ---------------------------------------------------------

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'ai_decisions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%draft%proposed%rejected%accepted%failed%'
    and pg_get_constraintdef(oid) not ilike '%queued%';
  if c is not null then
    execute format('alter table ai_decisions drop constraint %I', c);
  end if;
end $$;

alter table ai_decisions
  add constraint ai_decisions_status_check
  check (status in (
    'draft', 'proposed', 'rejected', 'accepted', 'failed', 'queued', 'executed', 'expired', 'superseded'
  ));

alter table ai_decisions
  add column if not exists last_error text,
  add column if not exists claimed_until timestamptz;

create index if not exists ai_decisions_citizen_created
  on ai_decisions (citizen_id, created_at desc);

-- AI source must name a decision --------------------------------------------

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'world_intents'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%work%shop%socialize%rest%sleep%';
  if c is not null then
    execute format('alter table world_intents drop constraint %I', c);
  end if;
end $$;

alter table world_intents
  add constraint world_intents_action_check
  check (action in ('work', 'shop', 'socialize', 'rest', 'sleep')),
  add constraint world_intents_ai_decision
  check (source <> 'ai' or decision_id is not null);

-- Plots for AI-directed housing on the expanded map -------------------------

create table world_plots (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  x integer not null check (x >= 0),
  y integer not null check (y >= 0),
  w integer not null check (w > 0),
  h integer not null check (h > 0),
  served boolean not null,
  status text not null default 'vacant' check (status in ('vacant', 'occupied', 'reserved')),
  building_id text references world_buildings (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (x, y, w, h)
);

comment on table world_plots is
  'Surveyed lots from genesis-v1.1. served lots have a door that touches a road. Unserved lots stay vacant until roads exist.';

insert into world_plots (id, x, y, w, h, served, status)
values
  ('plot-64-2', 64, 2, 3, 3, false, 'reserved'),
  ('plot-68-2', 68, 2, 3, 3, false, 'reserved'),
  ('plot-72-2', 72, 2, 3, 3, false, 'reserved'),
  ('plot-76-2', 76, 2, 3, 3, false, 'reserved'),
  ('plot-80-2', 80, 2, 3, 3, false, 'reserved'),
  ('plot-84-2', 84, 2, 3, 3, false, 'reserved'),
  ('plot-64-11', 64, 11, 3, 3, true, 'vacant'),
  ('plot-68-11', 68, 11, 3, 3, true, 'vacant'),
  ('plot-72-11', 72, 11, 3, 3, true, 'vacant'),
  ('plot-76-11', 76, 11, 3, 3, true, 'vacant'),
  ('plot-33-57', 33, 57, 3, 3, true, 'vacant'),
  ('plot-37-57', 37, 57, 3, 3, true, 'vacant'),
  ('plot-41-57', 41, 57, 3, 3, true, 'vacant'),
  ('plot-45-57', 45, 57, 3, 3, true, 'vacant'),
  ('plot-49-57', 49, 57, 3, 3, true, 'vacant')
on conflict (id) do nothing;

-- Scheduler / budget ---------------------------------------------------------

create table ai_usage_counters (
  bucket text not null check (bucket in ('hour', 'day')),
  period_start timestamptz not null,
  invocations integer not null default 0 check (invocations >= 0),
  prompt_chars bigint not null default 0 check (prompt_chars >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  halted_reason text,
  primary key (bucket, period_start)
);

create table ai_scheduler_state (
  singleton boolean primary key default true check (singleton),
  halt_until timestamptz,
  halt_reason text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0)
);

insert into ai_scheduler_state (singleton) values (true) on conflict do nothing;

create table ai_citizen_claims (
  citizen_id uuid primary key references citizens (id) on delete cascade,
  run_id uuid,
  claimed_until timestamptz,
  last_decision_at timestamptz
);

-- Helpers --------------------------------------------------------------------

create function world_trait_value(p_citizen uuid, p_salt text)
returns smallint
language sql
immutable
as $$
  select (
    get_byte(decode(md5(p_citizen::text || ':' || p_salt), 'hex'), 0)::int * 256
    + get_byte(decode(md5(p_citizen::text || ':' || p_salt), 'hex'), 1)::int
  ) % 101
$$;

create function world_preferred_activity(
  p_industriousness smallint,
  p_sociability smallint,
  p_curiosity smallint,
  p_caution smallint
)
returns text
language sql
immutable
as $$
  select case
    when p_industriousness >= p_sociability and p_industriousness >= p_curiosity and p_industriousness >= p_caution then 'work'
    when p_sociability >= p_curiosity and p_sociability >= p_caution then 'socialize'
    when p_curiosity >= p_caution then 'shop'
    else 'rest'
  end
$$;

create function world_ensure_minds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_people integer := 0;
  v_goals integer := 0;
begin
  insert into citizen_personalities (
    citizen_id, sociability, curiosity, industriousness, cooperation,
    caution, planning, resourcefulness, preferred_activity, init_method
  )
  select
    s.citizen_id,
    world_trait_value(s.citizen_id, 'sociability'),
    world_trait_value(s.citizen_id, 'curiosity'),
    world_trait_value(s.citizen_id, 'industriousness'),
    world_trait_value(s.citizen_id, 'cooperation'),
    world_trait_value(s.citizen_id, 'caution'),
    world_trait_value(s.citizen_id, 'planning'),
    world_trait_value(s.citizen_id, 'resourcefulness'),
    world_preferred_activity(
      world_trait_value(s.citizen_id, 'industriousness'),
      world_trait_value(s.citizen_id, 'sociability'),
      world_trait_value(s.citizen_id, 'curiosity'),
      world_trait_value(s.citizen_id, 'caution')
    ),
    'deterministic'
  from citizen_world_state s
  where s.activity <> 'unavailable'
  on conflict (citizen_id) do nothing;
  get diagnostics v_people = row_count;

  insert into citizen_goals (citizen_id, kind, title, summary, status, source, related_building_id)
  select
    s.citizen_id,
    case
      when s.role = 'crafter' then 'skill_craft'
      when s.role in ('farmer', 'woodcutter', 'stonecutter') then 'resource_production'
      when s.role = 'builder' then 'housing'
      when s.role = 'merchant' then 'community_facility'
      else 'cooperation'
    end,
    case
      when s.role = 'crafter' then 'Become a steadier crafter'
      when s.role in ('farmer', 'woodcutter', 'stonecutter') then 'Keep the storehouse supplied'
      when s.role = 'builder' then 'Help finish housing'
      when s.role = 'merchant' then 'Keep the market useful'
      else 'Meet neighbours at the square'
    end,
    case
      when s.role = 'crafter' then 'Complete supported workshop shifts so crafting skill can rise.'
      when s.role in ('farmer', 'woodcutter', 'stonecutter') then 'Finish gathering or farming shifts that the simulation actually supports.'
      when s.role = 'builder' then 'Work at an under-construction house when wood and stone are available.'
      when s.role = 'merchant' then 'Keep a stall open during market hours.'
      else 'Spend time at Commons Square when it is open.'
    end,
    'active',
    'system',
    s.work_id
  from citizen_world_state s
  where s.activity <> 'unavailable'
    and not exists (
      select 1 from citizen_goals g
      where g.citizen_id = s.citizen_id and g.status in ('proposed', 'active', 'blocked')
    )
  on conflict do nothing;
  get diagnostics v_goals = row_count;

  return jsonb_build_object('personalitiesInserted', v_people, 'goalsInserted', v_goals);
end;
$$;

create function ai_claim_citizens(p_run uuid, p_limit integer, p_interval interval)
returns table (claimed_citizen_id uuid, token_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select s.citizen_id
    from citizen_world_state s
    left join ai_citizen_claims c on c.citizen_id = s.citizen_id
    where s.activity <> 'unavailable'
      and not exists (
        select 1 from world_intents i
        where i.citizen_id = s.citizen_id and i.status = 'pending'
      )
      and (c.last_decision_at is null or c.last_decision_at < now() - p_interval)
      and (c.claimed_until is null or c.claimed_until < now())
    order by c.last_decision_at nulls first, s.citizen_id
    limit greatest(0, least(coalesce(p_limit, 0), 8))
    for update of s skip locked
  ), claimed as (
    insert into ai_citizen_claims (citizen_id, run_id, claimed_until)
    select picked.citizen_id, p_run, now() + interval '2 minutes'
    from picked
    on conflict (citizen_id) do update
      set run_id = excluded.run_id,
          claimed_until = excluded.claimed_until
      where ai_citizen_claims.claimed_until is null
         or ai_citizen_claims.claimed_until < now()
    returning ai_citizen_claims.citizen_id
  )
  select claimed.citizen_id, z.token_id::text
  from claimed
  join citizens z on z.id = claimed.citizen_id
  order by z.token_id;
end;
$$;

create function world_release_claim(p_citizen uuid, p_run uuid, p_decided boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update ai_citizen_claims
  set
    claimed_until = case when run_id = p_run then null else claimed_until end,
    last_decision_at = case when p_decided then now() else last_decision_at end
  where citizen_id = p_citizen;
end;
$$;

-- Provenance: record intent and decision on new events ----------------------

drop function if exists world_record_event(text, text, text, text, text, uuid, text, uuid, timestamptz, bigint, bigint, jsonb);

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
  p_payload jsonb,
  p_intent uuid default null,
  p_decision uuid default null
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
  if p_intent is not null then
    v_payload := v_payload || jsonb_build_object('intentId', p_intent);
  end if;
  if p_decision is not null then
    v_payload := v_payload || jsonb_build_object('decisionId', p_decision);
  end if;

  insert into civilization_events (
    dedupe_key, kind, category, source, summary, actor_citizen_id, building_id,
    related_citizen_id, occurred_at, world_s, tick_seq, chain_status, payload, schema_version,
    intent_id, decision_id
  )
  values (
    p_dedupe, p_kind, p_category, p_source, p_summary, p_citizen, p_building,
    p_related, p_occurred, p_world, p_tick, 'offchain', v_payload, 1,
    p_intent, p_decision
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create function world_note_intent_resolution(p_intent uuid)
returns void
language plpgsql
as $$
declare
  i world_intents%rowtype;
  v_content text;
  v_category text;
  v_outcome text;
  v_importance smallint;
begin
  select * into i from world_intents where id = p_intent;
  if not found or i.decision_id is null then
    return;
  end if;

  if i.status = 'accepted' then
    update ai_decisions
    set status = 'accepted', intent_id = i.id, validation_result = null
    where id = i.decision_id and status in ('queued', 'proposed', 'accepted');
    return;
  end if;

  if i.status = 'rejected' then
    update ai_decisions
    set status = 'rejected', intent_id = i.id, validation_result = left(coalesce(i.reason, 'rejected'), 240)
    where id = i.decision_id and status in ('queued', 'proposed', 'accepted');
    v_category := 'rejected_proposal';
    v_outcome := 'rejected';
    v_importance := 3;
    v_content := left(format('A %s proposal at %s was rejected: %s.', i.action, coalesce(world_building_name(i.building_id), i.building_id), coalesce(i.reason, 'unspecified')), 240);
  elsif i.status = 'expired' then
    update ai_decisions
    set status = 'expired', intent_id = i.id, validation_result = 'intent expired before execution'
    where id = i.decision_id and status in ('queued', 'proposed', 'accepted');
    v_category := 'obstacle';
    v_outcome := 'expired';
    v_importance := 2;
    v_content := left(format('A %s intent at %s expired before the simulation applied it.', i.action, coalesce(world_building_name(i.building_id), i.building_id)), 240);
  else
    return;
  end if;

  insert into ai_memories (
    scope, citizen_id, content, importance, category, related_building_id, outcome
  )
  values (
    'citizen', i.citizen_id, v_content, v_importance, v_category, i.building_id, v_outcome
  )
  on conflict do nothing;
end;
$$;

create or replace function world_choose_action(
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
      perform world_note_intent_resolution(i.id);
    else
      v_reason := world_check_action(p_citizen, i.action, i.building_id, p_world);
      if v_reason is null then
        update world_intents set status = 'accepted', resolved_at = now() where id = i.id;
        perform world_note_intent_resolution(i.id);
        action := i.action;
        building := i.building_id;
        source := i.source;
        intent_id := i.id;
        return;
      end if;
      update world_intents set status = 'rejected', reason = v_reason, resolved_at = now() where id = i.id;
      perform world_note_intent_resolution(i.id);
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

create or replace function world_begin(
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
  v_intent uuid;
  v_decision uuid;
  v_event uuid;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen for update;
  select * into ws from world_state where singleton;

  begin
    v_intent := (c.task ->> 'intent')::uuid;
  exception when others then
    v_intent := null;
  end;
  if v_intent is null and p_source = 'ai' then
    select i.id, i.decision_id into v_intent, v_decision
    from world_intents i
    where i.citizen_id = p_citizen
      and i.status = 'accepted'
      and i.action = p_action
      and i.building_id = p_building
    order by i.resolved_at desc nulls last
    limit 1;
  elsif v_intent is not null and v_decision is null then
    select decision_id into v_decision from world_intents where id = v_intent;
  end if;

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
      'action', p_action,
      'building', p_building,
      'shift', case when p_action = 'work' then v_shifts end,
      'intent', v_intent,
      'decision', v_decision
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

  v_event := world_record_event(
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
    ),
    v_intent,
    v_decision
  );

  if p_action <> 'work' and v_decision is not null and v_event is not null then
    update ai_decisions
    set
      status = 'executed',
      outcome_event_id = coalesce(outcome_event_id, v_event),
      event_hash = coalesce(event_hash, (select event_hash from civilization_events where id = v_event))
    where id = v_decision and status in ('queued', 'accepted', 'proposed');
  end if;
end;
$$;

create function world_skill_for_role(p_role text)
returns text
language sql
immutable
as $$
  select case p_role
    when 'farmer' then 'farming'
    when 'woodcutter' then 'gathering'
    when 'stonecutter' then 'gathering'
    when 'crafter' then 'crafting'
    when 'builder' then 'construction'
    when 'merchant' then 'trading'
    else null
  end
$$;

create function world_award_skill(p_citizen uuid, p_skill text, p_event uuid, p_xp integer)
returns void
language plpgsql
as $$
declare
  v_xp integer := greatest(1, p_xp);
  v_exp integer;
begin
  if p_citizen is null or p_skill is null or p_event is null then
    return;
  end if;
  insert into citizen_skill_awards (citizen_id, skill_name, event_id, xp)
  values (p_citizen, p_skill, p_event, v_xp)
  on conflict (event_id, skill_name) do nothing;
  if not found then
    return;
  end if;

  insert into citizen_skills (citizen_id, name, level, experience, evidence)
  values (p_citizen, p_skill, 1, v_xp, p_event::text)
  on conflict (citizen_id, name) do update
    set experience = citizen_skills.experience + excluded.experience,
        evidence = excluded.evidence,
        updated_at = now();

  select experience into v_exp
  from citizen_skills
  where citizen_id = p_citizen and name = p_skill;

  update citizen_skills
  set level = least(100, greatest(1, 1 + (v_exp / 20)))
  where citizen_id = p_citizen and name = p_skill;
end;
$$;

create function world_remember_success(
  p_citizen uuid,
  p_event uuid,
  p_building text,
  p_world bigint,
  p_summary text,
  p_category text
)
returns void
language plpgsql
as $$
begin
  if p_citizen is null or p_event is null then
    return;
  end if;
  insert into ai_memories (
    scope, citizen_id, content, importance, category, source_event_id, related_building_id, world_s, outcome
  )
  values (
    'citizen',
    p_citizen,
    left(p_summary, 240),
    2,
    p_category,
    p_event,
    p_building,
    p_world,
    'success'
  )
  on conflict do nothing;
end;
$$;

create function world_progress_goal(p_citizen uuid, p_kind text, p_delta integer, p_building text)
returns void
language plpgsql
as $$
declare
  g citizen_goals%rowtype;
  v_progress integer;
begin
  select * into g
  from citizen_goals
  where citizen_id = p_citizen
    and kind = p_kind
    and status in ('proposed', 'active', 'blocked')
  order by created_at
  limit 1
  for update;
  if not found then
    return;
  end if;
  v_progress := least(100, g.progress + greatest(0, p_delta));
  if v_progress >= 100 then
    update citizen_goals
    set status = 'completed', progress = 100, completed_at = now(), blocked_reason = null,
        related_building_id = coalesce(p_building, related_building_id)
    where id = g.id;
  else
    update citizen_goals
    set status = 'active', progress = v_progress, blocked_reason = null,
        related_building_id = coalesce(p_building, related_building_id)
    where id = g.id;
  end if;
end;
$$;

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
      perform world_progress_goal(p_citizen, 'housing', 8, b.id);
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
      jsonb_build_object('capacity', b.capacity, 'nextSite', v_next),
      v_intent,
      v_decision
    );

    update citizen_goals
    set status = 'completed', progress = 100, completed_at = now(), related_building_id = b.id
    where kind = 'housing' and status in ('proposed', 'active', 'blocked')
      and (related_building_id = b.id or related_building_id is null);

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

-- Construction placement. Coordinates come from a vacant served plot, never
-- from unconstrained model output.

create function world_place_building(
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
begin
  if p_kind is distinct from 'house' then
    return jsonb_build_object('ok', false, 'reason', 'only house construction is supported on surveyed lots');
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

  insert into world_buildings (
    id, layout_version, kind, name, x, y, w, h, door_x, door_y,
    capacity, job_slots, role, open_air, status, construction_progress, batch_shifts
  ) values (
    p_id, ws.layout_version, 'house', left(coalesce(nullif(p_name, ''), p_id), 80),
    plot.x, plot.y, plot.w, plot.h, p_door_x, p_door_y,
    4, 7, 'builder', false, 'under_construction', 0, null
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
    jsonb_build_object('plotId', plot.id, 'kind', 'house'),
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
      proposed_action = coalesce(proposed_action, '{}'::jsonb) || jsonb_build_object('buildingId', p_id, 'plotId', plot.id)
    where id = p_decision;
  end if;

  return jsonb_build_object(
    'ok', true,
    'buildingId', p_id,
    'plotId', plot.id,
    'eventId', v_event,
    'buildersAssigned', v_assigned
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'reason', 'construction could not be recorded');
end;
$$;

-- Access ---------------------------------------------------------------------

do $$
declare
  table_name text;
  role_name text;
  fn regprocedure;
begin
  foreach table_name in array array[
    'citizen_personalities',
    'citizen_goals',
    'citizen_skill_awards',
    'world_plots',
    'ai_usage_counters',
    'ai_scheduler_state',
    'ai_citizen_claims'
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
    grant insert, update on table citizen_personalities to service_role;
    grant insert, update on table citizen_goals to service_role;
    grant insert, update on table citizen_skills to service_role;
    grant insert on table citizen_skill_awards to service_role;
    grant insert, update on table ai_memories to service_role;
    grant insert, update on table ai_decisions to service_role;
    grant insert, update on table ai_usage_counters to service_role;
    grant insert, update on table ai_scheduler_state to service_role;
    grant insert, update on table ai_citizen_claims to service_role;
    grant select on table world_plots to service_role;
  end if;

  foreach fn in array array[
    'world_ensure_minds()'::regprocedure,
    'ai_claim_citizens(uuid,integer,interval)'::regprocedure,
    'world_release_claim(uuid,uuid,boolean)'::regprocedure,
    'world_place_building(text,text,text,text,integer,integer,jsonb,text,uuid,uuid)'::regprocedure
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
    grant execute on function world_ensure_minds() to service_role;
    grant execute on function ai_claim_citizens(uuid, integer, interval) to service_role;
    grant execute on function world_release_claim(uuid, uuid, boolean) to service_role;
    grant execute on function world_place_building(text, text, text, text, integer, integer, jsonb, text, uuid, uuid) to service_role;
  end if;
end $$;
