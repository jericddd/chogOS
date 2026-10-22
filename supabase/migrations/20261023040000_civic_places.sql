-- Parks, amusement, and the ChogBank door, then breaches, laws, fines, and the jail.
--
-- Additive. Founding rectangles stay where they are. A park, an amusement, and
-- the bank open on the first vacant road-served lots once the world exists.
-- The jail is refused until a law is proclaimed and a fine could not be paid.
-- A visit does not move MON, $CHOG, or simulated food. Payout execution stays off.

-- Wider kinds, activities, purposes, and intents ------------------------------

do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'world_buildings'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%''market''%'
      and pg_get_constraintdef(con.oid) not ilike '%''park''%'
  loop
    execute format('alter table world_buildings drop constraint %I', c);
  end loop;

  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'citizen_world_state'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%''sleeping''%'
      and pg_get_constraintdef(con.oid) not ilike '%''visiting''%'
  loop
    execute format('alter table citizen_world_state drop constraint %I', c);
  end loop;

  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'citizen_world_state'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%''sleep''%'
      and pg_get_constraintdef(con.oid) not ilike '%''visit''%'
      and pg_get_constraintdef(con.oid) not ilike '%activity%'
  loop
    execute format('alter table citizen_world_state drop constraint %I', c);
  end loop;

  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'world_intents'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%''socialize''%'
      and pg_get_constraintdef(con.oid) not ilike '%''visit''%'
  loop
    execute format('alter table world_intents drop constraint %I', c);
  end loop;
end $$;

alter table world_buildings
  add constraint world_buildings_kind_check
  check (kind in (
    'house', 'hall', 'commons', 'farm', 'forest', 'quarry', 'workshop', 'storehouse', 'market',
    'park', 'amusement', 'bank', 'jail'
  ));

alter table citizen_world_state
  add constraint citizen_world_state_activity_check
  check (activity in (
    'walking', 'working', 'gathering', 'building', 'shopping', 'socializing',
    'resting', 'sleeping', 'idle', 'unavailable', 'visiting', 'detained'
  ));

alter table citizen_world_state
  add constraint citizen_world_state_purpose_check
  check (purpose is null or purpose in (
    'work', 'shop', 'socialize', 'rest', 'sleep', 'idle', 'visit', 'watch', 'detain'
  ));

alter table world_intents
  add constraint world_intents_action_check
  check (action in ('work', 'shop', 'socialize', 'rest', 'sleep', 'visit', 'watch', 'detain'));

-- Laws and sentences ---------------------------------------------------------

create table world_laws (
  code text primary key check (code in (
    'storehouse_night', 'merchant_only', 'ration_cap', 'house_door', 'ration_fine'
  )),
  status text not null check (status in ('proclaimed', 'amended', 'pardoned')),
  reason text not null check (char_length(reason) between 8 and 240),
  decision_id uuid references ai_decisions (id) on delete set null,
  event_id uuid references civilization_events (id) on delete set null,
  proclaimed_at timestamptz not null default now(),
  world_s bigint,
  updated_at timestamptz not null default now()
);

comment on table world_laws is
  'Catalog rules the tick can enforce. The reason is stored. Freeform text does not change the simulation.';

create trigger world_laws_updated_at
  before update on world_laws
  for each row execute function set_updated_at();

create table world_sentences (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  jail_id text not null references world_buildings (id),
  offense text not null check (char_length(offense) between 1 and 80),
  started_world_s bigint not null,
  ends_world_s bigint not null,
  released_world_s bigint,
  released_at timestamptz,
  decision_id uuid references ai_decisions (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_world_s > started_world_s)
);

create unique index world_sentences_one_open
  on world_sentences (citizen_id)
  where released_at is null;

comment on table world_sentences is
  'A term in the jail. Release is its own event when world time reaches the end.';

create index if not exists civilization_events_civic_breach
  on civilization_events (actor_citizen_id, world_s)
  where kind = 'civic.breach';

-- Records --------------------------------------------------------------------

create or replace function world_action_activity(p_action text, p_role text)
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
    when 'visit' then 'visiting'
    when 'watch' then 'working'
    when 'detain' then 'detained'
    else 'idle'
  end
$$;

create or replace function world_duration(p_action text, p_roll integer, p_world bigint, p_chrono integer)
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
    when 'watch' then return 14400 + (p_roll % 31) * 60;
    when 'shop' then return 2400 + (p_roll % 31) * 60;
    when 'visit' then return 2400 + (p_roll % 31) * 60;
    when 'socialize' then return 3600 + (p_roll % 61) * 60;
    when 'rest' then return 4500 + (p_roll % 76) * 60;
    when 'idle' then return 600;
    when 'detain' then return 28800;
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

