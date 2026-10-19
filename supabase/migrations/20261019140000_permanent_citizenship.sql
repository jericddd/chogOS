-- Permanent citizenship and canonical Chog Genesis transfer activities.
-- Additive. Does not insert citizens, reset the world, or apply itself to hosted Supabase.
-- Operator recovery, after this file is applied by hand:
--   select repair_permanent_citizenship();
-- The statement below also runs that repair once. Running it again is safe.
-- Transfer activities are not invented from ownerOf. They are projected from
-- nft_transfer_logs, which the watcher writes. Backfill is:
--   select project_nft_transfer_activities('<chog genesis address>');
-- An empty watcher log table does not create a transfer activity.

comment on column citizens.founding_membership_active is
  'True once a founding ChogTreasury NFT is enrolled. An ownership transfer does not clear it.';

comment on column citizens.observed_owner is
  'Last observed owner. A transfer updates this snapshot and does not remove the citizen. Null or stale means the owner could not be read.';

alter table civilization_events
  add column if not exists canonical boolean not null default true;

comment on column civilization_events.canonical is
  'Presentation bit for reorgs. civilization_events stays append-only, so chain_status is not rewritten. False means the transfer log is no longer in the canonical watcher snapshot and must not be shown as confirmed.';

create or replace function world_eligible(p_chain integer, p_contract text)
returns table (citizen_id uuid)
language sql
stable
as $$
  select id
  from citizens
  where chain_id = p_chain
    and lower(nft_contract) = lower(p_contract)
    and enrollment_status = 'active'
$$;

comment on function world_eligible(integer, text) is
  'Permanent enrolled citizens. Treasury custody is not membership.';

-- A return keeps the stored home and job. A new citizen can still be placed.
-- Marking someone unavailable no longer clears those associations.
create or replace function world_sync_population(p_now timestamptz, p_tick bigint)
returns integer
language plpgsql
as $$
declare
  ws world_state%rowtype;
  v_world bigint;
  v_row record;
  v_home text;
  v_work text;
  v_role text;
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
      task = '{}'::jsonb, decision_source = 'system',
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
    if v_row.is_return then
      select s.home_id, s.work_id, s.role
        into v_home, v_work, v_role
      from citizen_world_state s
      where s.citizen_id = v_row.citizen_id;
      update citizen_world_state
      set
        activity = 'idle',
        location_id = coalesce(v_home, 'commons-square'),
        started_at = p_now,
        world_started_s = v_world,
        ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_ends),
        world_ends_s = v_ends,
        task = jsonb_build_object('action', 'idle', 'building', coalesce(v_home, 'commons-square')),
        decision_source = 'system',
        version = version + 1,
        updated_tick = p_tick
      where citizen_id = v_row.citizen_id;
    else
      v_home := world_open_home();
      select * into v_job from world_open_job();
      v_work := v_job.building;
      v_role := v_job.role;
      insert into citizen_world_state (
        citizen_id, role, home_id, work_id, activity, location_id, started_at, ends_at,
        world_started_s, world_ends_s, task, day_index, decision_source, version, updated_tick
      )
      values (
        v_row.citizen_id, v_role, v_home, v_work, 'idle', 'commons-square', p_now,
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
      jsonb_strip_nulls(jsonb_build_object('home', v_home, 'work', v_work, 'role', v_role))
    );
    v_changes := v_changes + 1;
  end loop;

  return v_changes;
end;
$$;

create or replace function nft_transfer_dedupe(p_contract text, p_tx text, p_log_index integer)
returns text
language sql
immutable
as $$
  select 'nft-transfer:143:' || lower(p_contract) || ':' || lower(p_tx) || ':' || p_log_index::text
$$;

create or replace function project_nft_transfer_activities(p_nft text)
returns jsonb
language plpgsql
as $$
declare
  v_inserted integer := 0;
  v_orphaned integer := 0;
  v_confirmed integer := 0;
  v_committed boolean := false;
