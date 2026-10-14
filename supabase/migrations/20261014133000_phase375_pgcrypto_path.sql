-- Hosted Supabase keeps pgcrypto in schema `extensions`. The Phase 3.75
-- sealer set search_path = public, so digest() was invisible and cutover
-- failed. Additive. Does not move buildings, reset citizens, or rewrite
-- event bodies. Hashing old rows is still done in batches so the statement
-- does not time out on a large history.

create extension if not exists pgcrypto;

alter function verify_sha256_hex(text) set search_path = public, extensions;
alter function civilization_events_seal_live() set search_path = public, extensions;
alter function verify_hash_historical() set search_path = public, extensions;

create or replace function verify_hash_historical()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r civilization_events%rowtype;
  v_doc text;
  v_hash text;
  v_n integer := 0;
  v_left integer := 0;
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
    limit 1000
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
  select count(*) into v_left
  from civilization_events
  where event_hash is null and seq <= v_cutover;
  return jsonb_build_object('status', 'hashed', 'count', v_n, 'remaining', v_left);
end;
$$;
