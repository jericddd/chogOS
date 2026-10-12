-- Phase 2: citizen wallet registry and the civilization treasury.
-- Additive only. This file does not insert citizens, token ids, or treasury addresses.
-- A row is not proof of a deployed wallet or a confirmed transfer.

create function prevent_wallet_address_replacement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'civilization_treasuries' then
    if old.address is not null and new.address is distinct from old.address then
      raise exception 'treasury address cannot be replaced';
    end if;
    return new;
  end if;
  if old.predicted_address is not null and new.predicted_address is distinct from old.predicted_address then
    raise exception 'predicted address cannot be replaced';
  end if;
  if old.account_address is not null and new.account_address is distinct from old.account_address then
    raise exception 'account address cannot be replaced';
  end if;
  return new;
end;
$$;

create table citizen_wallet_registry (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete restrict,
  chain_id integer not null check (chain_id in (143, 10143)),
  scheme text not null check (scheme in ('unassigned')),
  status text not null check (status in (
    'not_configured',
    'pending',
    'address_predicted',
    'deployment_pending',
    'deployed',
    'verified',
    'failed'
  )),
  predicted_address text check (predicted_address is null or predicted_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text check (account_address is null or account_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_type text not null default 'none' check (account_type in ('none', 'safe', 'erc6551', 'unknown')),
  factory_address text check (factory_address is null or factory_address ~ '^0x[0-9a-fA-F]{40}$'),
  implementation_address text check (implementation_address is null or implementation_address ~ '^0x[0-9a-fA-F]{40}$'),
  deployment_tx_hash text check (deployment_tx_hash is null or deployment_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  deployment_block bigint,
  code_hash text,
  detail text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (citizen_id, chain_id, scheme),
  check (
    (status = 'not_configured' and predicted_address is null and account_address is null)
    or (status = 'pending' and account_address is null)
    or (status = 'address_predicted' and predicted_address is not null and account_address is null)
    or (status = 'deployment_pending' and predicted_address is not null and account_address is null)
    or (status in ('deployed', 'verified') and account_address is not null)
    or status = 'failed'
  )
);

comment on table citizen_wallet_registry is
  'One assignment per citizen, chain, and wallet scheme. not_configured means no address exists. address_predicted is not deployment.';

create unique index citizen_wallet_predicted_address
  on citizen_wallet_registry (chain_id, lower(predicted_address))
  where predicted_address is not null;

create unique index citizen_wallet_account_address
  on citizen_wallet_registry (chain_id, lower(account_address))
  where account_address is not null;

create trigger citizen_wallet_registry_updated_at
  before update on citizen_wallet_registry
  for each row execute function set_updated_at();

create trigger citizen_wallet_registry_keep_address
  before update on citizen_wallet_registry
  for each row execute function prevent_wallet_address_replacement();

create table civilization_treasuries (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null unique check (chain_id in (143, 10143)),
  address text check (address is null or address ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null check (status in ('not_configured', 'configured', 'failed')),
  account_type text not null default 'unknown' check (account_type in ('unknown', 'eoa', 'contract')),
  verification text not null default 'unread' check (verification in ('unread', 'observed', 'safe_proxy')),
  safe_version text,
  code_hash text,
  detail text,
  configured_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    address is null
    or lower(address) <> lower('0x84113421A8a564b594ee9Ae78c875310332d7023')
  ),
  check (
    (status = 'not_configured' and address is null)
    or (status = 'configured' and address is not null)
    or status = 'failed'
  )
);

comment on table civilization_treasuries is
  'Shared economic treasury. Distinct from the ChogTreasury NFT wallet. No address is seeded.';

create trigger civilization_treasuries_updated_at
  before update on civilization_treasuries
  for each row execute function set_updated_at();

create trigger civilization_treasuries_keep_address
  before update on civilization_treasuries
  for each row execute function prevent_wallet_address_replacement();

create table treasury_funding (
  id uuid primary key default gen_random_uuid(),
  treasury_id uuid not null references civilization_treasuries (id) on delete restrict,
  chain_id integer not null check (chain_id in (143, 10143)),
  asset_kind text not null check (asset_kind in ('native', 'erc20', 'unknown')),
  token_address text check (token_address is null or token_address ~ '^0x[0-9a-fA-F]{40}$'),
  symbol text not null,
  decimals smallint check (decimals is null or decimals between 0 and 36),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  sender text check (sender is null or sender ~ '^0x[0-9a-fA-F]{40}$'),
  recipient text check (recipient is null or recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78, 0),
  block_number bigint,
  status text not null check (status in (
    'submitted',
    'pending',
    'confirmed',
    'failed',
    'reverted',
    'unverified'
  )),
  detail text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'confirmed' or (amount_raw is not null and recipient is not null and block_number is not null))
);

create unique index treasury_funding_once
  on treasury_funding (chain_id, lower(tx_hash), asset_kind, lower(coalesce(token_address, '')));

comment on table treasury_funding is
  'A confirmed row requires a receipt check. Entering a hash does not confirm a transfer.';

create table treasury_balance_readings (
  id uuid primary key default gen_random_uuid(),
  treasury_id uuid not null references civilization_treasuries (id) on delete cascade,
  asset_key text not null,
  symbol text not null,
  decimals smallint not null check (decimals between 0 and 36),
  amount_raw numeric(78, 0) not null,
  block_number bigint not null,
  observed_at timestamptz not null default now(),
  source text not null default 'rpc' check (source = 'rpc')
);

create index treasury_balance_readings_lookup
  on treasury_balance_readings (treasury_id, asset_key, block_number desc);

comment on table treasury_balance_readings is
  'Historical RPC readings for the civilization treasury. A failed read does not insert zero.';

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'citizen_wallet_registry',
    'civilization_treasuries',
    'treasury_funding',
    'treasury_balance_readings'
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

revoke all on function prevent_wallet_address_replacement() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on function prevent_wallet_address_replacement() from %I', role_name);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