begin
  if p_nft !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'nft contract address is invalid';
  end if;

  insert into civilization_events (
    dedupe_key, kind, category, source, summary, actor_citizen_id, occurred_at,
    chain_id, tx_hash, chain_status, payload, schema_version, canonical
  )
  select
    nft_transfer_dedupe(l.nft_contract, l.tx_hash, l.log_index),
    'nft.transferred',
    'onchain',
    'onchain',
    format(
      'Chog #%s transferred from %s to %s in block %s.',
      l.token_id::text, l.from_address, l.to_address, l.block_number::text
    ),
    c.id,
    l.created_at,
    143,
    l.tx_hash,
    'confirmed',
    jsonb_build_object(
      'tokenId', l.token_id::text,
      'from', l.from_address,
      'to', l.to_address,
      'blockNumber', l.block_number::text,
      'logIndex', l.log_index,
      'contract', l.nft_contract,
      'blockHash', l.block_hash
    ),
    1,
    true
  from nft_transfer_logs l
  left join citizens c
    on c.chain_id = 143
   and lower(c.nft_contract) = lower(l.nft_contract)
   and c.token_id = l.token_id
  where l.chain_id = 143
    and lower(l.nft_contract) = lower(p_nft)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_inserted = row_count;

  update citizens c
  set
    observed_owner = latest.to_address,
    ownership_observed_block = latest.block_number,
    ownership_observed_at = now()
  from (
    select distinct on (token_id)
      token_id, to_address, block_number
    from nft_transfer_logs
    where chain_id = 143 and lower(nft_contract) = lower(p_nft)
    order by token_id, block_number desc, tx_index desc, log_index desc
  ) latest
  where c.chain_id = 143
    and lower(c.nft_contract) = lower(p_nft)
    and c.token_id = latest.token_id
    and (
      c.observed_owner is distinct from latest.to_address
      or c.ownership_observed_block is distinct from latest.block_number
    );

  select exists (
    select 1
    from nft_transfer_cursors
    where chain_id = 143
      and lower(nft_contract) = lower(p_nft)
      and last_success_at is not null
  ) into v_committed;

  if v_committed then
    update civilization_events e
    set canonical = true
    where e.kind = 'nft.transferred'
      and e.chain_id = 143
      and e.canonical is distinct from true
      and e.dedupe_key like 'nft-transfer:143:' || lower(p_nft) || ':%'
      and exists (
        select 1
        from nft_transfer_logs l
        where l.chain_id = 143
          and lower(l.nft_contract) = lower(p_nft)
          and e.dedupe_key = nft_transfer_dedupe(l.nft_contract, l.tx_hash, l.log_index)
      );
    get diagnostics v_confirmed = row_count;

    update civilization_events e
    set canonical = false
    where e.kind = 'nft.transferred'
      and e.chain_id = 143
      and e.canonical
      and e.dedupe_key like 'nft-transfer:143:' || lower(p_nft) || ':%'
      and not exists (
        select 1
        from nft_transfer_logs l
        where l.chain_id = 143
          and lower(l.nft_contract) = lower(p_nft)
          and e.dedupe_key = nft_transfer_dedupe(l.nft_contract, l.tx_hash, l.log_index)
      );
    get diagnostics v_orphaned = row_count;
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'reconfirmed', v_confirmed,
    'orphaned', v_orphaned
  );
end;
$$;

comment on function project_nft_transfer_activities(text) is
  'Projects canonical nft_transfer_logs into Onchain activities and updates observed owners. Does not create or delete citizens. Does not invent a log.';

create or replace function repair_permanent_citizenship()
returns jsonb
language plpgsql
as $$
declare
  ws world_state%rowtype;
  v_world bigint;
  v_ends bigint;
  v_citizens integer := 0;
  v_roster integer := 0;
  v_restored integer := 0;
