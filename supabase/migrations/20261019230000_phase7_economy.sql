-- Phase 7: economic proposals, reservations, and an append-only journal.
-- Additive and safe to re-run. Does not insert balances, citizens, wallets,
-- or transactions. Does not alter watcher checkpoints or earlier migrations.
-- This file is not applied to hosted Supabase by the Phase 7 change.
-- It stores no private key, signer, or RPC credential.
-- The economic treasury is an operator-configured public address. It is not
-- addresses.chogTreasury and it is not created by this migration.

create table if not exists economy_lock (
  id integer primary key check (id = 1),
  note text not null default 'serializes economy reservations and journal postings'
);

insert into economy_lock (id)
values (1)
on conflict (id) do nothing;

create table if not exists economy_controls (
  id integer primary key check (id = 1),
  execution_enabled boolean not null default false check (execution_enabled = false),
  note text not null default 'production execution stays disabled until a later reviewed migration'
);

insert into economy_controls (id)
values (1)
on conflict (id) do nothing;

create table if not exists economy_proposals (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  chain_id integer not null check (chain_id = 143),
  citizen_id uuid not null references citizens (id) on delete restrict,
  nft_contract text not null check (nft_contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  operation text not null check (operation in ('payment', 'purchase', 'trade', 'swap', 'business', 'return_capital')),
  objective text not null check (char_length(objective) between 1 and 180),
  rationale text not null check (char_length(rationale) between 1 and 320),
  expected_outcome text not null check (char_length(expected_outcome) between 1 and 240),
  target text check (target is null or target ~ '^0x[0-9a-fA-F]{40}$'),
  selector text check (selector is null or selector ~ '^0x[0-9a-fA-F]{8}$'),
  asset text not null check (asset in ('MON', 'CHOG')),
  amount_raw numeric(78, 0) not null check (amount_raw >= 0),
  estimated_gas_wei numeric(78, 0) not null check (estimated_gas_wei >= 0),
  funding_request_raw numeric(78, 0) not null check (funding_request_raw >= 0),
  quote_price_raw numeric(78, 0) check (quote_price_raw is null or quote_price_raw > 0),
  slippage_bps integer check (slippage_bps is null or (slippage_bps >= 0 and slippage_bps <= 1000)),
  status text not null check (status in (
    'proposed',
    'approved',
    'rejected',
    'deferred',
    'insufficient_funds',
    'budget_exhausted',
    'unsupported_protocol',
    'cancelled',
    'expired',
    'submitted',
    'confirmed',
    'reverted',
    'settled'
  )),
  decision text check (decision is null or decision in (
    'approved',
    'rejected',
    'deferred',
    'insufficient_funds',
    'budget_exhausted',
    'unsupported_protocol'
  )),
  reason text not null default '',
  attempts integer not null default 1 check (attempts >= 1 and attempts <= 3),
  executed boolean not null default false check (executed = false),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  receipt_chain_id integer check (receipt_chain_id is null or receipt_chain_id = 143),
  receipt_block_number numeric(78, 0) check (receipt_block_number is null or receipt_block_number >= 0),
  receipt_block_hash text check (receipt_block_hash is null or receipt_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  receipt_status text check (receipt_status is null or receipt_status in ('success', 'reverted')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    status not in ('confirmed', 'reverted', 'settled')
    or (
      tx_hash is not null
      and receipt_chain_id = 143
      and receipt_block_number is not null
      and receipt_block_hash is not null
      and (
        (status in ('confirmed', 'settled') and receipt_status = 'success')
        or (status = 'reverted' and receipt_status = 'reverted')
      )
    )
  )
);

comment on table economy_proposals is
  'Structured economic proposals. executed is constrained false. A row is not a broadcast or a balance.';

drop trigger if exists economy_proposals_updated_at on economy_proposals;
create trigger economy_proposals_updated_at
  before update on economy_proposals
  for each row execute function set_updated_at();

create index if not exists economy_proposals_token
  on economy_proposals (chain_id, lower(nft_contract), token_id, status);

create table if not exists economy_proposal_audit (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references economy_proposals (id) on delete restrict,
  status text not null,
  reason text not null check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

comment on table economy_proposal_audit is
  'Append-only proposal history. Status changes do not rewrite earlier rows.';

create index if not exists economy_proposal_audit_proposal
  on economy_proposal_audit (proposal_id, created_at);

create table if not exists economy_reservations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references economy_proposals (id) on delete restrict,
  idempotency_key text not null unique,
  chain_id integer not null check (chain_id = 143),
  token_id numeric(78, 0) not null check (token_id >= 0),
  asset text not null check (asset in ('MON', 'CHOG')),
  bucket text not null check (bucket in ('gas', 'deployment', 'business_capital')),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  observed_raw numeric(78, 0) not null check (observed_raw >= 0),
  state text not null check (state in ('held', 'reconciled', 'released')),
  authorizes_execution boolean not null default false check (authorizes_execution = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (bucket in ('gas', 'deployment') and asset = 'MON')
    or bucket = 'business_capital'
  )
);

comment on table economy_reservations is
  'Offchain holds against an observed balance. A hold is not a payment and authorizes_execution cannot be true. Gas is not business capital. economy_controls.execution_enabled stays false.';

drop trigger if exists economy_reservations_updated_at on economy_reservations;
create trigger economy_reservations_updated_at
  before update on economy_reservations
  for each row execute function set_updated_at();

create index if not exists economy_reservations_held
  on economy_reservations (asset, state);

create table if not exists economy_journal (
  id uuid primary key default gen_random_uuid(),
  posting_id text not null,
  account text not null check (account in ('treasury', 'external', 'spent', 'revenue', 'loss')),
  asset text not null check (asset in ('MON', 'CHOG')),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  side text not null check (side in ('debit', 'credit')),
  kind text not null check (kind in (
    'treasury_deposit',
    'treasury_return',
    'gas_spent',
    'deployment_spent',
    'capital_allocated',
    'payment',
    'purchase',
    'earnings',
    'revenue_returned',
    'loss_realized',
    'capital_recovered'
  )),
  source text not null check (source in ('proposal', 'chain')),
  ref text not null,
  status text not null check (status in ('proposed', 'submitted', 'observed', 'realized', 'reverted', 'rejected')),
  evidence_key text,
  citizen_token_id numeric(78, 0),
  created_at timestamptz not null default now(),
  check (
    (status in ('observed', 'realized') and source = 'chain' and evidence_key is not null)
    or (status = 'proposed' and evidence_key is null)
    or (status in ('submitted', 'reverted', 'rejected'))
  )
);

comment on table economy_journal is
  'Append-only double-entry lines. Observed and realized rows require chain evidence. Proposed rows do not change a counted balance.';

create unique index if not exists economy_journal_evidence
  on economy_journal (evidence_key, account, side)
  where evidence_key is not null;

create index if not exists economy_journal_ref
  on economy_journal (kind, ref, asset);

create or replace function economy_reject_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'this economy table is append-only';
end;
$$;

drop trigger if exists economy_journal_append_only on economy_journal;
create trigger economy_journal_append_only
  before update or delete on economy_journal
  for each row execute function economy_reject_mutation();

drop trigger if exists economy_proposal_audit_append_only on economy_proposal_audit;
create trigger economy_proposal_audit_append_only
  before update or delete on economy_proposal_audit
  for each row execute function economy_reject_mutation();

create or replace function economy_reservation_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.amount_raw is distinct from old.amount_raw
     or new.asset is distinct from old.asset
     or new.bucket is distinct from old.bucket
     or new.idempotency_key is distinct from old.idempotency_key
     or new.proposal_id is distinct from old.proposal_id
     or new.token_id is distinct from old.token_id
     or new.observed_raw is distinct from old.observed_raw then
    raise exception 'reservation identity is immutable';
  end if;
  if old.state <> 'held' and new.state is distinct from old.state then
    raise exception 'a settled reservation cannot change state';
  end if;
  if old.state = 'held' and new.state not in ('held', 'reconciled', 'released') then
    raise exception 'reservation state is invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists economy_reservations_immutable on economy_reservations;
create trigger economy_reservations_immutable
  before update on economy_reservations
  for each row execute function economy_reservation_immutable();

create or replace function economy_proposal_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.amount_raw is distinct from old.amount_raw
     or new.funding_request_raw is distinct from old.funding_request_raw
     or new.estimated_gas_wei is distinct from old.estimated_gas_wei
     or new.asset is distinct from old.asset
     or new.token_id is distinct from old.token_id
     or new.citizen_id is distinct from old.citizen_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.nft_contract is distinct from old.nft_contract
     or new.executed is distinct from false then
    raise exception 'proposal identity is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists economy_proposals_immutable on economy_proposals;
create trigger economy_proposals_immutable
  before update on economy_proposals
  for each row execute function economy_proposal_immutable();

create or replace function economy_proposal_status_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('confirmed', 'reverted', 'settled') then
    if new.tx_hash is null
       or new.tx_hash !~ '^0x[0-9a-fA-F]{64}$'
       or new.receipt_chain_id is distinct from 143
       or new.receipt_block_number is null
       or new.receipt_block_hash is null
       or new.receipt_block_hash !~ '^0x[0-9a-fA-F]{64}$' then
      raise exception 'a receipt status requires verified mainnet evidence';
    end if;
  end if;
  if new.status in ('confirmed', 'settled') and new.receipt_status is distinct from 'success' then
    raise exception 'confirmation requires a successful mainnet receipt';
  end if;
  if new.status = 'reverted' and new.receipt_status is distinct from 'reverted' then
    raise exception 'a reverted proposal requires a reverted mainnet receipt';
  end if;
  if new.status = 'settled' and not exists (
    select 1 from economy_journal
    where source = 'chain'
      and status in ('observed', 'realized')
      and evidence_key like '143:' || lower(new.tx_hash) || ':%'
  ) then
    raise exception 'settlement requires a counted journal posting for the verified receipt';
  end if;
  return new;
end;
$$;

drop trigger if exists economy_proposals_status_guard on economy_proposals;
create trigger economy_proposals_status_guard
  before insert or update on economy_proposals
  for each row execute function economy_proposal_status_guard();

create or replace function economy_proposal_write_audit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.reason is distinct from old.reason then
    insert into economy_proposal_audit (proposal_id, status, reason)
    values (new.id, new.status, left(coalesce(new.reason, ''), 500));
  end if;
  return new;
end;
$$;

drop trigger if exists economy_proposals_audit on economy_proposals;
create trigger economy_proposals_audit
  after insert or update of status, reason on economy_proposals
  for each row execute function economy_proposal_write_audit();

create or replace function economy_try_hold(
  p_key text,
  p_proposal uuid,
  p_token numeric,
  p_asset text,
  p_bucket text,
  p_amount numeric,
  p_observed numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing economy_reservations%rowtype;
  used numeric(78, 0);
  new_id uuid;
begin
  perform 1 from economy_lock where id = 1 for update;

  if p_key is null or length(btrim(p_key)) < 1 or p_amount is null or p_amount <= 0 or p_observed is null or p_observed < 0 then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
  end if;
  if p_asset not in ('MON', 'CHOG') or p_bucket not in ('gas', 'deployment', 'business_capital') then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'The reservation asset or bucket is not supported.');
  end if;
  if p_bucket in ('gas', 'deployment') and p_asset <> 'MON' then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'Gas and deployment reservations are native MON.');
  end if;

  select * into existing from economy_reservations where idempotency_key = p_key;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'id', existing.id, 'state', existing.state);
  end if;

  select coalesce(sum(amount_raw), 0) into used
    from economy_reservations
    where state = 'held' and asset = p_asset;

  if used + p_amount > p_observed then
    return jsonb_build_object(
      'ok', false,
      'outcome', 'insufficient_funds',
      'reason', 'The remaining observed balance cannot cover another reservation.'
    );
  end if;

  insert into economy_reservations (
    proposal_id, idempotency_key, chain_id, token_id, asset, bucket, amount_raw, observed_raw, state
  ) values (
    p_proposal, p_key, 143, p_token, p_asset, p_bucket, p_amount, p_observed, 'held'
  )
  returning id into new_id;

  return jsonb_build_object('ok', true, 'created', true, 'id', new_id, 'state', 'held');