-- Wall-clock now() would put a simulation event outside the town's clock.
create function world_clock_at(p_world bigint)
returns timestamptz
language sql
stable
as $$
  select coalesce(
    (select world_real_at(anchor_real, anchor_world_s, speed, p_world) from world_state where singleton),
    now()
  )
$$;

create function world_law_proclaimed(p_code text)
returns boolean
language sql
stable
as $$
  select exists (select 1 from world_laws where code = p_code and status = 'proclaimed')
$$;

create function world_shortage_active()
returns boolean
language sql
stable
as $$
  select (
    exists (
      select 1 from town_needs
      where need_type = 'food_shortage' and status = 'active'
    )
    or (
      world_stock('food') < 40
      and not exists (select 1 from town_needs where need_type = 'food_shortage')
    )
  )
$$;

create function world_breach_count(p_citizen uuid)
returns integer
language sql
stable
as $$
  select count(*)::int
  from civilization_events
  where kind = 'civic.breach'
    and (p_citizen is null or actor_citizen_id = p_citizen)
$$;

create function world_is_hostile(p_citizen uuid, p_world bigint)
returns boolean
language sql
stable
as $$
  with breaches as (
    select count(*)::int as n, max(world_s) as latest
    from civilization_events
    where kind = 'civic.breach' and actor_citizen_id = p_citizen
  ),
  release as (
    select max(released_world_s) as at
    from world_sentences
    where citizen_id = p_citizen and released_at is not null
  )
  select case
    when (select n from breaches) < 2 then false
    when (select at from release) is null then true
    when (select latest from breaches) > (select at from release) then true
    when p_world < (select at from release) + 3 * 86400 then true
    else false
  end
$$;

create function world_any_hostile(p_world bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from (
      select actor_citizen_id
      from civilization_events
      where kind = 'civic.breach' and actor_citizen_id is not null
      group by actor_citizen_id
      having count(*) >= 2
    ) marked
    where world_is_hostile(marked.actor_citizen_id, p_world)
  )
$$;

create function world_sentence_open(p_citizen uuid, p_world bigint)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from world_sentences
    where citizen_id = p_citizen and released_at is null and ends_world_s > p_world
  )
$$;

create function world_release_due(p_citizen uuid, p_world bigint)
returns void
language plpgsql
as $$
declare
  s world_sentences%rowtype;
  v_tick bigint;
begin
  select * into s
  from world_sentences
  where citizen_id = p_citizen and released_at is null and ends_world_s <= p_world
  order by created_at
  limit 1
  for update;
  if not found then
    return;
  end if;
  select tick_seq into v_tick from world_state;
  update world_sentences
  set released_at = world_clock_at(p_world), released_world_s = p_world
  where id = s.id;
  perform world_record_event(
    format('sim:%s:released:%s', p_citizen, s.id),
    'civic.released',
    'world',
    'simulation',
    format('%s finished the sentence and left the jail.', world_citizen_label(p_citizen)),
    p_citizen,
    s.jail_id,
    null,
    world_clock_at(p_world),
    p_world,
    coalesce(v_tick, 0),
    jsonb_build_object('offense', s.offense, 'endsWorldS', s.ends_world_s),
    null,
    s.decision_id
  );
end;
$$;

