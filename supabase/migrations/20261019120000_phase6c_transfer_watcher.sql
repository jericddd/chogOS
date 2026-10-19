-- Phase 6c: restart-safe Chog Genesis transfer cursor, logs, and session invalidations.
-- Additive only. Does not insert citizens, balances, or activation rows.
-- Does not alter world_tick(). This file is not applied to hosted Supabase in Phase 6c.
-- A queued invalidation is not an onchain invalidateSession.

create table nft_transfer_cursors (
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  last_scanned_block bigint,
  last_scanned_hash text check (last_scanned_hash is null or last_scanned_hash ~ '^0x[0-9a-fA-F]{64}$'),
  last_success_at timestamptz,
  last_error text,
  backfill_from bigint,
  updated_at timestamptz not null default now(),
  primary key (chain_id, nft_contract)
);

comment on table nft_transfer_cursors is
  'Restart-safe scan cursor for Chog Genesis Transfer logs. Empty means the watcher has not run.';

create table nft_transfer_blocks (
  chain_id integer not null check (chain_id = 143),
  block_number bigint not null,
  block_hash text not null check (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  parent_hash text not null check (parent_hash ~ '^0x[0-9a-fA-F]{64}$'),
  primary key (chain_id, block_number)
);

comment on table nft_transfer_blocks is
  'Canonical block hashes observed by the watcher. A hash mismatch rewinds the cursor.';

create table nft_transfer_logs (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  block_number bigint not null,
  block_hash text not null check (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  tx_index integer not null check (tx_index >= 0),
  log_index integer not null check (log_index >= 0),
  token_id numeric(78, 0) not null,
  from_address text not null check (from_address ~ '^0x[0-9a-fA-F]{40}$'),
  to_address text not null check (to_address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at timestamptz not null default now(),
  unique (chain_id, block_hash, tx_hash, log_index)
);

comment on table nft_transfer_logs is
  'Idempotent ERC-721 Transfer observations. A row is not a session invalidation.';

create table nft_session_invalidations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references chogbank_activation_requests (id) on delete restrict,
  transfer_id uuid references nft_transfer_logs (id) on delete set null,
  state text not null check (state in ('queued', 'submitted', 'confirmed', 'failed')),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table nft_session_invalidations is
  'Queued means the watcher asked for invalidateSession. Confirmed requires a receipt. Queued is not completed.';

create unique index nft_session_invalidations_open
  on nft_session_invalidations (request_id)
  where state in ('queued', 'submitted', 'confirmed');

create trigger nft_session_invalidations_updated_at
  before update on nft_session_invalidations
  for each row execute function set_updated_at();

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'nft_transfer_cursors',
    'nft_transfer_blocks',
    'nft_transfer_logs',
    'nft_session_invalidations'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all privileges on table %I to service_role', table_name);
    end if;
  end loop;
end $$;
