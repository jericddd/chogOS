-- Phase 8: fail closed when an idempotency key is reused for different terms,
-- keep reservation batches atomic, and label conflicting receipt writes
-- without rewriting history.
-- Apply only after 20261019230000_phase7_economy.sql.
-- This file is not applied to hosted Supabase by the Phase 8 change.
-- It does not enable execution, insert balances, or reset sync cursors.
-- Postgres cannot see Monad RPC. economy_note_receipt stores caller-supplied
-- fields. It does not query Monad and does not verify a receipt.
-- The server calls verifyMainnetReceipt before those arguments are built.
-- economy_try_holds stamps a server-generated operation_id on rows it inserts.
-- economy_release_operation releases only rows with that id. A returned key list
-- is not ownership. Existing rows keep their original operation_id.

alter table economy_reservations
  add column if not exists operation_id uuid;

comment on column economy_reservations.operation_id is
  'Identifies the server attempt that inserted this row. Cleanup releases only this id. It does not authorize execution.';

create index if not exists economy_reservations_operation
  on economy_reservations (operation_id)
  where operation_id is not null;

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
     or new.observed_raw is distinct from old.observed_raw
     or new.operation_id is distinct from old.operation_id then
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

comment on function economy_reservation_immutable() is
  'Identity columns and operation_id cannot change. A held row may move to reconciled or released.';

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
    if existing.proposal_id is distinct from p_proposal
       or existing.token_id is distinct from p_token
       or existing.asset is distinct from p_asset
       or existing.bucket is distinct from p_bucket
       or existing.amount_raw is distinct from p_amount
       or existing.chain_id is distinct from 143 then
      return jsonb_build_object(
        'ok', false,
        'outcome', 'conflict',
        'reason', 'This idempotency key is already used for a different reservation.'
      );
    end if;
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
  'Serializes one offchain hold and leaves operation_id null. economy_release_operation does not match that row. The server uses economy_try_holds. A reused key with a different proposal, asset, amount, bucket, or token fails closed and does not release the existing row.';

create or replace function economy_open_proposal(p_row jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
  existing economy_proposals%rowtype;
  key text := p_row->>'idempotencyKey';
  citizen uuid;
  slippage text := coalesce(p_row->>'slippageBps', '');
  quote numeric(78, 0);
  slip integer;
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
  quote := case
    when coalesce(p_row->>'quotePriceRaw', '') ~ '^[0-9]+$' and (p_row->>'quotePriceRaw')::numeric(78, 0) > 0
      then (p_row->>'quotePriceRaw')::numeric(78, 0)
    else null
  end;
  slip := case when slippage ~ '^[0-9]+$' then slippage::integer else null end;

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
    quote,
    slip,
    'proposed',
    'Structured proposal received. It is not a transaction.',
    1,
    false,
    coalesce(nullif(p_row->>'expiresAt', '')::timestamptz, now() + interval '1 hour')
  )
  on conflict (idempotency_key) do nothing
  returning id into new_id;

  if new_id is null then
    select * into existing from economy_proposals where idempotency_key = key;
    if existing.citizen_id is distinct from citizen
       or lower(existing.nft_contract) is distinct from lower(p_row->>'nftContract')
       or existing.token_id is distinct from (p_row->>'tokenId')::numeric(78, 0)
       or existing.operation is distinct from p_row->>'operation'
       or existing.asset is distinct from p_row->>'asset'
       or existing.amount_raw is distinct from (p_row->>'amountRaw')::numeric(78, 0)
       or existing.estimated_gas_wei is distinct from (p_row->>'estimatedGasWei')::numeric(78, 0)
       or existing.funding_request_raw is distinct from (p_row->>'fundingRequestRaw')::numeric(78, 0)
       or lower(coalesce(existing.target, '')) is distinct from lower(coalesce(p_row->>'target', ''))
       or lower(coalesce(existing.selector, '')) is distinct from lower(coalesce(p_row->>'selector', ''))
       or existing.quote_price_raw is distinct from quote
       or existing.slippage_bps is distinct from slip then
      return jsonb_build_object(
        'ok', false,
        'outcome', 'conflict',
        'reason', 'This idempotency key is already used for a different proposal.'
      );
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'id', existing.id);
  end if;
  return jsonb_build_object('ok', true, 'created', true, 'id', new_id);
end;
$$;

comment on function economy_open_proposal(jsonb) is
  'Inserts one proposal. The same key with the same economic terms returns the existing id. Different terms fail closed and do not update the row.';