begin
  update citizens
  set
    enrollment_status = 'active',
    founding_membership_active = true
  where origin = 'founding_treasury'
    and enrollment_status in ('active', 'suspended')
    and (enrollment_status = 'suspended' or founding_membership_active = false);
  get diagnostics v_citizens = row_count;

  update genesis_roster r
  set
    membership_active = true,
    left_treasury_at = null
  from citizens c
  where r.citizen_id = c.id
    and c.origin = 'founding_treasury'
    and c.enrollment_status = 'active'
    and (r.membership_active is distinct from true or r.left_treasury_at is not null);
  get diagnostics v_roster = row_count;

  update citizen_world_state s
  set
    home_id = coalesce(
      s.home_id,
      case when exists (select 1 from world_buildings b where b.id = evidence.home) then evidence.home else null end
    ),
    work_id = coalesce(
      s.work_id,
      case when exists (select 1 from world_buildings b where b.id = evidence.work) then evidence.work else null end
    ),
    role = coalesce(
      s.role,
      case
        when exists (select 1 from world_buildings b where b.id = coalesce(s.work_id, evidence.work))
          and evidence.role in ('farmer', 'woodcutter', 'stonecutter', 'crafter', 'merchant', 'builder')
          then evidence.role
        else null
      end
    )
  from (
    select
      c.id as citizen_id,
      home.building as home,
      job.building as work,
      job.role as role
    from citizens c
    join citizen_world_state current_state on current_state.citizen_id = c.id
    left join lateral (
      select coalesce(
        nullif(e.payload->>'home', ''),
        case when e.kind in ('citizen.sleep', 'movement.arrived_home') then e.building_id end
      ) as building
      from civilization_events e
      where e.actor_citizen_id = c.id
        and (
          (e.kind in ('citizen.sleep', 'movement.arrived_home') and e.building_id is not null)
          or (
            e.kind in ('citizen.joined_world', 'citizen.returned')
            and nullif(e.payload->>'home', '') is not null
          )
        )
      order by e.seq desc
      limit 1
    ) home on true
    left join lateral (
      select
        coalesce(nullif(e.payload->>'work', ''), e.building_id) as building,
        nullif(e.payload->>'role', '') as role
      from civilization_events e
      where e.actor_citizen_id = c.id
        and (
          (
            e.kind in ('work.shift_started', 'resource.gathering_started')
            and e.building_id is not null
          )
          or (
            e.kind in ('citizen.joined_world', 'citizen.returned')
            and (nullif(e.payload->>'work', '') is not null or nullif(e.payload->>'role', '') is not null)
          )
        )
      order by e.seq desc
      limit 1
    ) job on true
    where c.enrollment_status = 'active'
      and current_state.activity = 'unavailable'
  ) evidence
  where s.citizen_id = evidence.citizen_id
    and s.activity = 'unavailable'
    and (s.home_id is null or s.work_id is null or s.role is null);

  if exists (select 1 from world_state where singleton) then
    select * into ws from world_state where singleton;
    v_world := world_s_at(ws.anchor_real, ws.anchor_world_s, ws.speed, now());
    v_ends := v_world + 600;
    update citizen_world_state s
    set
      activity = 'idle',
      location_id = coalesce(s.home_id, 'commons-square'),
      origin_id = null,
      destination_id = null,
      purpose = null,
      started_at = now(),
      world_started_s = v_world,
      ends_at = world_real_at(ws.anchor_real, ws.anchor_world_s, ws.speed, v_ends),
      world_ends_s = v_ends,
      task = jsonb_build_object(
        'action', 'idle',
        'building', coalesce(s.home_id, 'commons-square'),
        'restored', true
      ),
      decision_source = 'system',
      version = s.version + 1
    from citizens c
    where s.citizen_id = c.id
      and c.enrollment_status = 'active'
      and s.activity = 'unavailable';
    get diagnostics v_restored = row_count;
  end if;

  return jsonb_build_object('citizens', v_citizens, 'roster', v_roster, 'restored', v_restored);
end;
$$;

comment on function repair_permanent_citizenship() is
  'Restores founding citizens suspended when an NFT left ChogTreasury. Does not insert citizens or assign a new home.';

-- Keep the Phase 6d snapshot replace, then project activities in the same transaction.
create or replace function save_nft_watcher_snapshot(payload jsonb)
returns void
language plpgsql
as $save$
declare
  nft text;
  watcher_seq integer;
