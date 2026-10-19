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
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    status <> 'confirmed' or tx_hash is not null
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (bucket in ('gas', 'deployment') and asset = 'MON')
    or bucket = 'business_capital'
  )
);

comment on table economy_reservations is
  'Holds against an observed balance. A hold is not a payment. Gas is not business capital. Production execution cannot insert rows while economy_controls.execution_enabled is false.';

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

  if coalesce((select execution_enabled from economy_controls where id = 1), false) is distinct from true then
    return jsonb_build_object(
      'ok', false,
      'outcome', 'deferred',
      'reason', 'Production execution is disabled. No funds were reserved.'
    );
  end if;

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
  'Serializes holds with economy_lock FOR UPDATE. Refuses while execution_enabled is false, so this phase cannot reserve funds.';

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
  if next_status in ('confirmed', 'reverted') and (p_tx is null or p_tx !~ '^0x[0-9a-fA-F]{64}$') then
    return jsonb_build_object('ok', false, 'reason', 'A receipt status requires a transaction hash.');
  end if;

  allowed := case
    when current.status = 'proposed' and next_status in (
      'approved', 'rejected', 'deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol', 'cancelled', 'expired'
    ) then true
    when current.status in ('deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol')
      and next_status in ('proposed', 'cancelled', 'expired') then true
    when current.status = 'approved' and next_status in ('submitted', 'cancelled', 'expired') then true
    when current.status = 'submitted' and next_status in ('confirmed', 'reverted') then true
    when current.status = 'confirmed' and next_status = 'settled' then true
    else false
  end;
  if not allowed then
    return jsonb_build_object('ok', false, 'reason', 'That status change is not allowed.', 'status', current.status);
  end if;

  update economy_proposals
     set status = next_status,
         reason = left(coalesce(p_reason, ''), 500),
         attempts = case when next_status = 'proposed' and current.status <> 'proposed' then current.attempts + 1 else current.attempts end,
         tx_hash = case when next_status in ('confirmed', 'reverted') then p_tx else tx_hash end,
         decision = case
           when next_status in ('approved', 'rejected', 'deferred', 'insufficient_funds', 'budget_exhausted', 'unsupported_protocol') then next_status
           else decision
         end
   where id = current.id;

  insert into economy_proposal_audit (proposal_id, status, reason)
  values (current.id, next_status, left(coalesce(p_reason, ''), 500));

  return jsonb_build_object('ok', true, 'duplicate', false, 'status', next_status, 'executed', false);
end;
$$;

comment on function economy_apply_status(text, text, text, text) is
  'Moves a proposal through explicit statuses. Submitted is not confirmed. executed stays false.';

revoke all on function economy_reject_mutation() from public;
revoke all on function economy_reservation_immutable() from public;
revoke all on function economy_proposal_immutable() from public;
revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from public;
revoke all on function economy_append_journal(jsonb) from public;
revoke all on function economy_apply_status(text, text, text, text) from public;

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
      'economy_apply_status(text, text, text, text)'
    ]
    loop
      execute format('grant execute on function %s to service_role', fn);
    end loop;
  end if;
end $$;
