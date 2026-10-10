-- Chog Civilization, initial schema.
--
-- Apply this in a Supabase project when one exists. Phase 0 does not connect
-- the dashboard to a database.
--
-- Balances are not stored as current truth. balance_observations records a
-- raw integer amount at a block, read from an RPC. A business ledger entry
-- is on-chain verified only when it points at a transaction receipt that was
-- itself fetched from Monad. There is no wealth column and no maximum number
-- of businesses.

create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table civilization_state (
  singleton boolean primary key default true check (singleton),
  name text not null,
  status text not null check (status in ('foundation', 'active', 'paused')),
  summary text not null,
  treasury_wallet_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table civilization_state is
  'Single shared civilization. One row. Treasury is a wallet, not a balance.';

create table citizens (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (143, 10143)),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  enrollment_status text not null default 'pending'
    check (enrollment_status in ('pending', 'active', 'suspended', 'withdrawn')),
  observed_owner text check (observed_owner is null or observed_owner ~ '^0x[0-9a-fA-F]{40}$'),
  ownership_observed_block bigint,
  ownership_observed_at timestamptz,
  enrolled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, nft_contract, token_id)
);

comment on column citizens.observed_owner is
  'Last ownerOf result observed from Monad. Not a signing key and not proof that the row is still current.';

create table citizen_profiles (
  citizen_id uuid primary key references citizens (id) on delete cascade,
  life_status text not null default 'unknown'
    check (life_status in ('unknown', 'active', 'away', 'inactive')),
  biography text,
  updated_at timestamptz not null default now()
);

comment on column citizen_profiles.life_status is
  'Application life status. This is not an on-chain enum.';

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'paused', 'closed')),
  summary text,
  founder_citizen_id uuid references citizens (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table businesses is
  'No supply cap. Legitimate businesses are not limited by the Chog Genesis mint size.';

create table citizen_skills (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  level smallint not null default 1 check (level between 1 and 100),
  evidence text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (citizen_id, name)
);

comment on column citizen_skills.level is
  'Proficiency scale from 1 to 100. It is not a limit on wealth or business activity.';

create table citizen_jobs (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete cascade,
  business_id uuid references businesses (id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'ended')),
  started_on date,
  ended_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_on is null or started_on is null or ended_on >= started_on)
);

create table citizen_relationships (
  id uuid primary key default gen_random_uuid(),
  from_citizen_id uuid not null references citizens (id) on delete cascade,
  to_citizen_id uuid not null references citizens (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 64),
  note text,
  formed_at timestamptz not null default now(),
  check (from_citizen_id <> to_citizen_id)
);

create unique index citizen_relationships_pair_kind
  on citizen_relationships (
    least(from_citizen_id, to_citizen_id),
    greatest(from_citizen_id, to_citizen_id),
    kind
  );

create table wallets (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (143, 10143)),
  address text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  kind text not null check (kind in ('citizen', 'business', 'treasury')),
  citizen_id uuid references citizens (id) on delete restrict,
  business_id uuid references businesses (id) on delete restrict,
  factory_address text check (factory_address is null or factory_address ~ '^0x[0-9a-fA-F]{40}$'),
  deployment_tx_hash text check (
    deployment_tx_hash is null or deployment_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  deployed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'citizen' and citizen_id is not null and business_id is null)
    or (kind = 'business' and business_id is not null and citizen_id is null)
    or (kind = 'treasury' and citizen_id is null and business_id is null)
  ),
  unique (chain_id, address)
);

comment on table wallets is
  'Addresses of smart wallets after they exist on Monad. Presence of a row does not prove a balance.';

create unique index wallets_one_treasury_per_chain
  on wallets (chain_id)
  where kind = 'treasury';

create unique index wallets_one_citizen_per_chain
  on wallets (citizen_id, chain_id)
  where kind = 'citizen';

alter table civilization_state
  add constraint civilization_state_treasury_fk
  foreign key (treasury_wallet_id) references wallets (id);

create table civilization_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 64),
  summary text not null,
  actor_citizen_id uuid references citizens (id) on delete set null,
  business_id uuid references businesses (id) on delete set null,
  chain_id integer check (chain_id is null or chain_id in (143, 10143)),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  chain_status text not null default 'offchain'
    check (chain_status in ('offchain', 'submitted', 'confirmed')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on column civilization_events.chain_status is
  'offchain events are narrative. confirmed requires a matching transaction_receipts row written from an RPC receipt.';

create table ai_memories (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('civilization', 'citizen', 'business')),
  citizen_id uuid references citizens (id) on delete cascade,
  business_id uuid references businesses (id) on delete cascade,
  content text not null,
  importance smallint not null default 0 check (importance between 0 and 5),
  created_at timestamptz not null default now(),
  check (
    (scope = 'civilization' and citizen_id is null and business_id is null)
    or (scope = 'citizen' and citizen_id is not null and business_id is null)
    or (scope = 'business' and business_id is not null and citizen_id is null)
  )
);

comment on table ai_memories is
  'Off-chain memory for the AI. Do not store API keys, seed phrases, or private keys.';

create table ai_decisions (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,
  status text not null default 'draft'
    check (status in ('draft', 'proposed', 'rejected', 'accepted', 'failed')),
  rationale text,
  output jsonb,
  provider text,
  model text,
  created_at timestamptz not null default now()
);