create or replace function economy_try_holds(p_holds jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  batch jsonb;
  idx integer;
  n integer;
  all_exist boolean := true;
  existing economy_reservations%rowtype;
  hold_asset text;
  observed numeric(78, 0);
  used numeric(78, 0);
  needed numeric(78, 0);
  operation uuid;
  new_id uuid;
  created_any boolean := false;
  created_keys jsonb := '[]'::jsonb;
begin
  perform 1 from economy_lock where id = 1 for update;

  if jsonb_typeof(p_holds) <> 'object'
     or coalesce(p_holds->>'operationId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(p_holds->'holds') <> 'array' then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
  end if;
  operation := (p_holds->>'operationId')::uuid;
  batch := p_holds->'holds';
  if jsonb_array_length(batch) < 1 or jsonb_array_length(batch) > 3 then
    return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
  end if;
  n := jsonb_array_length(batch);

  for idx in 0 .. n - 1 loop
    item := batch->idx;
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
    if (
      select count(*) from jsonb_array_elements(batch) as request
      where request.value->>'key' = item->>'key'
    ) > 1 then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
    end if;
    if not exists (select 1 from economy_proposals where id = (item->>'proposalId')::uuid) then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'The reservation does not belong to a stored proposal.');
    end if;
    select * into existing from economy_reservations where idempotency_key = item->>'key';
    if found then
      if existing.proposal_id is distinct from (item->>'proposalId')::uuid
         or existing.token_id is distinct from (item->>'tokenId')::numeric(78, 0)
         or existing.asset is distinct from item->>'asset'
         or existing.bucket is distinct from item->>'bucket'
         or existing.amount_raw is distinct from (item->>'amountRaw')::numeric(78, 0)
         or existing.chain_id is distinct from 143 then
        return jsonb_build_object(
          'ok', false,
          'outcome', 'conflict',
          'reason', 'This idempotency key is already used for a different reservation.'
        );
      end if;
    else
      all_exist := false;
    end if;
  end loop;

  if all_exist then
    return jsonb_build_object('ok', true, 'created', false, 'createdKeys', '[]'::jsonb, 'operationId', operation);
  end if;

  for hold_asset in
    select distinct value->>'asset' from jsonb_array_elements(batch)
  loop
    select (value->>'observedRaw')::numeric(78, 0) into observed
      from jsonb_array_elements(batch)
      where value->>'asset' = hold_asset
      limit 1;
    if exists (
      select 1 from jsonb_array_elements(batch)
      where value->>'asset' = hold_asset
        and (value->>'observedRaw')::numeric(78, 0) is distinct from observed
    ) then
      return jsonb_build_object('ok', false, 'outcome', 'malformed', 'reason', 'A reservation needs a positive amount and an observed balance.');
    end if;

    select coalesce(sum(amount_raw), 0) into used
      from economy_reservations
      where state = 'held'
        and economy_reservations.asset = hold_asset;

    select coalesce(sum((request.value->>'amountRaw')::numeric(78, 0)), 0) into needed
      from jsonb_array_elements(batch) as request
      where request.value->>'asset' = hold_asset
        and not exists (
          select 1 from economy_reservations
          where idempotency_key = request.value->>'key'
        );

    if used + needed > observed then
      return jsonb_build_object(
        'ok', false,
        'outcome', 'insufficient_funds',
        'reason', 'The remaining observed balance cannot cover another reservation.'
      );
    end if;
  end loop;

  for idx in 0 .. n - 1 loop
    item := batch->idx;
    if exists (select 1 from economy_reservations where idempotency_key = item->>'key') then
      continue;
    end if;
    insert into economy_reservations (
      proposal_id, idempotency_key, chain_id, token_id, asset, bucket, amount_raw, observed_raw, state, operation_id
    ) values (
      (item->>'proposalId')::uuid,
      item->>'key',
      143,
      (item->>'tokenId')::numeric(78, 0),
      item->>'asset',
      item->>'bucket',
      (item->>'amountRaw')::numeric(78, 0),
      (item->>'observedRaw')::numeric(78, 0),
      'held',
      operation
    )
    returning id into new_id;
    created_any := true;
    created_keys := created_keys || jsonb_build_array(item->>'key');
  end loop;

  return jsonb_build_object('ok', true, 'created', created_any, 'createdKeys', created_keys, 'operationId', operation);
end;
$$;

comment on function economy_try_holds(jsonb) is
  'Validates an offchain batch under economy_lock before inserting. New rows receive the caller operation_id. Existing rows are not restamped. A conflict or an insufficient balance returns without changing existing reservations. authorizes_execution stays false.';

create or replace function economy_release_operation(p_operation uuid, p_proposal uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  released integer := 0;
begin
  if p_operation is null or p_proposal is null then
    return jsonb_build_object('ok', false, 'reason', 'A reservation release needs the operation that created it.');
  end if;
  perform 1 from economy_lock where id = 1 for update;
  update economy_reservations
     set state = 'released'
   where operation_id = p_operation
     and proposal_id = p_proposal
     and state = 'held';
  get diagnostics released = row_count;
  return jsonb_build_object('ok', true, 'released', released);
end;
$$;

comment on function economy_release_operation(uuid, uuid) is
  'Releases held rows stamped with this operation and proposal. It does not accept a key list, so a forged createdKeys value cannot release an earlier hold.';

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
  if current.tx_hash is not null and lower(current.tx_hash) is distinct from lower(p_tx) then
    return jsonb_build_object(
      'ok', false,
      'outcome', 'conflict',
      'reason', 'This proposal is already tied to a different transaction.',
      'status', current.status,
      'executed', false
    );
  end if;
  if current.status = next_status and current.tx_hash is not null and lower(current.tx_hash) = lower(p_tx) then
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
  'Stores receipt fields supplied by the caller. This function does not query Monad and does not verify a receipt. Duplicate notes return before update, so the audit trigger does not append. A different transaction conflicts and does not rewrite history. A reverted status releases held reservations for that proposal id. It does not take a key list and it is not the operation-id cleanup path.';

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
  if p_tx is null or p_tx !~ '^0x[0-9a-fA-F]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'Settlement requires a successful mainnet receipt.');
  end if;
  if current.status = 'settled' and lower(current.tx_hash) = lower(p_tx) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'settled', 'executed', false);
  end if;
  if current.tx_hash is not null and lower(current.tx_hash) is distinct from lower(p_tx) then
    return jsonb_build_object(
      'ok', false,
      'outcome', 'conflict',
      'reason', 'This proposal is already tied to a different transaction.',
      'status', current.status,
      'executed', false
    );
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
    return jsonb_build_object('ok', false, 'reason', 'Settlement requires a counted journal posting for the stored receipt.');
  end if;

  update economy_proposals
     set status = 'settled',
         reason = 'Settled against the stored mainnet receipt and its journal posting. This row is not itself a transfer.'
   where id = current.id;

  update economy_reservations
     set state = 'reconciled'
   where proposal_id = current.id and state = 'held';

  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'settled', 'executed', false);