create function world_record_breach(
  p_citizen uuid,
  p_building text,
  p_act text,
  p_world bigint,
  p_tick bigint,
  p_forced boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_event uuid;
  v_day bigint := (p_world / 86400) * 86400;
  v_label text;
  v_summary text;
  v_count integer;
  v_at timestamptz;
begin
  if p_act not in ('storehouse_skim', 'wrong_door', 'unsanctioned_sale', 'ration_overdraw') then
    return null;
  end if;
  if p_act = 'storehouse_skim' and exists (
    select 1 from citizen_world_state
    where (task ->> 'action') = 'watch'
      and activity in ('working', 'walking')
      and (location_id = 'storehouse' or destination_id = 'storehouse')
  ) then
    return null;
  end if;
  if not p_forced and (
    world_trait_value(p_citizen, 'cooperation') >= 45
    or world_trait_value(p_citizen, 'caution') >= 45
    or world_trait_value(p_citizen, 'resourcefulness') <= 55
  ) then
    return null;
  end if;
  if exists (
    select 1 from civilization_events
    where actor_citizen_id = p_citizen
      and kind = 'civic.breach'
      and world_s >= v_day
      and payload ->> 'act' = p_act
  ) then
    return null;
  end if;

  v_at := world_clock_at(p_world);
  v_label := world_citizen_label(p_citizen);
  v_summary := case p_act
    when 'storehouse_skim' then format('%s tried to take from the Storehouse outside a work shift.', v_label)
    when 'wrong_door' then format('%s tried a house door that is not theirs.', v_label)
    when 'unsanctioned_sale' then format('%s tried to sell at the market without the merchant job.', v_label)
    when 'ration_overdraw' then format('%s tried to draw a ration after the hall had capped draws.', v_label)
    else format('%s broke a town custom.', v_label)
  end;

  v_event := world_record_event(
    format('sim:%s:breach:%s:%s', p_citizen, p_act, v_day),
    'civic.breach',
    'world',
    'simulation',
    v_summary,
    p_citizen,
    p_building,
    null,
    v_at,
    p_world,
    p_tick,
    jsonb_build_object('act', p_act, 'reason', v_summary)
  );

  if v_event is null then
    return null;
  end if;

  v_count := world_breach_count(p_citizen);
  if world_is_hostile(p_citizen, p_world) then
    perform world_record_event(
      format('sim:%s:marked:%s', p_citizen, coalesce((select max(released_world_s) from world_sentences where citizen_id = p_citizen), 0)),
      'civic.marked',
      'world',
      'simulation',
      format('%s is marked from stored conduct. The mark is not a job, and the fields are still open to them.', v_label),
      p_citizen,
      p_building,
      null,
      v_at,
      p_world,
      p_tick,
      jsonb_build_object('breaches', v_count)
    );
  end if;

  if world_law_proclaimed('ration_fine') then
    if world_stock('food') > 0 then
      perform world_store('food', -1, p_tick);
      perform world_record_event(
        format('sim:%s:fine:%s', p_citizen, v_day),
        'civic.fine',
        'world',
        'simulation',
        format('%s drew a ration fine. One simulated food left the Storehouse.', v_label),
        p_citizen,
        'storehouse',
        null,
        v_at,
        p_world,
        p_tick,
        jsonb_build_object('food', 1, 'act', p_act)
      );
    else
      perform world_record_event(
        format('sim:%s:fine-unpaid:%s', p_citizen, v_day),
        'civic.fine_unpaid',
        'world',
        'simulation',
        format('The Storehouse had no food, so the fine against %s could not be taken.', v_label),
        p_citizen,
        'storehouse',
        null,
        v_at,
        p_world,
        p_tick,
        jsonb_build_object('act', p_act)
      );
    end if;
  end if;

  perform world_record_event(
    format('sim:%s:notice:%s:%s', p_citizen, p_act, v_day),
    'civic.notice',
    'world',
    'simulation',
    format('A public note at Commons Square records what %s did.', v_label),
    p_citizen,
    'commons-square',
    null,
    v_at,
    p_world,
    p_tick,
    jsonb_build_object('act', p_act)
  );

  return v_event;
end;
$$;

create function world_maybe_offense(p_citizen uuid, p_world bigint, p_when text)
returns void
language plpgsql
as $$
declare
  v_tick bigint;
begin
  select tick_seq into v_tick from world_state;
  if p_when = 'night' then
    if world_roll(p_citizen, world_day(p_world)::bigint, 'skim') >= 180 then
      return;
    end if;
    perform world_record_breach(p_citizen, 'storehouse', 'storehouse_skim', p_world, coalesce(v_tick, 0), false);
  elsif p_when = 'market' and world_hour(p_world) >= 7 and world_hour(p_world) < 20 then
    if exists (select 1 from citizen_world_state where citizen_id = p_citizen and role = 'merchant') then
      return;
    end if;
    if world_roll(p_citizen, world_day(p_world)::bigint, 'sale') >= 120 then
      return;
    end if;
    perform world_record_breach(p_citizen, 'market', 'unsanctioned_sale', p_world, coalesce(v_tick, 0), false);
  end if;
end;
$$;

-- Checks and choices ---------------------------------------------------------

create or replace function world_check_action(p_citizen uuid, p_action text, p_building text, p_world bigint)
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

  if world_sentence_open(p_citizen, p_world) and p_action is distinct from 'detain' then
    return 'citizen is detained';
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
      if world_law_proclaimed('ration_cap')
         and world_stock('food') < 40
         and c.day_index = world_day(p_world)
         and c.market_visits_today >= 1 then
        return 'the hall has capped rations';
      end if;
    when 'socialize' then
      if b.kind = 'commons' then
        if v_hour < 7 then
          return 'too early to gather';
        end if;
      elsif b.kind in ('park', 'amusement') then
        if b.status <> 'active' then
          return 'building is not complete';
        end if;
        if v_hour < 7 then
          return 'too early to gather';
        end if;
      else
        return 'not a public space';
      end if;
      if world_trait_value(p_citizen, 'caution') >= 60 and exists (
        select 1 from citizen_world_state other
        where other.location_id = b.id
          and other.citizen_id <> p_citizen
          and world_is_hostile(other.citizen_id, p_world)
      ) then
        return 'a marked citizen is already there';
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
    when 'visit' then
      if b.kind <> 'bank' then
        return 'not a bank';
      end if;
      if b.status <> 'active' then
        return 'building is not complete';
      end if;
      if v_hour < 7 or v_hour >= 20 then
        return 'the bank is closed';
      end if;
    when 'watch' then
      if b.kind not in ('storehouse', 'commons') then
        return 'watch stands at the storehouse or the square';
      end if;
      if b.status <> 'active' then
        return 'building is not complete';
      end if;
      if v_hour < 5 or v_hour >= 18 then
        return 'outside working hours';
      end if;
      if c.day_index = world_day(p_world) and c.shifts_today >= 2 then
        return 'two shifts already worked today';
      end if;
      if not world_any_hostile(p_world) then
        return 'no repeated offense is stored';
      end if;
    when 'detain' then
      if b.kind <> 'jail' or b.status <> 'active' then
        return 'the jail is not open';
      end if;
      if not exists (
        select 1 from world_sentences
        where citizen_id = p_citizen and jail_id = b.id and released_at is null
      ) then
        return 'no sentence is stored';
      end if;
    else
      return 'unknown action';
  end case;
  return null;
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
  v_gather text := 'commons-square';
  v_leisure text;
  v_bank text;
  v_tick bigint;
begin
  select * into c from citizen_world_state where citizen_id = p_citizen;
  perform world_release_due(p_citizen, p_world);
  if world_sentence_open(p_citizen, p_world) then
    select jail_id into building
    from world_sentences
    where citizen_id = p_citizen and released_at is null
    order by created_at desc
    limit 1;
    action := 'detain';
    source := 'simulation';
    intent_id := null;
    return;
  end if;

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
      select tick_seq into v_tick from world_state;
      if v_reason = 'not this citizen''s home' then
        perform world_record_breach(p_citizen, i.building_id, 'wrong_door', p_world, coalesce(v_tick, 0), true);
      elsif v_reason = 'the hall has capped rations' then
        perform world_record_breach(p_citizen, i.building_id, 'ration_overdraw', p_world, coalesce(v_tick, 0), true);
      end if;
    end if;
  end if;

  source := 'simulation';
  v_shifts := case when c.day_index = v_day then c.shifts_today else 0 end;
  v_visits := case when c.day_index = v_day then c.market_visits_today else 0 end;
  v_last := c.task ->> 'action';
  v_roll := world_roll(p_citizen, c.version, 'choose');

  if v_hour < 5 or v_hour >= 18 then
    perform world_maybe_offense(p_citizen, p_world, 'night');
  else
    perform world_maybe_offense(p_citizen, p_world, 'market');
  end if;

  if v_visits >= 1 and world_check_action(p_citizen, 'shop', 'market', p_world) = 'the hall has capped rations' then
    select tick_seq into v_tick from world_state;
    perform world_record_breach(p_citizen, 'market', 'ration_overdraw', p_world, coalesce(v_tick, 0), true);
  end if;

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

  if v_hour >= 5 and v_hour < 18 and v_shifts < 2 and v_roll < 80
     and world_any_hostile(p_world)
     and not exists (
       select 1 from citizen_world_state
       where (task ->> 'action') = 'watch' and activity in ('working', 'walking')
     )
     and world_check_action(p_citizen, 'watch', 'storehouse', p_world) is null then
    action := 'watch';
    building := 'storehouse';
    return;
  end if;

  if v_roll < 220 then
    select id into v_leisure
    from world_buildings
    where kind in ('park', 'amusement') and status = 'active'
    order by case when kind = 'park' then 0 else 1 end, id
    limit 1;
    if v_leisure is not null
       and world_check_action(p_citizen, 'socialize', v_leisure, p_world) is null then
      v_gather := v_leisure;
    end if;
  end if;

  if v_roll < 450 and v_last is distinct from 'socialize'
    and world_check_action(p_citizen, 'socialize', v_gather, p_world) is null then
    action := 'socialize';
    building := v_gather;
    return;
  end if;

  if v_roll < 800 and v_visits < 1 and v_last is distinct from 'shop'
    and world_check_action(p_citizen, 'shop', 'market', p_world) is null then
    action := 'shop';
    building := 'market';
    return;
  end if;

  if v_hour >= 7 and v_hour < 20 and v_roll >= 800 and v_roll < 900 and v_last is distinct from 'visit' then
    select id into v_bank
    from world_buildings
    where kind = 'bank' and status = 'active'
    order by id
    limit 1;
    if v_bank is not null and world_check_action(p_citizen, 'visit', v_bank, p_world) is null then
      action := 'visit';
      building := v_bank;
      return;
    end if;
  end if;

  if v_last is distinct from 'rest' or v_roll >= 800 then
    action := 'rest';
    building := v_rest;
    return;
  end if;

  if world_check_action(p_citizen, 'socialize', v_gather, p_world) is null then
    action := 'socialize';
    building := v_gather;
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
  if p_action = 'detain' then
    select greatest(60, ends_world_s - p_world) into v_duration
    from world_sentences
    where citizen_id = p_citizen and released_at is null
    order by created_at desc
    limit 1;
    if v_duration is null then
      v_duration := 60;
    end if;
  else
    v_duration := world_duration(p_action, v_roll, p_world, world_chronotype(p_citizen));
  end if;
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
  elsif p_action = 'visit' then
    v_kind := 'citizen.bank_visit';
    v_category := 'citizen';
    v_payload := jsonb_build_object('movedFunds', false);
    v_summary := format('%s read the public books at %s. The visit did not move MON or $CHOG.', v_label, v_place);
  elsif p_action = 'watch' then
    v_shifts := v_shifts + 1;
    v_kind := 'civic.watch';
    v_category := 'work';
    v_payload := jsonb_build_object('shift', v_shifts);
    v_summary := format('%s kept an ordinary watch at %s.', v_label, v_place);
  elsif p_action = 'detain' then
    v_kind := 'civic.detained';
    v_category := 'world';
    v_summary := format('%s is detained at %s.', v_label, v_place);
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
      'shift', case when p_action in ('work', 'watch') then v_shifts end,
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

-- Places ---------------------------------------------------------------------

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
  elsif new.kind in ('park', 'amusement') then
    new.role := null;
    new.job_slots := null;
    new.batch_shifts := null;
    new.capacity := null;
    new.open_air := true;
  elsif new.kind = 'bank' then
    new.role := null;
    new.job_slots := null;
    new.batch_shifts := null;
    new.capacity := null;
    new.open_air := false;
  elsif new.kind = 'jail' then
    new.role := null;
    new.job_slots := null;
    new.batch_shifts := null;
    new.capacity := 4;
    new.open_air := false;
  end if;
  return new;
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
  if p_kind not in ('house', 'farm', 'workshop', 'park', 'amusement', 'bank', 'jail') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported construction kind');
  end if;
  if p_kind = 'jail' then
    if not exists (select 1 from world_laws where status = 'proclaimed') then
      return jsonb_build_object('ok', false, 'reason', 'a jail waits until a law is proclaimed');
    end if;
    if not exists (select 1 from civilization_events where kind = 'civic.fine_unpaid') then
      return jsonb_build_object('ok', false, 'reason', 'a fine still covers the offense');
    end if;
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

create function world_open_civic_places()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_kind text;
  v_name text;
  v_id text;
  plot world_plots%rowtype;
  v_door_x integer;
  v_door_y integer;
  v_open boolean;
  b record;
  v_steps integer;
  v_opened text[] := '{}';
  v_reason text;
begin
  select * into ws from world_state where singleton;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'world is not initialized');
  end if;

  foreach v_kind in array array['park', 'amusement', 'bank']
  loop
    if exists (select 1 from world_buildings where kind = v_kind) then
      continue;
    end if;
    select * into plot
    from world_plots
    where status = 'vacant'
      and served
      and not exists (
        select 1 from world_buildings existing
        where existing.x < world_plots.x + world_plots.w
          and existing.x + existing.w > world_plots.x
          and existing.y < world_plots.y + world_plots.h
          and existing.y + existing.h > world_plots.y
      )
    order by y, x
    limit 1
    for update;
    if not found then
      continue;
    end if;

    v_door_x := plot.x + 1;
    v_door_y := plot.y;
    if v_kind = 'bank' then
      v_id := 'chog-bank';
      v_name := 'ChogBank';
      v_open := false;
      v_reason := 'ChogBank is a door on a road-connected lot. Standing here reads the public books. It does not move MON or $CHOG.';
    elsif v_kind = 'park' then
      v_id := 'park-01';
      v_name := 'Willow Park';
      v_open := true;
      v_reason := 'Willow Park is open leisure on a road-connected lot. People can gather here after 07:00. It is not a job.';
    else
      v_id := 'amusement-01';
      v_name := 'Lantern Green';
      v_open := true;
      v_reason := 'Lantern Green is open leisure on a road-connected lot. People can gather here after 07:00. It is not a job.';
    end if;
    if exists (select 1 from world_buildings where id = v_id) then
      continue;
    end if;

    insert into world_buildings (
      id, layout_version, kind, name, x, y, w, h, door_x, door_y,
      capacity, job_slots, role, open_air, status, construction_progress, batch_shifts
    ) values (
      v_id, ws.layout_version, v_kind, v_name,
      plot.x, plot.y, plot.w, plot.h, v_door_x, v_door_y,
      null, null, null, v_open, 'active', null, null
    );

    for b in select id, door_x, door_y from world_buildings where id <> v_id
    loop
      v_steps := greatest(2, abs(v_door_x - b.door_x) + abs(v_door_y - b.door_y));
      insert into world_routes (from_id, to_id, steps) values (v_id, b.id, v_steps) on conflict do nothing;
      insert into world_routes (from_id, to_id, steps) values (b.id, v_id, v_steps) on conflict do nothing;
    end loop;

    update world_plots set status = 'occupied', building_id = v_id where id = plot.id;

    perform world_record_event(
      format('system:%s:opened', v_id),
      'place.opened',
      'world',
      'system',
      v_reason,
      null,
      v_id,
      null,
      now(),
      ws.last_tick_world_s,
      ws.tick_seq,
      jsonb_build_object('kind', v_kind, 'plotId', plot.id, 'reason', v_reason)
    );
    v_opened := array_append(v_opened, v_id);
  end loop;

  return jsonb_build_object('ok', true, 'opened', to_jsonb(v_opened));
