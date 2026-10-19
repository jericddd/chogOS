-- Phase 6d: durable watcher sessions, invalidations, and snapshot functions.
-- Additive only. Does not insert citizens, balances, or activation rows.
-- Does not alter world_tick(). This file is not applied to hosted Supabase in Phase 6d.
-- A queued invalidation is not an onchain invalidateSession.
-- nft_session_invalidations stays as Phase 6c left it. These tables have no
-- foreign key to citizens or chogbank_activation_requests, so a restart can
-- store watcher state before any bank request exists.

create table nft_watched_sessions (
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  request_id text not null,
  token_id numeric(78, 0) not null,
  opened_block bigint not null,
  owner_at_open text not null check (owner_at_open ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text not null check (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  updated_at timestamptz not null default now(),
  primary key (chain_id, nft_contract, request_id)
);

comment on table nft_watched_sessions is
  'Sessions the watcher must invalidate after a later Chog Genesis transfer. A row is not an onchain session.';

create table nft_watcher_invalidations (
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  id text not null,
  request_id text not null,
  transfer_identity text,
  state text not null check (state in ('queued', 'submitted', 'confirmed', 'failed')),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, nft_contract, id)
);

comment on table nft_watcher_invalidations is
  'Queued means the watcher asked for invalidateSession. Confirmed requires a receipt. Queued is not completed.';

create unique index nft_watcher_invalidations_open
  on nft_watcher_invalidations (chain_id, nft_contract, request_id)
  where state in ('queued', 'submitted', 'confirmed');

create table nft_watcher_state (
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  seq integer not null check (seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (chain_id, nft_contract)
);

comment on table nft_watcher_state is
  'Monotonic id counter for watcher invalidations. Restarting must not reuse an id.';

create trigger nft_watched_sessions_updated_at
  before update on nft_watched_sessions
  for each row execute function set_updated_at();

create trigger nft_watcher_invalidations_updated_at
  before update on nft_watcher_invalidations
  for each row execute function set_updated_at();

create trigger nft_watcher_state_updated_at
  before update on nft_watcher_state
  for each row execute function set_updated_at();

create index nft_transfer_logs_token
  on nft_transfer_logs (chain_id, nft_contract, token_id);

create or replace function load_nft_watcher_snapshot(nft text)
returns jsonb
language plpgsql
stable
as $fn$
declare
  last_block bigint;
  last_hash text;
  last_success timestamptz;
  last_error text;
  backfill bigint;
  watcher_seq integer;
begin
  if nft !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'watcher nft address is invalid';
  end if;

  select c.last_scanned_block, c.last_scanned_hash, c.last_success_at, c.last_error, c.backfill_from
    into last_block, last_hash, last_success, last_error, backfill
  from nft_transfer_cursors c
  where c.chain_id = 143 and lower(c.nft_contract) = lower(nft);

  select s.seq into watcher_seq
  from nft_watcher_state s
  where s.chain_id = 143 and lower(s.nft_contract) = lower(nft);
  if not found then
    watcher_seq := 0;
  end if;

  return jsonb_build_object(
    'chainId', 143,
    'nftContract', nft,
    'cursor', jsonb_build_object(
      'lastScannedBlock', to_jsonb(last_block::text),
      'lastScannedHash', to_jsonb(last_hash),
      'lastSuccessAt', to_jsonb(last_success),
      'lastError', to_jsonb(last_error),
      'backfillFrom', to_jsonb(backfill::text)
    ),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'number', to_jsonb(block_number::text),
        'hash', block_hash,
        'parentHash', parent_hash
      ) order by block_number)
      from nft_transfer_blocks
      where chain_id = 143
    ), '[]'::jsonb),
    'logs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'blockNumber', to_jsonb(block_number::text),
        'blockHash', block_hash,
        'transactionHash', tx_hash,
        'transactionIndex', tx_index,
        'logIndex', log_index,
        'tokenId', to_jsonb(token_id::text),
        'from', from_address,
        'to', to_address
      ) order by block_number, tx_index, log_index)
      from nft_transfer_logs
      where chain_id = 143 and lower(nft_contract) = lower(nft)
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId', request_id,
        'tokenId', to_jsonb(token_id::text),
        'openedBlock', to_jsonb(opened_block::text),
        'ownerAtOpen', owner_at_open,
        'account', account_address
      ) order by request_id)
      from nft_watched_sessions
      where chain_id = 143 and lower(nft_contract) = lower(nft)
    ), '[]'::jsonb),
    'invalidations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'requestId', request_id,
        'transferId', transfer_identity,
        'state', state,
        'reason', reason
      ) order by id)
      from nft_watcher_invalidations
      where chain_id = 143 and lower(nft_contract) = lower(nft)
    ), '[]'::jsonb),
    'seq', watcher_seq
  );
end
$fn$;

comment on function load_nft_watcher_snapshot(text) is
  'Read-only watcher snapshot for chain 143. Log identity is recomputed by the caller, not by the uuid primary key.';

create or replace function save_nft_watcher_snapshot(payload jsonb)
returns void
language plpgsql
as $fn$
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
end
$fn$;

comment on function save_nft_watcher_snapshot(jsonb) is
  'Replace the chain 143 watcher snapshot in one transaction. Not called by world_tick().';

revoke all on function load_nft_watcher_snapshot(text) from public;
revoke all on function save_nft_watcher_snapshot(jsonb) from public;

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'nft_watched_sessions',
    'nft_watcher_invalidations',
    'nft_watcher_state'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
        execute format('revoke all on function load_nft_watcher_snapshot(text) from %I', role_name);
        execute format('revoke all on function save_nft_watcher_snapshot(jsonb) from %I', role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all privileges on table %I to service_role', table_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function load_nft_watcher_snapshot(text) to service_role;
    grant execute on function save_nft_watcher_snapshot(jsonb) to service_role;
  end if;
end $$;
