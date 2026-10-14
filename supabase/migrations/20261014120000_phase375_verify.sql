-- Phase 3.75: tamper-evident event hashes, hash chain, Merkle batches, and
-- an AI provenance seam. Additive. Does not move buildings, reset citizens,
-- rewrite history bodies, or fabricate events. Hosted Postgres still has to
-- receive this file in the SQL editor; applying it in the repo does not
-- change production by itself.

create extension if not exists pgcrypto;

-- Canonical JSON: sorted object keys, no whitespace, JSON string escaping.
create or replace function verify_json_canonical(p jsonb)
returns text
language plpgsql
immutable
as $$
declare
  k text;
  parts text[] := '{}'::text[];
  i integer;
begin
  if p is null then
    return '';
  end if;
  case jsonb_typeof(p)
    when 'null' then
      return 'null';
    when 'boolean' then
      return p::text;
    when 'number' then
      return p::text;
    when 'string' then
      return to_json(p #>> '{}')::text;
    when 'array' then
      if jsonb_array_length(p) = 0 then
        return '[]';
      end if;
      for i in 0 .. jsonb_array_length(p) - 1 loop
        parts := parts || verify_json_canonical(p -> i);
      end loop;
      return '[' || array_to_string(parts, ',') || ']';
    else
      for k in select x from jsonb_object_keys(p) as x order by x
      loop
        parts := parts || (to_json(k)::text || ':' || verify_json_canonical(p -> k));
      end loop;
      return '{' || array_to_string(parts, ',') || '}';
  end case;
end;
$$;

create or replace function verify_utc_ms(p timestamptz)
returns text
language sql
immutable
as $$
  select to_char(timezone('utc', p), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function verify_event_document(
  p_id uuid,
  p_seq bigint,
  p_kind text,
  p_category text,
  p_source text,
  p_summary text,
  p_occurred timestamptz,
  p_created timestamptz,
  p_world bigint,
  p_tick bigint,
  p_actor uuid,
  p_related uuid,
  p_building text,
  p_chain_status text,
  p_chain_id integer,
  p_tx_hash text,
  p_dedupe text,
  p_intent uuid,
  p_decision uuid,
  p_payload jsonb,
  p_transition jsonb,
  p_prev text
)
returns text
language sql
immutable
as $$
  select concat_ws(E'\n',
    'chogos-event-v1',
    'id:' || lower(p_id::text),
    'seq:' || p_seq::text,
    'kind:' || p_kind,
    'category:' || p_category,
    'source:' || p_source,
    'summary:' || replace(replace(replace(p_summary, E'\r\n', ' '), E'\n', ' '), E'\r', ' '),
    'occurredAt:' || verify_utc_ms(p_occurred),
    'createdAt:' || verify_utc_ms(p_created),
    'worldS:' || coalesce(p_world::text, ''),
    'tickSeq:' || coalesce(p_tick::text, ''),
    'actorCitizenId:' || coalesce(lower(p_actor::text), ''),
    'relatedCitizenId:' || coalesce(lower(p_related::text), ''),
    'buildingId:' || coalesce(p_building, ''),
    'chainStatus:' || p_chain_status,
    'chainId:' || coalesce(p_chain_id::text, ''),
    'txHash:' || coalesce(lower(p_tx_hash), ''),
    'dedupeKey:' || coalesce(p_dedupe, ''),
    'intentId:' || coalesce(lower(p_intent::text), ''),
    'decisionId:' || coalesce(lower(p_decision::text), ''),
    'payload:' || verify_json_canonical(coalesce(p_payload, '{}'::jsonb)),
    'stateTransition:' || verify_json_canonical(coalesce(p_transition, '{}'::jsonb)),
    'prevEventHash:' || coalesce(lower(p_prev), '')
  ) || E'\n'
$$;

create or replace function verify_sha256_hex(p_text text)
returns text
language sql
immutable
as $$
  select '0x' || encode(digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;

alter table civilization_events
  add column if not exists state_transition jsonb not null default '{}'::jsonb,
  add column if not exists intent_id uuid references world_intents (id) on delete set null,
  add column if not exists decision_id uuid references ai_decisions (id) on delete set null,
  add column if not exists integrity_schema text,
  add column if not exists integrity_class text check (integrity_class in ('historical', 'live')),
  add column if not exists event_hash text check (event_hash is null or event_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists prev_event_hash text check (prev_event_hash is null or prev_event_hash ~ '^0x[0-9a-f]{64}$');

comment on column civilization_events.state_transition is
  'Optional structured before/after refs. Empty object when the writer did not capture a transition.';
comment on column civilization_events.event_hash is
  'SHA-256 of the chogos-event-v1 canonical document. Null on rows that predate the verification cutover until a labeled snapshot hashes them.';
comment on column civilization_events.integrity_class is
  'historical: content hash for a snapshot committed later. live: participates in the post-cutover hash chain.';

alter table ai_decisions
  add column if not exists citizen_id uuid references citizens (id) on delete set null,
  add column if not exists input_commitment text check (input_commitment is null or input_commitment ~ '^0x[0-9a-f]{64}$'),
  add column if not exists proposed_action jsonb,
  add column if not exists validation_result text,
  add column if not exists intent_id uuid references world_intents (id) on delete set null,
  add column if not exists outcome_event_id uuid references civilization_events (id) on delete set null,
  add column if not exists event_hash text check (event_hash is null or event_hash ~ '^0x[0-9a-f]{64}$');

comment on column ai_decisions.input_commitment is
  'Hash of decision context, not the raw prompt. A stored provider or model name is not proof that that vendor produced the bytes.';
comment on column ai_decisions.event_hash is
  'Hash of the civilization event that records the actual simulation outcome, when one exists.';

create table if not exists event_integrity_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('live', 'historical_snapshot')),
  tree_format text not null default 'openzeppelin-standard-v1',
  from_seq bigint not null,
  to_seq bigint not null,
  event_count integer not null check (event_count > 0),
  merkle_root text not null check (merkle_root ~ '^0x[0-9a-f]{64}$'),
  dump jsonb not null,
  snapshot_committed_at timestamptz,
  anchor_status text not null default 'unanchored'
    check (anchor_status in ('unanchored', 'submitted', 'confirmed', 'failed')),
  anchor_chain_id integer check (anchor_chain_id is null or anchor_chain_id in (143, 10143)),
  anchor_contract text check (anchor_contract is null or anchor_contract ~ '^0x[0-9a-fA-F]{40}$'),
  anchor_tx_hash text check (anchor_tx_hash is null or anchor_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  anchor_block_number bigint,
  created_at timestamptz not null default now(),
  check (to_seq >= from_seq),
  check (kind <> 'historical_snapshot' or snapshot_committed_at is not null),
  check (anchor_status = 'unanchored' or (anchor_chain_id is not null and anchor_contract is not null))
);

comment on table event_integrity_batches is
  'Merkle batches of event hashes. A confirmed onchain root commits to this data, not to the truth of the simulation.';

create unique index if not exists event_integrity_batches_root
  on event_integrity_batches (merkle_root);
create unique index if not exists event_integrity_batches_range_kind
  on event_integrity_batches (kind, from_seq, to_seq);

create table if not exists event_integrity_proofs (
  event_id uuid primary key references civilization_events (id) on delete restrict,
  batch_id uuid not null references event_integrity_batches (id) on delete restrict,
  proof jsonb not null,
  created_at timestamptz not null default now()
);

alter table civilization_events
  add column if not exists merkle_batch_id uuid references event_integrity_batches (id) on delete set null;

create unique index if not exists civilization_events_event_hash
  on civilization_events (event_hash)
  where event_hash is not null;

create index if not exists civilization_events_live_chain
  on civilization_events (seq)
  where integrity_class = 'live' and event_hash is not null;

create table if not exists verification_state (
  singleton boolean primary key default true check (singleton),
  integrity_schema text not null default 'chogos-event-v1',
  tree_format text not null default 'openzeppelin-standard-v1',
  cutover_seq bigint,
  cutover_at timestamptz,
  cutover_event_id uuid references civilization_events (id),
  snapshot_batch_id uuid references event_integrity_batches (id),
  live_head_seq bigint,
  live_head_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into verification_state (singleton) values (true)
on conflict (singleton) do nothing;

create or replace function civilization_events_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'civilization_events is append-only';
  end if;
  if (new.id, new.seq, new.kind, new.category, new.source, new.summary, new.payload,
      new.occurred_at, new.created_at, new.world_s, new.tick_seq, new.actor_citizen_id,
      new.related_citizen_id, new.building_id, new.chain_status, new.chain_id, new.tx_hash,
      new.dedupe_key, new.schema_version, new.state_transition, new.intent_id, new.decision_id)
     is distinct from
     (old.id, old.seq, old.kind, old.category, old.source, old.summary, old.payload,
      old.occurred_at, old.created_at, old.world_s, old.tick_seq, old.actor_citizen_id,
      old.related_citizen_id, old.building_id, old.chain_status, old.chain_id, old.tx_hash,
      old.dedupe_key, old.schema_version, old.state_transition, old.intent_id, old.decision_id)
  then
    raise exception 'civilization_events history fields cannot be updated';
  end if;
  if old.event_hash is not null and new.event_hash is distinct from old.event_hash then
    raise exception 'event_hash is write-once';
  end if;
  if old.prev_event_hash is not null and new.prev_event_hash is distinct from old.prev_event_hash then
    raise exception 'prev_event_hash is write-once';
  end if;
  if old.merkle_batch_id is not null and new.merkle_batch_id is distinct from old.merkle_batch_id then
    raise exception 'merkle_batch_id is write-once';
  end if;
  if old.integrity_class is not null and new.integrity_class is distinct from old.integrity_class then
    raise exception 'integrity_class is write-once';
  end if;
  return new;
end;
$$;

drop trigger if exists civilization_events_append_only on civilization_events;
create trigger civilization_events_append_only
  before update or delete on civilization_events
  for each row execute function civilization_events_append_only();

create or replace function civilization_events_seal_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_doc text;
  v_hash text;
  v_cutover timestamptz;
begin
  select cutover_at into v_cutover from verification_state where singleton;
  if v_cutover is null then
    return new;
  end if;
  if new.event_hash is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('chogos.event_integrity'));
  select e.event_hash into v_prev
  from civilization_events e
  where e.integrity_class = 'live' and e.event_hash is not null and e.seq < new.seq
  order by e.seq desc
  limit 1;

  v_doc := verify_event_document(
    new.id, new.seq, new.kind, new.category, new.source, new.summary,
    new.occurred_at, new.created_at, new.world_s, new.tick_seq,
    new.actor_citizen_id, new.related_citizen_id, new.building_id,
    new.chain_status, new.chain_id, new.tx_hash, new.dedupe_key,
    new.intent_id, new.decision_id, new.payload, new.state_transition, v_prev
  );
  v_hash := verify_sha256_hex(v_doc);

  update civilization_events
  set
    integrity_schema = 'chogos-event-v1',
    integrity_class = 'live',
    prev_event_hash = v_prev,
    event_hash = v_hash
  where id = new.id;

  update verification_state
  set live_head_seq = new.seq, live_head_hash = v_hash, updated_at = now()
  where singleton;
  return new;
end;
$$;

drop trigger if exists civilization_events_seal_live on civilization_events;
create trigger civilization_events_seal_live
  after insert on civilization_events
  for each row execute function civilization_events_seal_live();

create or replace function verify_hash_historical()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r civilization_events%rowtype;
  v_doc text;
  v_hash text;
  v_n integer := 0;
  v_cutover bigint;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.event_integrity'));
  select cutover_seq into v_cutover from verification_state where singleton;
  if v_cutover is null then
    return jsonb_build_object('status', 'cutover_required');
  end if;
  for r in
    select * from civilization_events
    where event_hash is null and seq <= v_cutover
    order by seq
  loop
    v_doc := verify_event_document(
      r.id, r.seq, r.kind, r.category, r.source, r.summary,
      r.occurred_at, r.created_at, r.world_s, r.tick_seq,
      r.actor_citizen_id, r.related_citizen_id, r.building_id,
      r.chain_status, r.chain_id, r.tx_hash, r.dedupe_key,
      r.intent_id, r.decision_id, r.payload, r.state_transition, null
    );
    v_hash := verify_sha256_hex(v_doc);
    update civilization_events
    set
      integrity_schema = 'chogos-event-v1',
      integrity_class = 'historical',
      prev_event_hash = null,
      event_hash = v_hash
    where id = r.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('status', 'hashed', 'count', v_n);
end;
$$;

create or replace function verify_cutover()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws verification_state%rowtype;
  v_seq bigint;
  v_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('chogos.event_integrity'));
  perform pg_advisory_xact_lock(hashtext('chogos.world_tick'));
  select * into ws from verification_state where singleton;
  if ws.cutover_at is not null then
    return jsonb_build_object(
      'status', 'already_cut_over',
      'cutoverSeq', ws.cutover_seq,
      'cutoverAt', ws.cutover_at
    );
  end if;
  select coalesce(max(seq), 0) into v_seq from civilization_events;
  -- Mark cutover before inserting the marker event so the seal trigger hashes
  -- it as live. Rows at or before v_seq stay unhashed until snapshot hashing.
  update verification_state
  set
    cutover_seq = v_seq,
    cutover_at = v_now,
    updated_at = v_now
  where singleton;
  v_id := world_record_event(
    'verification:cutover:v1',
    'verification.cutover',
    'world',
    'system',
    'Verification cutover. Events at or before this sequence may be snapshot-hashed later. New events join the live hash chain. A later snapshot does not prove original timestamps.',
    null, null, null, v_now,
    coalesce((select last_tick_world_s from world_state where singleton), 0),
    coalesce((select tick_seq from world_state where singleton), 0),
    jsonb_build_object('cutoverSeq', v_seq)
  );
  update verification_state
  set cutover_event_id = v_id, updated_at = clock_timestamp()
  where singleton;
  return jsonb_build_object('status', 'cut_over', 'cutoverSeq', v_seq, 'eventId', v_id);
end;
$$;

create or replace function verify_commit_batch(p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := p_batch ->> 'kind';
  v_from bigint := (p_batch ->> 'fromSeq')::bigint;
  v_to bigint := (p_batch ->> 'toSeq')::bigint;
  v_root text := lower(p_batch ->> 'root');
  v_format text := coalesce(p_batch ->> 'treeFormat', 'openzeppelin-standard-v1');
  v_count integer;
  v_id uuid;
  v_proof jsonb;
  v_now timestamptz := clock_timestamp();
  v_snap timestamptz;
  v_proofs jsonb;
  v_linked integer;
  v_class text;
begin
  perform pg_advisory_xact_lock(hashtext('chogos.event_integrity'));
  if v_kind not in ('live', 'historical_snapshot') or v_from is null or v_to is null or v_root !~ '^0x[0-9a-f]{64}$' then
    raise exception 'batch payload is missing kind, range, or root';
  end if;
  if v_format <> 'openzeppelin-standard-v1' then
    raise exception 'unsupported tree format';
  end if;
  if exists (select 1 from event_integrity_batches where merkle_root = v_root) then
    return jsonb_build_object('status', 'duplicate_root', 'root', v_root);
  end if;
  if exists (select 1 from event_integrity_batches where kind = v_kind and from_seq = v_from and to_seq = v_to) then
    return jsonb_build_object('status', 'duplicate_range');
  end if;

  v_class := case when v_kind = 'live' then 'live' else 'historical' end;
  select count(*) into v_count
  from civilization_events
  where seq between v_from and v_to
    and event_hash is not null
    and integrity_class = v_class
    and merkle_batch_id is null;
  if v_count = 0 then
    return jsonb_build_object('status', 'no_unbatched_events');
  end if;
  if v_count <> (p_batch ->> 'eventCount')::integer then
    return jsonb_build_object('status', 'count_mismatch', 'stored', v_count);
  end if;
  v_proofs := coalesce(p_batch -> 'proofs', '[]'::jsonb);
  if jsonb_typeof(v_proofs) <> 'array' or jsonb_array_length(v_proofs) <> v_count then
    return jsonb_build_object(
      'status', 'proof_count_mismatch',
      'stored', v_count,
      'proofs', case when jsonb_typeof(v_proofs) = 'array' then jsonb_array_length(v_proofs) else 0 end
    );
  end if;

  v_snap := case when v_kind = 'historical_snapshot' then v_now end;
  insert into event_integrity_batches (
    kind, tree_format, from_seq, to_seq, event_count, merkle_root, dump, snapshot_committed_at
  )
  values (v_kind, v_format, v_from, v_to, v_count, v_root, coalesce(p_batch -> 'dump', '{}'::jsonb), v_snap)
  returning id into v_id;

  for v_proof in select value from jsonb_array_elements(v_proofs)
  loop
    if not exists (
      select 1
      from civilization_events e
      where e.id = (v_proof ->> 'eventId')::uuid
        and e.seq between v_from and v_to
        and e.event_hash is not null
        and e.integrity_class = v_class
        and e.merkle_batch_id is null
    ) then
      raise exception 'proof event is not an unbatched hashed event in range';
    end if;
    insert into event_integrity_proofs (event_id, batch_id, proof)
    values ((v_proof ->> 'eventId')::uuid, v_id, v_proof -> 'proof');
    update civilization_events
    set merkle_batch_id = v_id
    where id = (v_proof ->> 'eventId')::uuid and merkle_batch_id is null;
  end loop;

  select count(*) into v_linked from civilization_events where merkle_batch_id = v_id;
  if v_linked <> v_count then
    raise exception 'batch proofs did not cover every unbatched event in range';
  end if;

  if v_kind = 'historical_snapshot' then
    update verification_state set snapshot_batch_id = v_id, updated_at = v_now where singleton;
  end if;

  return jsonb_build_object('status', 'committed', 'batchId', v_id, 'root', v_root, 'eventCount', v_count);
end;
$$;

create or replace function verify_record_correction(p_original uuid, p_summary text, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orig civilization_events%rowtype;
  v_id uuid;
begin
  select * into v_orig from civilization_events where id = p_original;
  if not found then
    raise exception 'original event is missing';
  end if;
  v_id := world_record_event(
    format('verification:correction:%s', p_original),
    'verification.correction',
    'world',
    'system',
    p_summary,
    v_orig.actor_citizen_id,
    v_orig.building_id,
    v_orig.related_citizen_id,
    clock_timestamp(),
    v_orig.world_s,
    v_orig.tick_seq,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('originalEventId', p_original, 'originalSeq', v_orig.seq)
  );
  return v_id;
end;
$$;

create or replace function verify_record_anchor(
  p_batch uuid,
  p_status text,
  p_chain_id integer,
  p_contract text,
  p_tx text,
  p_block bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('submitted', 'confirmed', 'failed', 'unanchored') then
    raise exception 'invalid anchor status';
  end if;
  if p_status = 'confirmed' and (p_chain_id is null or p_contract is null or p_tx is null or p_block is null) then
    raise exception 'confirmed anchor requires chain, contract, tx, and block';
  end if;
  update event_integrity_batches
  set
    anchor_status = p_status,
    anchor_chain_id = p_chain_id,
    anchor_contract = p_contract,
    anchor_tx_hash = p_tx,
    anchor_block_number = p_block
  where id = p_batch;
  if not found then
    return jsonb_build_object('status', 'missing_batch');
  end if;
  return jsonb_build_object('status', 'updated');
end;
$$;

do $$
declare
  table_name text;
  role_name text;
  fn text;
begin
  foreach table_name in array array['event_integrity_batches', 'event_integrity_proofs', 'verification_state']
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
    'verify_json_canonical(jsonb)',
    'verify_utc_ms(timestamptz)',
    'verify_event_document(uuid,bigint,text,text,text,text,timestamptz,timestamptz,bigint,bigint,uuid,uuid,text,text,integer,text,text,uuid,uuid,jsonb,jsonb,text)',
    'verify_sha256_hex(text)',
    'civilization_events_append_only()',
    'civilization_events_seal_live()',
    'verify_hash_historical()',
    'verify_cutover()',
    'verify_commit_batch(jsonb)',
    'verify_record_correction(uuid,text,jsonb)',
    'verify_record_anchor(uuid,text,integer,text,text,bigint)'
  ]
  loop
    begin
      execute format('revoke all on function %s from public', fn);
      foreach role_name in array array['anon', 'authenticated', 'service_role']
      loop
        if exists (select 1 from pg_roles where rolname = role_name) then
          execute format('revoke all on function %s from %I', fn, role_name);
        end if;
      end loop;
    exception when undefined_function then
      null;
    end;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function verify_cutover() to service_role;
    grant execute on function verify_hash_historical() to service_role;
    grant execute on function verify_commit_batch(jsonb) to service_role;
    grant execute on function verify_record_correction(uuid, text, jsonb) to service_role;
    grant execute on function verify_record_anchor(uuid, text, integer, text, text, bigint) to service_role;
    grant execute on function verify_event_document(uuid,bigint,text,text,text,text,timestamptz,timestamptz,bigint,bigint,uuid,uuid,text,text,integer,text,text,uuid,uuid,jsonb,jsonb,text) to service_role;
    grant execute on function verify_sha256_hex(text) to service_role;
    grant execute on function verify_json_canonical(jsonb) to service_role;
    grant execute on function verify_utc_ms(timestamptz) to service_role;
  end if;
end $$;
