-- Phase 8 verifier boundary.
-- Apply only after 20261020050000_phase8_receipt_verification.sql.
-- This file is not applied to hosted Supabase by the Phase 8 change.
-- It does not delete or rewrite economic rows, enable execution, insert balances,
-- or change watcher checkpoints.
-- Safe to run again: roles, grants, and the journal kind check are conditional
-- or idempotent. It does not drop tables or columns.
-- The migration role must own the economy tables. security definer functions
-- then write as that owner. chogos_economy_verifier receives execute on the
-- receipt, journal, and settlement functions only.
-- Postgres still cannot see Monad. The server calls verifyMainnetReceipt
-- before it uses the verifier credential.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chogos_economy_verifier') then
    create role chogos_economy_verifier noinherit nologin;
  end if;
end
$$;

comment on role chogos_economy_verifier is
  'Executes receipt, journal, and settlement functions after the server has verified a Monad mainnet receipt. No login and no table privileges.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant chogos_economy_verifier to authenticator;
  end if;
end
$$;

-- The Phase 7 body compares plpgsql variables named kind, ref, and asset inside
-- a query on economy_journal. Those names are also columns, so the call fails
-- closed with an ambiguous reference. This replacement keeps the same signature
-- and the same posting rules, and it qualifies the variables.
create or replace function economy_append_journal(p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  posting text;
  posting_kind text;
  posting_ref text;
  posting_asset text;
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
  posting_kind := p_lines->0->>'kind';
  posting_ref := p_lines->0->>'ref';
  posting_asset := p_lines->0->>'asset';
  if posting is null or posting_kind is null or posting_ref is null or posting_asset is null then
    return jsonb_build_object('ok', false, 'reason', 'A journal posting must be a balanced debit and credit.');
  end if;

  for idx in 0 .. jsonb_array_length(p_lines) - 1
  loop
    item := p_lines->idx;
    if item->>'postingId' is distinct from posting
       or item->>'kind' is distinct from posting_kind
       or item->>'ref' is distinct from posting_ref
       or item->>'asset' is distinct from posting_asset then
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
    select 1 from economy_journal as posted
    where posted.kind = posting_kind
      and posted.ref = posting_ref
      and posted.asset = posting_asset
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
  'Inserts a balanced posting or rejects it. Duplicate evidence does not create a second credit. The function does not query Monad.';

alter function economy_note_receipt(text, text, text, integer, numeric, text, text) security definer set search_path = public;
alter function economy_settle_proposal(text, text) security definer set search_path = public;
alter function economy_open_proposal(jsonb) security definer set search_path = public;
alter function economy_apply_status(text, text, text, text) security definer set search_path = public;
alter function economy_try_holds(jsonb) security definer set search_path = public;
alter function economy_release_operation(uuid, uuid) security definer set search_path = public;
alter function economy_ledger_snapshot(timestamp with time zone) security definer set search_path = public;

revoke all on function economy_note_receipt(text, text, text, integer, numeric, text, text) from public, anon, authenticated, service_role;
revoke all on function economy_settle_proposal(text, text) from public, anon, authenticated, service_role;
revoke all on function economy_append_journal(jsonb) from public, anon, authenticated, service_role;
revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function economy_open_proposal(jsonb) from public, anon, authenticated;
revoke all on function economy_apply_status(text, text, text, text) from public, anon, authenticated;
revoke all on function economy_try_holds(jsonb) from public, anon, authenticated;
revoke all on function economy_release_operation(uuid, uuid) from public, anon, authenticated;
revoke all on function economy_ledger_snapshot(timestamp with time zone) from public, anon, authenticated;
revoke all on function economy_proposal_status_guard() from public, anon, authenticated, service_role;
revoke all on function economy_proposal_write_audit() from public, anon, authenticated, service_role;
revoke all on function economy_reject_mutation() from public, anon, authenticated, service_role;
revoke all on function economy_reservation_immutable() from public, anon, authenticated, service_role;
revoke all on function economy_proposal_immutable() from public, anon, authenticated, service_role;

grant execute on function economy_note_receipt(text, text, text, integer, numeric, text, text) to chogos_economy_verifier;
grant execute on function economy_settle_proposal(text, text) to chogos_economy_verifier;
grant execute on function economy_append_journal(jsonb) to chogos_economy_verifier;

grant execute on function economy_open_proposal(jsonb) to service_role;
grant execute on function economy_apply_status(text, text, text, text) to service_role;
grant execute on function economy_try_holds(jsonb) to service_role;
grant execute on function economy_release_operation(uuid, uuid) to service_role;
grant execute on function economy_ledger_snapshot(timestamp with time zone) to service_role;

revoke all on function economy_open_proposal(jsonb) from chogos_economy_verifier;
revoke all on function economy_apply_status(text, text, text, text) from chogos_economy_verifier;
revoke all on function economy_try_holds(jsonb) from chogos_economy_verifier;
revoke all on function economy_release_operation(uuid, uuid) from chogos_economy_verifier;
revoke all on function economy_ledger_snapshot(timestamp with time zone) from chogos_economy_verifier;
revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from chogos_economy_verifier;

revoke insert, update, delete, truncate on table economy_proposals from service_role;
revoke insert, update, delete, truncate on table economy_reservations from service_role;
revoke insert, update, delete, truncate on table economy_journal from service_role;
revoke insert, update, delete, truncate on table economy_proposal_audit from service_role;
grant select on table economy_proposals, economy_reservations, economy_journal, economy_proposal_audit to service_role;

revoke all on table economy_lock from chogos_economy_verifier;
revoke all on table economy_controls from chogos_economy_verifier;
revoke all on table economy_proposals from chogos_economy_verifier;
revoke all on table economy_proposal_audit from chogos_economy_verifier;
revoke all on table economy_reservations from chogos_economy_verifier;
revoke all on table economy_journal from chogos_economy_verifier;

do $$
declare
  cons text;
  def text;
begin
  select conname, pg_get_constraintdef(oid)
    into cons, def
  from pg_constraint
  where conrelid = 'public.economy_journal'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%treasury_deposit%'
  limit 1;
  if cons is null then
    raise exception 'economy_journal kind check is missing';
  end if;
  if def not like '%receipt_observed%' then
    execute format('alter table economy_journal drop constraint %I', cons);
    alter table economy_journal add constraint economy_journal_kind_check check (kind in (
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
      'capital_recovered',
      'receipt_observed'
    ));
  end if;
end
$$;

comment on constraint economy_journal_kind_check on economy_journal is
  'receipt_observed links a verified transaction to settlement. It is not a decoded transfer.';