comment on table ai_decisions is
  'A decision record is not permission to move assets. Execution stays in the wallet policy.';

create table proposals (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid references ai_decisions (id) on delete set null,
  wallet_id uuid references wallets (id) on delete set null,
  kind text not null check (char_length(kind) between 1 and 64),
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in (
      'draft',
      'pending',
      'approved',
      'rejected',
      'submitted',
      'confirmed',
      'failed',
      'cancelled'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table transaction_receipts (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (143, 10143)),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  proposal_id uuid references proposals (id) on delete set null,
  from_address text check (from_address is null or from_address ~ '^0x[0-9a-fA-F]{40}$'),
  to_address text check (to_address is null or to_address ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null check (status in ('success', 'reverted', 'unknown')),
  block_number bigint not null,
  raw_receipt jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (chain_id, tx_hash)
);

comment on table transaction_receipts is
  'Insert a row only from a receipt returned by a Monad node. The JSON is the chain record.';

create table supported_assets (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (143, 10143)),
  address text,
  kind text not null check (kind in ('native', 'erc20', 'erc721')),
  symbol text not null,
  decimals smallint check (decimals is null or (decimals between 0 and 36)),
  verification_status text not null
    check (verification_status in ('unverified', 'observed', 'source_verified')),
  notes text,
  created_at timestamptz not null default now(),
  check (
    (kind = 'native' and address is null)
    or (kind <> 'native' and address ~ '^0x[0-9a-fA-F]{40}$')
  )
);

create unique index supported_assets_native_per_chain
  on supported_assets (chain_id)
  where kind = 'native';

create unique index supported_assets_address_per_chain
  on supported_assets (chain_id, address)
  where address is not null;

create table business_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  summary text not null,
  asset_id uuid references supported_assets (id) on delete set null,
  amount_raw numeric(78, 0),
  is_onchain_verified boolean not null default false,
  receipt_id uuid references transaction_receipts (id) on delete set null,
  created_at timestamptz not null default now(),
  check (is_onchain_verified = false or receipt_id is not null)
);

comment on table business_ledger_entries is
  'Internal accounting. is_onchain_verified requires a transaction receipt row.';

create table balance_observations (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets (id) on delete cascade,
  asset_id uuid references supported_assets (id) on delete set null,
  asset_key text not null,
  amount_raw numeric(78, 0) not null,
  block_number bigint not null,
  observed_at timestamptz not null default now(),
  source text not null default 'rpc' check (source = 'rpc')
);

comment on table balance_observations is
  'Historical RPC readings. The latest row can be stale. Spendable balances must be read from Monad again.';

create index balance_observations_lookup
  on balance_observations (wallet_id, asset_key, block_number desc);

create index civilization_events_occurred_at
  on civilization_events (occurred_at desc);

create index proposals_status
  on proposals (status, created_at desc);

create trigger civilization_state_updated_at
  before update on civilization_state
  for each row execute function set_updated_at();

create trigger citizens_updated_at
  before update on citizens
  for each row execute function set_updated_at();

create trigger citizen_profiles_updated_at
  before update on citizen_profiles
  for each row execute function set_updated_at();

create trigger businesses_updated_at
  before update on businesses
  for each row execute function set_updated_at();

create trigger citizen_skills_updated_at
  before update on citizen_skills
  for each row execute function set_updated_at();

create trigger citizen_jobs_updated_at
  before update on citizen_jobs
  for each row execute function set_updated_at();

create trigger wallets_updated_at
  before update on wallets
  for each row execute function set_updated_at();

create trigger proposals_updated_at
  before update on proposals
  for each row execute function set_updated_at();

insert into civilization_state (name, status, summary)
values (
  'Chog Civilization',
  'foundation',
  'Phase 0. No citizens are enrolled, no citizen wallets are deployed, and the shared treasury does not exist yet.'
);

insert into supported_assets (chain_id, address, kind, symbol, decimals, verification_status, notes)
values
  (
    143,
    null,
    'native',
    'MON',
    18,
    'observed',
    'Native currency of Monad mainnet, chain id 143. No balance is stored here.'
  ),
  (
    143,
    '0x350035555E10d9AfAF1566AaebfCeD5BA6C27777',
    'erc20',
    'CHOG',
    18,
    'observed',
    'EIP-1167 proxy. name, symbol, decimals, and totalSupply responded on 2026-10-10. Source code was not verified.'
  ),
  (
    143,
    '0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763',
    'erc721',
    'CHOG',
    null,
    'source_verified',
    'Chog Genesis. ERC-721 and ERC-721 Metadata via supportsInterface. Monadscan source match. Not a treasury balance.'
  );

-- Enable row level security and remove default access from the Supabase
-- anon and authenticated roles when those roles exist. No policies are
-- created in this phase, so those roles cannot read or write. The service
-- role bypasses row level security and must stay on the server.

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'civilization_state',
    'citizens',
    'citizen_profiles',
    'businesses',
    'citizen_skills',
    'citizen_jobs',
    'citizen_relationships',
    'wallets',
    'civilization_events',
    'ai_memories',
    'ai_decisions',
    'proposals',
    'transaction_receipts',
    'supported_assets',
    'business_ledger_entries',
    'balance_observations'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
      end if;
    end loop;
  end loop;
end $$;

revoke all on function set_updated_at() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on function set_updated_at() from %I', role_name);
    end if;
  end loop;
end $$;