end;
$$;

comment on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) is
  'Serializes one offchain hold with economy_lock FOR UPDATE. The hold does not enable execution.';

create or replace function economy_append_journal(p_lines jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  posting text;
  kind text;
  ref text;
  asset text;
  evidence text;
  debit_sum numeric(78, 0);
  credit_sum numeric(78, 0);
  idx integer;
begin
  perform 1 from economy_lock where id = 1 for update;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'A journal posting must be a balanced debit and credit.');
  end if;

  posting := p_lines->0->>'postingId';
  kind := p_lines->0->>'kind';
  ref := p_lines->0->>'ref';
  asset := p_lines->0->>'asset';
  if posting is null or kind is null or ref is null or asset is null then
    return jsonb_build_object('ok', false, 'reason', 'A journal posting must be a balanced debit and credit.');
  end if;

  for idx in 0 .. jsonb_array_length(p_lines) - 1
  loop
    item := p_lines->idx;
    if item->>'postingId' is distinct from posting
       or item->>'kind' is distinct from kind
       or item->>'ref' is distinct from ref
       or item->>'asset' is distinct from asset then
      return jsonb_build_object('ok', false, 'reason', 'A journal posting must be a balanced debit and credit.');
    end if;
    if coalesce(item->>'amountRaw', '') !~ '^[0-9]+$' or (item->>'amountRaw')::numeric(78, 0) <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'A journal amount must be a positive integer.');
    end if;
    if item->>'status' in ('observed', 'realized')
       and (coalesce(item->>'evidenceKey', '') = '' or item->>'source' <> 'chain') then
      return jsonb_build_object('ok', false, 'reason', 'Observed and realized lines require chain evidence.');
    end if;
    if item->>'status' = 'proposed' and coalesce(item->>'evidenceKey', '') <> '' then
      return jsonb_build_object('ok', false, 'reason', 'A proposal cannot carry chain evidence.');
    end if;
  end loop;

  select coalesce(sum((value->>'amountRaw')::numeric(78, 0)), 0) into debit_sum
    from jsonb_array_elements(p_lines)
    where value->>'side' = 'debit';
  select coalesce(sum((value->>'amountRaw')::numeric(78, 0)), 0) into credit_sum
    from jsonb_array_elements(p_lines)
    where value->>'side' = 'credit';
  if debit_sum <> credit_sum or debit_sum <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'A journal posting must be a balanced debit and credit.');
  end if;

  select value->>'evidenceKey' into evidence
    from jsonb_array_elements(p_lines)
    where coalesce(value->>'evidenceKey', '') <> ''
    limit 1;
  if evidence is not null and exists (select 1 from economy_journal where evidence_key = evidence) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if exists (
    select 1 from economy_journal
    where economy_journal.kind = kind
      and economy_journal.ref = ref
      and economy_journal.asset = asset
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into economy_journal (
    posting_id, account, asset, amount_raw, side, kind, source, ref, status, evidence_key, citizen_token_id
  )
  select
    value->>'postingId',
    value->>'account',
    value->>'asset',
    (value->>'amountRaw')::numeric(78, 0),
    value->>'side',
    value->>'kind',
    value->>'source',
    value->>'ref',
    value->>'status',
    nullif(value->>'evidenceKey', ''),
    case
      when coalesce(value->>'citizenTokenId', '') ~ '^[0-9]+$' then (value->>'citizenTokenId')::numeric(78, 0)
      else null
    end
  from jsonb_array_elements(p_lines);

  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

comment on function economy_append_journal(jsonb) is
  'Inserts a balanced posting or rejects it. Duplicate evidence does not create a second credit.';

create or replace function economy_apply_status(
  p_key text,
  p_status text,
  p_reason text,
  p_tx text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current economy_proposals%rowtype;
  next_status text := p_status;
  allowed boolean := false;
begin
  perform 1 from economy_lock where id = 1 for update;

  select * into current from economy_proposals where idempotency_key = p_key for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No proposal exists for that key.');
  end if;
  if current.status = next_status then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', current.status);
  end if;
  if current.expires_at <= now()
     and current.status in ('proposed', 'deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol', 'approved')
     and next_status not in ('expired', 'cancelled') then
    next_status := 'expired';
  end if;
  if next_status = 'proposed' and current.status <> 'proposed' and current.attempts >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'The proposal has used its retries.');
  end if;
  if next_status in ('confirmed', 'reverted', 'settled') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'Receipt evidence is required. Use the receipt and settlement functions.',
      'status', current.status
    );
  end if;

  allowed := case
    when current.status = 'proposed' and next_status in (
      'approved', 'rejected', 'deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol', 'cancelled', 'expired'
    ) then true
    when current.status in ('deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol')
      and next_status in ('proposed', 'cancelled', 'expired') then true
    when current.status = 'approved' and next_status in ('submitted', 'cancelled', 'expired') then true
    else false
  end;
  if not allowed then
    return jsonb_build_object('ok', false, 'reason', 'That status change is not allowed.', 'status', current.status);
  end if;

  update economy_proposals
     set status = next_status,
         reason = left(coalesce(p_reason, ''), 500),
         attempts = case when next_status = 'proposed' and current.status <> 'proposed' then current.attempts + 1 else current.attempts end,
         decision = case
           when next_status in ('approved', 'rejected', 'deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol') then next_status
           else decision
         end
   where id = current.id;

  return jsonb_build_object('ok', true, 'duplicate', false, 'status', next_status, 'executed', false);