begin
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'watcher snapshot must be a json object';
  end if;
  if payload->>'chainId' is distinct from '143' then
    raise exception 'watcher snapshot chain must be 143';
  end if;
  nft := payload->>'nftContract';
  if nft !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'watcher nft address is invalid';
  end if;
  if coalesce(payload->>'seq', '0') !~ '^[0-9]+$' then
    raise exception 'watcher seq is invalid';
  end if;
  watcher_seq := (payload->>'seq')::integer;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(payload->'invalidations', '[]'::jsonb)) item
    where coalesce(item->>'state', '') not in ('queued', 'submitted', 'confirmed', 'failed')
  ) then
    raise exception 'watcher invalidation state is not allowed';
  end if;

  delete from nft_watcher_invalidations where chain_id = 143 and lower(nft_contract) = lower(nft);
  delete from nft_watched_sessions where chain_id = 143 and lower(nft_contract) = lower(nft);
  delete from nft_transfer_logs where chain_id = 143 and lower(nft_contract) = lower(nft);
  delete from nft_transfer_blocks where chain_id = 143;
  delete from nft_watcher_state where chain_id = 143 and lower(nft_contract) = lower(nft);
  delete from nft_transfer_cursors where chain_id = 143 and lower(nft_contract) = lower(nft);

  insert into nft_transfer_cursors (
    chain_id, nft_contract, last_scanned_block, last_scanned_hash, last_success_at, last_error, backfill_from
  ) values (
    143,
    nft,
    nullif(payload#>>'{cursor,lastScannedBlock}', '')::bigint,
    nullif(payload#>>'{cursor,lastScannedHash}', ''),
    nullif(payload#>>'{cursor,lastSuccessAt}', '')::timestamptz,
    nullif(payload#>>'{cursor,lastError}', ''),
    nullif(payload#>>'{cursor,backfillFrom}', '')::bigint
  );

  insert into nft_transfer_blocks (chain_id, block_number, block_hash, parent_hash)
  select 143, (item->>'number')::bigint, item->>'hash', item->>'parentHash'
  from jsonb_array_elements(coalesce(payload->'blocks', '[]'::jsonb)) item;

  insert into nft_transfer_logs (
    chain_id, nft_contract, block_number, block_hash, tx_hash, tx_index, log_index, token_id, from_address, to_address
  )
  select 143,
    nft,
    (item->>'blockNumber')::bigint,
    item->>'blockHash',
    item->>'transactionHash',
    (item->>'transactionIndex')::integer,
    (item->>'logIndex')::integer,
    (item->>'tokenId')::numeric,
    item->>'from',
    item->>'to'
  from jsonb_array_elements(coalesce(payload->'logs', '[]'::jsonb)) item;

  insert into nft_watched_sessions (
    chain_id, nft_contract, request_id, token_id, opened_block, owner_at_open, account_address
  )
  select 143,
    nft,
    item->>'requestId',
    (item->>'tokenId')::numeric,
    (item->>'openedBlock')::bigint,
    item->>'ownerAtOpen',
    item->>'account'
  from jsonb_array_elements(coalesce(payload->'sessions', '[]'::jsonb)) item;

  insert into nft_watcher_invalidations (
    chain_id, nft_contract, id, request_id, transfer_identity, state, reason
  )
  select 143,
    nft,
    item->>'id',
    item->>'requestId',
    nullif(item->>'transferId', ''),
    item->>'state',
    item->>'reason'
  from jsonb_array_elements(coalesce(payload->'invalidations', '[]'::jsonb)) item;

  insert into nft_watcher_state (chain_id, nft_contract, seq)
  values (143, nft, watcher_seq);

  perform project_nft_transfer_activities(nft);
end
$save$;

comment on function save_nft_watcher_snapshot(jsonb) is
  'Replace the chain 143 watcher snapshot and project canonical transfers into Onchain activities. Not called by world_tick().';

revoke all on function nft_transfer_dedupe(text, text, integer) from public;
revoke all on function project_nft_transfer_activities(text) from public;
revoke all on function repair_permanent_citizenship() from public;
revoke all on function save_nft_watcher_snapshot(jsonb) from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on function nft_transfer_dedupe(text, text, integer) from %I', role_name);
      execute format('revoke all on function project_nft_transfer_activities(text) from %I', role_name);
      execute format('revoke all on function repair_permanent_citizenship() from %I', role_name);
      execute format('revoke all on function save_nft_watcher_snapshot(jsonb) from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function project_nft_transfer_activities(text) to service_role;
    grant execute on function repair_permanent_citizenship() to service_role;
    grant execute on function save_nft_watcher_snapshot(jsonb) to service_role;
  end if;
end $$;

select repair_permanent_citizenship();