end;
$$;

-- Mind records ---------------------------------------------------------------

create function world_proclaim_law(p_code text, p_reason text, p_citizen uuid, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_reason text := left(trim(coalesce(p_reason, '')), 240);
  v_event uuid;
  v_repeated boolean;
begin
  if p_code not in ('storehouse_night', 'merchant_only', 'ration_cap', 'house_door', 'ration_fine') then
    return jsonb_build_object('ok', false, 'reason', 'that is not a law in the catalog');
  end if;
  if exists (select 1 from world_laws where code = p_code) then
    return jsonb_build_object('ok', false, 'reason', 'that law is already stored');
  end if;
  if char_length(v_reason) < 8 or v_reason ~* 'https?://' then
    return jsonb_build_object('ok', false, 'reason', 'a law needs a stored reason');
  end if;
  v_repeated := world_breach_count(null) >= 2;
  if not world_shortage_active() and not v_repeated then
    return jsonb_build_object('ok', false, 'reason', 'the record does not support a statute yet');
  end if;
  select * into ws from world_state where singleton;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'world is not initialized');
  end if;

  v_event := world_record_event(
    format('sim:law:%s', p_code),
    'civic.law_proclaimed',
    'world',
    case when p_decision is null then 'system' else 'ai' end,
    format('Commons Hall proclaimed %s. %s', p_code, v_reason),
    p_citizen,
    'commons-hall',
    null,
    now(),
    ws.last_tick_world_s,
    ws.tick_seq,
    jsonb_build_object('code', p_code, 'reason', v_reason),
    null,
    p_decision
  );

  insert into world_laws (code, status, reason, decision_id, event_id, world_s)
  values (p_code, 'proclaimed', v_reason, p_decision, v_event, ws.last_tick_world_s);

  if p_decision is not null then
    update ai_decisions
    set status = 'executed',
        outcome_event_id = coalesce(outcome_event_id, v_event),
        event_hash = coalesce(event_hash, (select event_hash from civilization_events where id = v_event))
    where id = p_decision and status in ('queued', 'accepted', 'proposed');
  end if;

  return jsonb_build_object('ok', true, 'code', p_code, 'eventId', v_event);