end;
$$;

comment on function economy_apply_status(text, text, text, text) is
  'Moves a proposal through explicit statuses and lets the audit trigger record the change. Receipt statuses stay in the receipt functions. executed stays false.';

create or replace function economy_open_proposal(p_row jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
  existing_id uuid;
  key text := p_row->>'idempotencyKey';
  citizen uuid;
  slippage text := coalesce(p_row->>'slippageBps', '');
begin
  perform 1 from economy_lock where id = 1 for update;
  if key is null or length(btrim(key)) < 1 or length(key) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'A proposal needs an idempotency key.');
  end if;
  if coalesce(p_row->>'citizenId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    return jsonb_build_object('ok', false, 'reason', 'The citizen id is not a permanent citizen id.');
  end if;
  citizen := (p_row->>'citizenId')::uuid;
  if coalesce(p_row->>'operation', '') not in ('payment', 'purchase', 'trade', 'swap', 'business', 'return_capital')
     or coalesce(p_row->>'asset', '') not in ('MON', 'CHOG')
     or coalesce(p_row->>'nftContract', '') !~ '^0x[0-9a-fA-F]{40}$'
     or coalesce(p_row->>'tokenId', '') !~ '^[0-9]+$'
     or coalesce(p_row->>'amountRaw', '') !~ '^[0-9]+$'
     or coalesce(p_row->>'estimatedGasWei', '') !~ '^[0-9]+$'
     or coalesce(p_row->>'fundingRequestRaw', '') !~ '^[0-9]+$'
     or length(btrim(coalesce(p_row->>'objective', ''))) < 1
     or length(btrim(coalesce(p_row->>'rationale', ''))) < 1
     or length(btrim(coalesce(p_row->>'expectedOutcome', ''))) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'The proposal is missing a required field.');
  end if;
  if coalesce(p_row->>'target', '') <> '' and p_row->>'target' !~ '^0x[0-9a-fA-F]{40}$' then
    return jsonb_build_object('ok', false, 'reason', 'The protocol target is not a valid address.');
  end if;
  if coalesce(p_row->>'selector', '') <> '' and p_row->>'selector' !~ '^0x[0-9a-fA-F]{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'The function selector is malformed.');
  end if;
  if slippage <> '' and (slippage !~ '^[0-9]+$' or slippage::integer > 1000) then
    return jsonb_build_object('ok', false, 'reason', 'Slippage must be an integer number of basis points from 0 to 1000.');
  end if;

  insert into economy_proposals (
    idempotency_key, chain_id, citizen_id, nft_contract, token_id, operation,
    objective, rationale, expected_outcome, target, selector, asset,
    amount_raw, estimated_gas_wei, funding_request_raw, quote_price_raw, slippage_bps,
    status, reason, attempts, executed, expires_at
  ) values (
    key,
    143,
    citizen,
    p_row->>'nftContract',
    (p_row->>'tokenId')::numeric(78, 0),
    p_row->>'operation',
    left(btrim(p_row->>'objective'), 180),
    left(btrim(p_row->>'rationale'), 320),
    left(btrim(p_row->>'expectedOutcome'), 240),
    nullif(p_row->>'target', ''),
    nullif(p_row->>'selector', ''),
    p_row->>'asset',
    (p_row->>'amountRaw')::numeric(78, 0),
    (p_row->>'estimatedGasWei')::numeric(78, 0),
    (p_row->>'fundingRequestRaw')::numeric(78, 0),
    case
      when coalesce(p_row->>'quotePriceRaw', '') ~ '^[0-9]+$' and (p_row->>'quotePriceRaw')::numeric(78, 0) > 0
        then (p_row->>'quotePriceRaw')::numeric(78, 0)
      else null
    end,
    case when slippage ~ '^[0-9]+$' then slippage::integer else null end,
    'proposed',
    'Structured proposal received. It is not a transaction.',
    1,
    false,
    coalesce(nullif(p_row->>'expiresAt', '')::timestamptz, now() + interval '1 hour')
  )
  on conflict (idempotency_key) do nothing
  returning id into new_id;

  if new_id is null then
    select id into existing_id from economy_proposals where idempotency_key = key;
    return jsonb_build_object('ok', true, 'created', false, 'id', existing_id);
  end if;
  return jsonb_build_object('ok', true, 'created', true, 'id', new_id);