end;
$$;

comment on function economy_settle_proposal(text, text) is
  'Settles a confirmed proposal only when the stored receipt columns and a counted journal posting agree. This function does not query Monad and does not verify a receipt. The same transaction returns before update. A different transaction conflicts. executed stays false.';

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
      raise exception 'a receipt status requires chain 143, a transaction hash, a block number, and a block hash';
    end if;
  end if;
  if new.status in ('confirmed', 'settled') and new.receipt_status is distinct from 'success' then
    raise exception 'confirmation requires receipt_status success';
  end if;
  if new.status = 'reverted' and new.receipt_status is distinct from 'reverted' then
    raise exception 'a reverted proposal requires receipt_status reverted';
  end if;
  if new.status = 'settled' and not exists (
    select 1 from economy_journal
    where source = 'chain'
      and status in ('observed', 'realized')
      and evidence_key like '143:' || lower(new.tx_hash) || ':%'
  ) then
    raise exception 'settlement requires a counted journal posting for the stored receipt';
  end if;
  return new;
end;
$$;

comment on function economy_proposal_status_guard() is
  'Checks stored receipt columns and a journal row. It does not query Monad and does not verify a receipt.';

revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from public;
revoke all on function economy_proposal_status_guard() from public;
revoke all on function economy_open_proposal(jsonb) from public;
revoke all on function economy_try_holds(jsonb) from public;
revoke all on function economy_release_operation(uuid, uuid) from public;
revoke all on function economy_note_receipt(text, text, text, integer, numeric, text, text) from public;
revoke all on function economy_settle_proposal(text, text) from public;

do $$
declare
  fn text;
  role_name text;
begin
  foreach fn in array array[
    'economy_try_hold(text, uuid, numeric, text, text, numeric, numeric)',
    'economy_open_proposal(jsonb)',
    'economy_try_holds(jsonb)',
    'economy_release_operation(uuid, uuid)',
    'economy_note_receipt(text, text, text, integer, numeric, text, text)',
    'economy_settle_proposal(text, text)',
    'economy_append_journal(jsonb)',
    'economy_apply_status(text, text, text, text)',
    'economy_ledger_snapshot(timestamp with time zone)',
    'economy_proposal_status_guard()',
    'economy_proposal_write_audit()',
    'economy_reject_mutation()',
    'economy_reservation_immutable()',
    'economy_proposal_immutable()'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', fn, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role')
       and fn not in (
         'economy_proposal_status_guard()',
         'economy_proposal_write_audit()',
         'economy_reject_mutation()',
         'economy_reservation_immutable()',
         'economy_proposal_immutable()'
       ) then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