end;
$$;

create function world_levy_fine(p_citizen uuid, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_citizen uuid := p_citizen;
  v_event uuid;
  v_label text;
begin
  if not world_law_proclaimed('ration_fine') then
    return jsonb_build_object('ok', false, 'reason', 'no proclaimed law names a fine');
  end if;
  if v_citizen is null or world_breach_count(v_citizen) < 1 then
    select actor_citizen_id into v_citizen
    from civilization_events
    where kind = 'civic.breach' and actor_citizen_id is not null
    order by world_s desc nulls last, seq desc
    limit 1;
  end if;
  if v_citizen is null or world_breach_count(v_citizen) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'no breach is stored');
  end if;
  select * into ws from world_state where singleton;
  v_label := world_citizen_label(v_citizen);
  if world_stock('food') > 0 then
    perform world_store('food', -1, ws.tick_seq);
    v_event := world_record_event(
      format('sim:%s:levy:%s', v_citizen, ws.tick_seq),
      'civic.fine',
      'world',
      case when p_decision is null then 'system' else 'ai' end,
      format('%s drew a ration fine. One simulated food left the Storehouse.', v_label),
      v_citizen,
      'storehouse',
      null,
      now(),
      ws.last_tick_world_s,
      ws.tick_seq,
      jsonb_build_object('food', 1, 'movedFunds', false),
      null,
      p_decision
    );
  else
    v_event := world_record_event(
      format('sim:%s:levy-unpaid:%s', v_citizen, ws.tick_seq),
      'civic.fine_unpaid',
      'world',
      case when p_decision is null then 'system' else 'ai' end,
      format('The Storehouse had no food, so the fine against %s could not be taken.', v_label),
      v_citizen,
      'storehouse',
      null,
      now(),
      ws.last_tick_world_s,
      ws.tick_seq,
      jsonb_build_object('movedFunds', false),
      null,
      p_decision
    );
  end if;
  if p_decision is not null then
    update ai_decisions
    set status = 'executed', outcome_event_id = coalesce(outcome_event_id, v_event)
    where id = p_decision and status in ('queued', 'accepted', 'proposed');
  end if;
  return jsonb_build_object('ok', true, 'eventId', v_event, 'citizenId', v_citizen);