end;
$$;

comment on function economy_open_proposal(jsonb) is
  'Inserts one proposal and relies on the audit trigger for the first history row. A repeated key does not create a second proposal.';

create or replace function economy_try_holds(p_holds jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  idx integer;
  n integer;
  all_exist boolean := true;
  hold_asset text;
  observed numeric(78, 0);
  used numeric(78, 0);
  needed numeric(78, 0);
  new_id uuid;
  created_any boolean := false;
begin
  perform 1 from economy_lock where id = 1 for update;

  if jsonb_typeof(p_holds) <> 'array' or jsonb_array_length(p_holds) < 1 or jsonb_array_length(p_holds) > 3 then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
  end if;
  n := jsonb_array_length(p_holds);

  for idx in 0 .. n - 1 loop
    item := p_holds->idx;
    if coalesce(item->>'key', '') = ''
       or coalesce(item->>'proposalId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       or coalesce(item->>'tokenId', '') !~ '^[0-9]+$'
       or coalesce(item->>'amountRaw', '') !~ '^[0-9]+$'
       or (item->>'amountRaw')::numeric(78, 0) <= 0
       or coalesce(item->>'observedRaw', '') !~ '^[0-9]+$'
       or item->>'asset' not in ('MON', 'CHOG')
       or item->>'bucket' not in ('gas', 'deployment', 'business_capital')
       or (item->>'bucket' in ('gas', 'deployment') and item->>'asset' <> 'MON') then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
    end if;
    if not exists (select 1 from economy_proposals where id = (item->>'proposalId')::uuid) then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'The reservation does not belong to a stored proposal.');
    end if;
    if not exists (select 1 from economy_reservations where idempotency_key = item->>'key') then
      all_exist := false;
    end if;
  end loop;

  if all_exist then
    return jsonb_build_object('ok', true, 'created', false);
  end if;

  for hold_asset in
    select distinct value->>'asset' from jsonb_array_elements(p_holds)
  loop
    select (value->>'observedRaw')::numeric(78, 0) into observed
      from jsonb_array_elements(p_holds)
      where value->>'asset' = hold_asset
      limit 1;
    if exists (
      select 1 from jsonb_array_elements(p_holds)
      where value->>'asset' = hold_asset
        and (value->>'observedRaw')::numeric(78, 0) is distinct from observed
    ) then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
    end if;

    select coalesce(sum(amount_raw), 0) into used
      from economy_reservations
      where state = 'held'
        and economy_reservations.asset = hold_asset
        and idempotency_key not in (select value->>'key' from jsonb_array_elements(p_holds));

    select coalesce(sum((value->>'amountRaw')::numeric(78, 0)), 0) into needed
      from jsonb_array_elements(p_holds)
      where value->>'asset' = hold_asset;

    if used + needed > observed then
      update economy_reservations
         set state = 'released'
       where state = 'held'
         and idempotency_key in (select value->>'key' from jsonb_array_elements(p_holds));
      return jsonb_build_object(
        'ok', false,
        'outcome', 'insufficient_funds',
        'reason', 'The remaining observed balance cannot cover another reservation.'
      );
    end if;
  end loop;

  for idx in 0 .. n - 1 loop
    item := p_holds->idx;
    if exists (select 1 from economy_reservations where idempotency_key = item->>'key') then
      continue;
    end if;
    insert into economy_reservations (
      proposal_id, idempotency_key, chain_id, token_id, asset, bucket, amount_raw, observed_raw, state
    ) values (
      (item->>'proposalId')::uuid,
      item->>'key',
      143,
      (item->>'tokenId')::numeric(78, 0),
      item->>'asset',
      item->>'bucket',
      (item->>'amountRaw')::numeric(78, 0),
      (item->>'observedRaw')::numeric(78, 0),
      'held'
    )
    returning id into new_id;
    created_any := true;
  end loop;

  return jsonb_build_object('ok', true, 'created', created_any);
end;
$$;

comment on function economy_try_holds(jsonb) is
  'Reserves an offchain set under economy_lock, or releases that set when the observed balance cannot cover it. authorizes_execution stays false.';

create or replace function economy_note_receipt(
  p_key text,
  p_reason text,
  p_tx text,
  p_chain integer,
  p_block numeric,
  p_block_hash text,
  p_receipt_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current economy_proposals%rowtype;
  next_status text;
begin
  perform 1 from economy_lock where id = 1 for update;
  select * into current from economy_proposals where idempotency_key = p_key for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No proposal exists for that key.');
  end if;
  if p_chain is distinct from 143
     or p_receipt_status not in ('success', 'reverted')
     or p_tx is null or p_tx !~ '^0x[0-9a-fA-F]{64}$'
     or p_block_hash is null or p_block_hash !~ '^0x[0-9a-fA-F]{64}$'
     or p_block is null or p_block < 0 then
    return jsonb_build_object('ok', false, 'reason', 'Receipt evidence must be observed on Monad mainnet 143.');
  end if;
  next_status := case when p_receipt_status = 'success' then 'confirmed' else 'reverted' end;
  if current.status = next_status and lower(current.tx_hash) = lower(p_tx) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', current.status, 'executed', false);
  end if;
  if current.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'That status change is not allowed.', 'status', current.status);
  end if;

  update economy_proposals
     set status = next_status,
         reason = left(coalesce(p_reason, ''), 500),
         tx_hash = lower(p_tx),
         receipt_chain_id = 143,
         receipt_block_number = p_block,
         receipt_block_hash = lower(p_block_hash),
         receipt_status = p_receipt_status
   where id = current.id;

  if next_status = 'reverted' then
    update economy_reservations
       set state = 'released'
     where proposal_id = current.id and state = 'held';
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'status', next_status, 'executed', false);
end;
$$;

