-- Phase 6b: ChogBank activation requests, reservations, sponsored jobs, and ledger.
-- Additive only. Does not insert citizens, wallets, treasury balances, or activation
-- rows. Does not alter world_tick(). Predicted factory addresses are not deployed
-- accounts. This file is not applied to hosted Supabase in Phase 6b.

create table chogbank_activation_requests (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null references citizens (id) on delete restrict,
  chain_id integer not null check (chain_id = 143),
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_id numeric(78, 0) not null,
  motive text not null check (motive in ('start_business', 'trade_asset', 'payment', 'economic_opportunity')),
  goal text not null check (char_length(goal) between 1 and 180),
  proposed_actions text not null check (char_length(proposed_actions) between 1 and 320),
  revenue_hypothesis text not null default '' check (char_length(revenue_hypothesis) <= 240),
  estimated_deployment_wei numeric(78, 0) not null check (estimated_deployment_wei >= 0),
  estimated_gas_wei numeric(78, 0) not null check (estimated_gas_wei >= 0),
  decision_id uuid references ai_decisions (id) on delete set null,
  state text not null check (state in (
    'unassigned',
    'activation_requested',
    'awaiting_bank_approval',
    'predicted',
    'deployment_pending',
    'deployed',
    'authorization_pending',
    'active',
    'rejected',
    'deferred',
    'error'
  )),
  predicted_address text check (predicted_address is null or predicted_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text check (account_address is null or account_address ~ '^0x[0-9a-fA-F]{40}$'),
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (state in ('unassigned', 'activation_requested', 'awaiting_bank_approval', 'rejected', 'deferred', 'error')
      and account_address is null)
    or (state in ('predicted', 'deployment_pending') and account_address is null)
    or (state in ('deployed', 'authorization_pending', 'active') and account_address is not null)
  )
);

comment on table chogbank_activation_requests is
  'AI-requested citizen account lifecycle. Enrollment does not insert rows. deployed requires observed bytecode. active requires a live executor session.';

create trigger chogbank_activation_requests_updated_at
  before update on chogbank_activation_requests
  for each row execute function set_updated_at();

create unique index chogbank_activation_in_flight
  on chogbank_activation_requests (chain_id, lower(nft_contract), token_id)
  where state in (
    'activation_requested',
    'awaiting_bank_approval',
    'predicted',
    'deployment_pending',
    'deployed',
    'authorization_pending',
    'active'
  );

create unique index chogbank_activation_account
  on chogbank_activation_requests (chain_id, lower(account_address))
  where account_address is not null;

create table chogbank_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references chogbank_activation_requests (id) on delete restrict,
  bucket text not null check (bucket in ('gas', 'deployment', 'business_capital')),
  amount_wei numeric(78, 0) not null check (amount_wei >= 0),
  state text not null check (state in ('held', 'reconciled', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table chogbank_reservations is
  'Treasury holds before execution. Gas sponsorship is not business capital.';

create trigger chogbank_reservations_updated_at
  before update on chogbank_reservations
  for each row execute function set_updated_at();

create table chogbank_sponsored_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references chogbank_activation_requests (id) on delete restrict,
  idempotency_key text not null unique,
  op text not null check (op in ('factory.create', 'account.executeSession', 'account.invalidateSession')),
  target text not null check (target ~ '^0x[0-9a-fA-F]{40}$'),
  selector text not null check (selector ~ '^0x[0-9a-fA-F]{8}$'),
  value_wei numeric(78, 0) not null default 0 check (value_wei >= 0),
  estimated_gas_wei numeric(78, 0) not null default 0 check (estimated_gas_wei >= 0),
  state text not null check (state in ('queued', 'submitted', 'confirmed', 'reverted', 'failed')),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  gas_used_wei numeric(78, 0) check (gas_used_wei is null or gas_used_wei >= 0),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table chogbank_sponsored_jobs is
  'Authorized relayer jobs. A row is not a confirmed transaction until tx_hash and a receipt are recorded. The relayer is disabled until a signer backend exists.';

create trigger chogbank_sponsored_jobs_updated_at
  before update on chogbank_sponsored_jobs
  for each row execute function set_updated_at();

create table chogbank_ledger (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in (
    'treasury_balance',
    'gas_reserved',
    'gas_available',
    'deployment_spent',
    'sponsored_gas_spent',
    'business_capital',
    'citizen_earnings',
    'treasury_returns',
    'outstanding_capital',
    'realized_losses'
  )),
  delta_wei numeric(78, 0) not null,
  ref text not null,
  created_at timestamptz not null default now()
);

comment on table chogbank_ledger is
  'Observed treasury movements. Do not insert predicted profit. Gas spend is separate from business capital.';

do $$
declare
  table_name text;
  role_name text;
begin
  foreach table_name in array array[
    'chogbank_activation_requests',
    'chogbank_reservations',
    'chogbank_sponsored_jobs',
    'chogbank_ledger'
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