end;
$$;

create function world_detain_citizen(p_citizen uuid, p_decision uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_jail text;
  v_capacity integer;
  v_held integer;
  v_event uuid;
  v_end bigint;
begin
  if not exists (select 1 from world_laws where status = 'proclaimed') then
    return jsonb_build_object('ok', false, 'reason', 'a jail waits until a law is proclaimed');
  end if;
  if not exists (select 1 from civilization_events where kind = 'civic.fine_unpaid') then
    return jsonb_build_object('ok', false, 'reason', 'a fine still covers the offense');
  end if;
  if p_citizen is null or world_breach_count(p_citizen) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'no breach is stored');
  end if;
  select id, coalesce(capacity, 4) into v_jail, v_capacity
  from world_buildings
  where kind = 'jail' and status = 'active'
  order by id
  limit 1;
  if v_jail is null then
    return jsonb_build_object('ok', false, 'reason', 'a sentence needs a room');
  end if;
  select count(*)::int into v_held from world_sentences where jail_id = v_jail and released_at is null;
  if v_held >= v_capacity then
    return jsonb_build_object('ok', false, 'reason', 'the jail is full');
  end if;
  if exists (select 1 from world_sentences where citizen_id = p_citizen and released_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'this citizen is already sentenced');
  end if;
  select * into ws from world_state where singleton;
  v_end := ws.last_tick_world_s + 8 * 3600;
  insert into world_sentences (citizen_id, jail_id, offense, started_world_s, ends_world_s, decision_id)
  values (p_citizen, v_jail, 'stored breach', ws.last_tick_world_s, v_end, p_decision);
  v_event := world_record_event(
    format('sim:%s:sentenced:%s', p_citizen, ws.tick_seq),
    'civic.sentenced',
    'world',
    case when p_decision is null then 'system' else 'ai' end,
    format('%s is sentenced to eight world hours at the jail. There is no shift, no market, and no square until release.', world_citizen_label(p_citizen)),
    p_citizen,
    v_jail,
    null,
    now(),
    ws.last_tick_world_s,
    ws.tick_seq,
    jsonb_build_object('hours', 8, 'jailId', v_jail),
    null,
    p_decision
  );
  if p_decision is not null then
    update ai_decisions
    set status = 'executed', outcome_event_id = coalesce(outcome_event_id, v_event)
    where id = p_decision and status in ('queued', 'accepted', 'proposed');
  end if;
  return jsonb_build_object('ok', true, 'eventId', v_event, 'jailId', v_jail, 'endsWorldS', v_end);