comment on function economy_note_receipt(text, text, text, integer, numeric, text, text) is
  'Records a verified mainnet receipt. A hash without chain 143, a block number, and a block hash is refused.';

create or replace function economy_settle_proposal(p_key text, p_tx text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current economy_proposals%rowtype;
begin
  perform 1 from economy_lock where id = 1 for update;
  select * into current from economy_proposals where idempotency_key = p_key for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No proposal exists for that key.');
  end if;
  if current.status = 'settled' and lower(current.tx_hash) = lower(p_tx) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'settled', 'executed', false);
  end if;
  if current.status <> 'confirmed'
     or current.receipt_status is distinct from 'success'
     or current.receipt_chain_id is distinct from 143
     or current.tx_hash is null
     or lower(current.tx_hash) is distinct from lower(p_tx)
     or current.receipt_block_number is null
     or current.receipt_block_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'Settlement requires a successful mainnet receipt.');
  end if;
  if not exists (
    select 1 from economy_journal
    where source = 'chain'
      and status in ('observed', 'realized')
      and evidence_key like '143:' || lower(current.tx_hash) || ':%'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'Settlement requires a counted journal posting for the verified receipt.');
  end if;

  update economy_proposals
     set status = 'settled',
         reason = 'Settled against the verified mainnet receipt and its journal posting. This row is not itself a transfer.'
   where id = current.id;

  update economy_reservations
     set state = 'reconciled'
   where proposal_id = current.id and state = 'held';

  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'settled', 'executed', false);
end;
$$;

comment on function economy_settle_proposal(text, text) is
  'Settles a confirmed proposal only when the stored receipt and a counted journal posting agree. executed stays false.';

create or replace function economy_ledger_snapshot(p_since timestamp with time zone)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  hold_count integer;
begin
  select count(*) into hold_count from economy_reservations where state = 'held';
  if hold_count > 200 then
    return jsonb_build_object(
      'ok', true,
      'complete', false,
      'reason', 'The reservation list is larger than this page loads. Reserved and allocated amounts are not shown as zero.'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'complete', true,
    'reservedGas', coalesce((select sum(amount_raw) from economy_reservations where state = 'held' and bucket = 'gas' and asset = 'MON'), 0)::text,
    'reservedDeployment', coalesce((select sum(amount_raw) from economy_reservations where state = 'held' and bucket = 'deployment' and asset = 'MON'), 0)::text,
    'allocatedMon', coalesce((select sum(amount_raw) from economy_reservations where state = 'held' and bucket = 'business_capital' and asset = 'MON'), 0)::text,
    'allocatedChog', coalesce((select sum(amount_raw) from economy_reservations where state = 'held' and bucket = 'business_capital' and asset = 'CHOG'), 0)::text,
    'dailyGas', coalesce((
      select sum(amount_raw) from economy_journal
      where kind = 'gas_spent' and asset = 'MON' and status = 'realized' and account = 'spent' and side = 'debit'
        and created_at >= p_since
    ), 0)::text,
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'key', idempotency_key,
        'proposalId', proposal_id,
        'tokenId', token_id::text,
        'asset', asset,
        'bucket', bucket,
        'amountRaw', amount_raw::text,
        'state', state
      ))
      from economy_reservations
      where state = 'held'
    ), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(row_to_json(listed)::jsonb)
      from (
        select id, status, objective, reason, tx_hash as "txHash",
               receipt_chain_id as "receiptChainId",
               receipt_status as "receiptStatus",
               receipt_block_number::text as "receiptBlockNumber",
               receipt_block_hash as "receiptBlockHash"
        from economy_proposals
        order by updated_at desc
        limit 40
      ) listed
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(row_to_json(listed)::jsonb)
      from (
        select id, asset, amount_raw::text as "amountRaw", side, status, evidence_key as "evidenceKey", kind
        from economy_journal
        where account = 'treasury' and source = 'chain' and status in ('observed', 'realized')
        order by created_at desc
        limit 40
      ) listed
    ), '[]'::jsonb)
  );