end;
$$;

create function world_amend_law(p_code text, p_reason text, p_citizen uuid, p_decision uuid, p_pardon boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws world_state%rowtype;
  v_reason text := left(trim(coalesce(p_reason, '')), 240);
  v_status text := case when p_pardon then 'pardoned' else 'amended' end;
  v_event uuid;
  v_farmers integer;
begin
  if not exists (select 1 from world_laws where code = p_code and status = 'proclaimed') then
    return jsonb_build_object('ok', false, 'reason', 'that law is not proclaimed');
  end if;
  if char_length(v_reason) < 8 then
    return jsonb_build_object('ok', false, 'reason', 'a law needs a stored reason');
  end if;
  select count(*)::int into v_farmers
  from world_sentences s
  join citizen_world_state c on c.citizen_id = s.citizen_id
  where s.released_at is null and c.role = 'farmer';
  if v_farmers < 1 or world_stock('food') >= 40 then
    return jsonb_build_object('ok', false, 'reason', 'the jail is not crowding the fields');
  end if;
  select * into ws from world_state where singleton;
  update world_laws
  set status = v_status, reason = v_reason, decision_id = coalesce(p_decision, decision_id), world_s = ws.last_tick_world_s
  where code = p_code;
  v_event := world_record_event(
    format('sim:law:%s:%s:%s', v_status, p_code, ws.tick_seq),
    case when p_pardon then 'civic.pardoned' else 'civic.law_amended' end,
    'world',
    case when p_decision is null then 'system' else 'ai' end,
    format('Commons Hall %s %s because detained farmers were off the fields while food was under 40. %s', v_status, p_code, v_reason),
    p_citizen,
    'commons-hall',
    null,
    now(),
    ws.last_tick_world_s,
    ws.tick_seq,
    jsonb_build_object('code', p_code, 'status', v_status, 'detainedFarmers', v_farmers, 'reason', v_reason),
    null,
    p_decision
  );
  if p_decision is not null then
    update ai_decisions
    set status = 'executed', outcome_event_id = coalesce(outcome_event_id, v_event)
    where id = p_decision and status in ('queued', 'accepted', 'proposed');
  end if;
  return jsonb_build_object('ok', true, 'code', p_code, 'status', v_status, 'eventId', v_event);
end;
$$;

create function world_civic_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_jail text;
  v_capacity integer;
  v_held integer;
  v_farmers integer;
  v_hostile integer;
begin
  select id, coalesce(capacity, 4) into v_jail, v_capacity
  from world_buildings
  where kind = 'jail' and status = 'active'
  order by id
  limit 1;
  select count(*)::int into v_held
  from world_sentences
  where released_at is null and (v_jail is null or jail_id = v_jail);
  select count(*)::int into v_farmers
  from world_sentences s
  join citizen_world_state c on c.citizen_id = s.citizen_id
  where s.released_at is null and c.role = 'farmer';
  select count(*)::int into v_hostile
  from (
    select actor_citizen_id
    from civilization_events
    where kind = 'civic.breach' and actor_citizen_id is not null
    group by actor_citizen_id
    having count(*) >= 2
  ) marked
  where world_is_hostile(marked.actor_citizen_id, coalesce((select last_tick_world_s from world_state), 0));

  return jsonb_build_object(
    'bankId', (select id from world_buildings where kind = 'bank' and status = 'active' order by id limit 1),
    'jailId', v_jail,
    'jailOccupants', coalesce(v_held, 0),
    'jailCapacity', coalesce(v_capacity, 0),
    'breachCount', world_breach_count(null),
    'repeatedBreach', world_breach_count(null) >= 2,
    'shortageActive', world_shortage_active(),
    'unpaidFine', exists (select 1 from civilization_events where kind = 'civic.fine_unpaid'),
    'hostileCount', coalesce(v_hostile, 0),
    'detainedFarmers', coalesce(v_farmers, 0),
    'food', world_stock('food'),
    'breachTokens', coalesce((
      select jsonb_agg(token_id order by latest desc)
      from (
        select c.token_id::text as token_id, max(e.world_s) as latest
        from civilization_events e
        join citizens c on c.id = e.actor_citizen_id
        where e.kind = 'civic.breach'
        group by c.token_id
        order by max(e.world_s) desc nulls last
        limit 8
      ) marked
    ), '[]'::jsonb),
    'laws', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'status', status) order by proclaimed_at)
      from world_laws
    ), '[]'::jsonb)
  );