end;
$$;

comment on function economy_ledger_snapshot(timestamp with time zone) is
  'Read-only totals, open holds, recent proposals, and counted treasury lines. It does not sign or broadcast.';

revoke all on function economy_reject_mutation() from public;
revoke all on function economy_reservation_immutable() from public;
revoke all on function economy_proposal_immutable() from public;
revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from public;
revoke all on function economy_append_journal(jsonb) from public;
revoke all on function economy_apply_status(text, text, text, text) from public;
revoke all on function economy_proposal_status_guard() from public;
revoke all on function economy_proposal_write_audit() from public;
revoke all on function economy_open_proposal(jsonb) from public;
revoke all on function economy_try_holds(jsonb) from public;
revoke all on function economy_note_receipt(text, text, text, integer, numeric, text, text) from public;
revoke all on function economy_settle_proposal(text, text) from public;
revoke all on function economy_ledger_snapshot(timestamp with time zone) from public;

do $$
declare
  table_name text;
  role_name text;
  fn text;
begin
  foreach table_name in array array[
    'economy_lock',
    'economy_controls',
    'economy_proposals',
    'economy_proposal_audit',
    'economy_reservations',
    'economy_journal'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    execute format('revoke all on table %I from public', table_name);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on table %I from %I', table_name, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      if table_name in ('economy_journal', 'economy_proposal_audit') then
        execute format('grant select, insert on table %I to service_role', table_name);
      elsif table_name in ('economy_lock', 'economy_controls') then
        execute format('grant select on table %I to service_role', table_name);
      else
        execute format('grant select, insert, update on table %I to service_role', table_name);
      end if;
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach fn in array array[
      'economy_try_hold(text, uuid, numeric, text, text, numeric, numeric)',
      'economy_append_journal(jsonb)',
      'economy_apply_status(text, text, text, text)',
      'economy_open_proposal(jsonb)',
      'economy_try_holds(jsonb)',
      'economy_note_receipt(text, text, text, integer, numeric, text, text)',
      'economy_settle_proposal(text, text)',
      'economy_ledger_snapshot(timestamp with time zone)'
    ]
    loop
      execute format('grant execute on function %s to service_role', fn);
    end loop;
  end if;
end $$;