end;
$$;

select world_open_civic_places();

-- Access ---------------------------------------------------------------------

do $$
declare
  table_name text;
  role_name text;
  fn regprocedure;
begin
  foreach table_name in array array['world_laws', 'world_sentences']
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

  foreach fn in array array[
    'world_open_civic_places()'::regprocedure,
    'world_proclaim_law(text,text,uuid,uuid)'::regprocedure,
    'world_levy_fine(uuid,uuid)'::regprocedure,
    'world_detain_citizen(uuid,uuid)'::regprocedure,
    'world_amend_law(text,text,uuid,uuid,boolean)'::regprocedure,
    'world_civic_snapshot()'::regprocedure,
    'world_clock_at(bigint)'::regprocedure,
    'world_record_breach(uuid,text,text,bigint,bigint,boolean)'::regprocedure,
    'world_maybe_offense(uuid,bigint,text)'::regprocedure,
    'world_release_due(uuid,bigint)'::regprocedure
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
    grant execute on function world_open_civic_places() to service_role;
    grant execute on function world_proclaim_law(text, text, uuid, uuid) to service_role;
    grant execute on function world_levy_fine(uuid, uuid) to service_role;
    grant execute on function world_detain_citizen(uuid, uuid) to service_role;
    grant execute on function world_amend_law(text, text, uuid, uuid, boolean) to service_role;
    grant execute on function world_civic_snapshot() to service_role;
  end if;
end $$;
