> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 8 — Mainnet read-only economy verification

Date: 20 October 2026.
Base: `cursor/phase-1-genesis-world-155c` at `1984e5339693d9b5ae288bab6ba3dd4d2b218dda` (merge of Phase 7, pull request #35).
Status: **code-complete, operationally blocked**. The verifier migration and server path are in this branch. They are not applied to hosted Supabase. No environment change, no watcher checkpoint change, no signature, and no broadcast. Production permissions stay as they are until an operator applies the files and checks the queries in this document.

## What Phase 7 already enforced

The merged migration `supabase/migrations/20261019230000_phase7_economy.sql` is left unchanged. A review of that file against the merged tree shows these controls are already present:

- Amounts are `numeric(78, 0)`. Chain id is checked as `143`. `executed` and `authorizes_execution` are constrained false. `economy_controls.execution_enabled` is constrained false.
- `economy_lock` is taken with `FOR UPDATE` inside the reservation, journal, status, receipt, and settlement functions.
- Row level security is enabled. `public`, and `anon` / `authenticated` when those roles exist, are revoked. `service_role` receives the table and function grants. Journal and audit tables are insert-only for that role.
- Audit rows are written by an `AFTER INSERT OR UPDATE OF status, reason` trigger. Journal and audit mutations that would rewrite history are rejected.
- `economy_apply_status` refuses `confirmed`, `reverted`, and `settled`. The status guard refuses those statuses without receipt fields, and refuses `settled` without a counted journal line.
- `economy_note_receipt` requires chain 143, a 32-byte hash, a block number, a block hash, and status `success` or `reverted`. The same status and transaction returns before `UPDATE`, so the audit trigger does not append a second row.
- `economy_settle_proposal` requires the stored success receipt plus a `economy_journal` row whose evidence key starts with `143:<tx>:` and whose source is `chain` with status `observed` or `realized`. A second settlement of that same transaction returns before `UPDATE`.

Those database checks do not read Monad. They accept the arguments the service role sends.

## Audit findings

1. `assessReceiptEvidence` accepted a caller-built object and returned a TypeScript value named as a verified receipt. `noteVerifiedReceipt` and `settleVerifiedProposal` wrote that object into SQL. A cast or a matching shape was treated as proof.
2. `interpretLedgerSnapshot` set `chainVerified` from stored receipt columns and from an evidence-key prefix. The economy page could render an explorer link for a hash this process had not read.
3. `economy_try_hold`, `economy_try_holds`, and the in-memory `tryHold` returned success when an idempotency key already existed, without comparing proposal, asset, or amount. `economy_open_proposal` did the same for a repeated key.
4. Two `tryHold` calls that do not share a lock can both succeed against one observed balance. `economy_lock` is the production serializer. A process-local mutex is not.
5. The read-only observer already returns `not_configured`, `stale`, `unavailable`, and `wrong_chain` without inventing a zero balance, and it reads `$CHOG` only from `addresses.chogToken`. This phase re-checks that behavior. It does not change the observer into a writer.
6. Phase 7 `economy_try_holds` releases held rows whose keys are in an insufficient batch. The Phase 8 function validates the batch and the available balance before any insert, and an insufficient or conflicting batch returns without changing existing reservations. The Phase 7 file stays as merged. Hosted Postgres keeps the release until the Phase 8 file is applied.

## Receipt verifier

`verifyMainnetReceipt` takes a transaction hash and a JSON-RPC caller. It does not accept a receipt object.

1. The hash must be `0x` plus 64 hex characters. Anything else is malformed and does not call RPC.
2. `eth_chainId` must be the hex quantity for 143 (`0x8f`). Any other chain, including 10143, stops the check before `eth_getTransactionReceipt`. A JSON number `143` is malformed.
3. `eth_getTransactionReceipt` must be an object. `null` is missing. The receipt's `transactionHash` must match the requested hash. `status` must be the quantity `0x1` or `0x0`, not the word `success`. `blockNumber` and `blockHash` must be present.
4. `eth_getBlockByNumber` is called with that block number and `false`. The block's `hash` and `number` must equal the receipt's block hash and block number.
5. Timeouts, thrown calls, non-JSON bodies, and RPC errors are `rpc_failure`. URLs in those messages are redacted. An unset or non-https RPC URL fails closed.
6. The success value carries a non-enumerable brand created inside this function, with `source: "monad-mainnet-rpc"`. `isRpcVerifiedReceipt` rejects casts, `assessReceiptEvidence` results, spread copies, and `JSON.parse` output.

`jsonRpcCaller` posts only `eth_chainId`, `eth_getTransactionReceipt`, and `eth_getBlockByNumber`. It refuses `eth_sendRawTransaction`.

## Server path

`confirmEconomyReceipt` and `settleEconomyProposal` in `src/lib/economy/db.ts` are the write path. Each one calls `verifyMainnetReceipt` before SQL. The only caller input is the proposal key and the transaction hash. Block number, block hash, status, and chain id written to `economy_note_receipt` come from the branded result.

A reverted receipt can be noted. `settleRpcArgs` rejects it, so `economy_settle_proposal` is not called. A mismatch or RPC failure does not call SQL and returns `verified: false`. `verified: true` is returned only after `verifyMainnetReceipt` succeeds.

In-memory `noteReceipt` and `settleProposal` ignore unbranded evidence. A repeated note or settlement of the same transaction returns the existing history. A different transaction is a conflict and does not rewrite the stored hash. `planConfirmation` and `planSettlement` are the same rules the SQL functions now label as `duplicate` or `conflict`.

`interpretLedgerSnapshot` leaves `chainVerified` false. `applyRpcVerification` sets it only when the same call holds a branded receipt for that hash and status. The page loader does not call the verifier, so a stored hash is not presented as verified.

## Idempotency

`tryHold` and `tryHoldBatch` compare proposal id, token id, asset, bucket, and amount. A difference returns `conflict` and leaves every existing hold as it was, including a new key that shared the batch. An exact replay of keys that are already `held` returns `created: false` before the balance check, so a later lower observation does not release those holds. A `released` key is funded again. A `reconciled` key conflicts.

`tryHoldBatch` is the in-memory batch used by `reserveApproved`. It checks shape, duplicate keys, identity, and funding for the whole batch before it appends anything. Funding counts every current `held` amount once, then adds missing and released keys. If that sum is above the observed balance, the function returns `insufficient_funds` and the original holds. `holdSequentially` remains the one-at-a-time demonstration; a later refusal does not change an earlier hold to `released`.

`holdFailureStatus("conflict")` is `rejected`. `persistEconomyDecision` writes that status and does not release the prior hold. `insufficient_funds` stays `insufficient_funds` and does not release. Any other hold failure, including a Phase 7 function rejecting the new payload as malformed, returns a deferred failure without writing status and without releasing. The proposal row stays `proposed`.

`createdKeys` is not ownership. The server generates `operationId` with `crypto.randomUUID()` and sends `economy_try_holds` the object `{ operationId, holds }`. The function stamps that id on rows it inserts and on released rows it re-holds. A row that is already `held` keeps its operation id. `economy_reservation_immutable` allows `operation_id` and `observed_raw` to change only on the `released` → `held` transition, and only when the new operation id is non-null. A `held` row cannot be restamped. A `reconciled` row cannot change state.

The success body echoes `operationId`, `createdKeys`, and `heldKeys`. `proveHoldOperation` accepts the body only when the echo matches this attempt, `createdKeys` is a unique subset of the submitted keys, and `heldKeys` is exactly the submitted set. A missing list, a duplicate, a foreign key, a partial `heldKeys` list, or a different operation id is unresolved.

Unresolved ownership releases nothing and does not write `approved`. The proposal stays `proposed`.

When reservation is required, `approved` is written only if every required key is `held` after the batch. The persist result then has `reserved: true`, including an exact replay of live holds. A released key is not a replay. If the observed balance covers it, this operation re-holds it and owns that row. If the balance does not cover it, the function returns `insufficient_funds` without changing any row, and the server writes `insufficient_funds` with `reserved: false`. A reconciled key returns `conflict`, the server writes `rejected`, and it does not release a pre-existing hold. If the caller marks the proposal approved but supplies no live hold rows, the server returns a deferred failure and does not write `approved`.

When the body is proven and `created` is true, a failed status write calls `economy_release_operation(operationId, proposalId)`. That function takes no key list. It releases only rows with this operation id, this proposal, and state `held`. A forged `createdKeys` list cannot widen that update. A retry can re-hold those released rows when funding allows, then approve with `reserved: true`. If `approved` is not a legal transition because the proposal is already `insufficient_funds` or `deferred`, and the holds are proven, the server moves the proposal through `proposed` and then `approved`. That uses the existing attempt counter. If that reopen fails, this operation's new rows are released and the proposal is not approved. Pre-existing live holds stay held.

`economy_try_hold` returns `malformed` and does not insert. The Phase 8 migration revokes `EXECUTE` on it from `service_role` as well as from `public`, `anon`, and `authenticated`. No application caller uses it.

A reverted receipt releases every `held` row for that proposal id, including rows from earlier operations on the same proposal. A reservation's `proposal_id` is the only proposal it funds, so those rows are that proposal's reservations. Rows for any other proposal stay held, even if an operation id collided. The update does not read `createdKeys` and does not filter by operation id. Settlement reconciles held rows with the same proposal scope.

The diagnostic log records `economy.persist`, the event, a `missing` or `malformed` code, the proposal id, the operation id, and counts. It does not record balances, key lists, raw responses, or credentials.

The new migration replaces `economy_try_holds` and `economy_open_proposal` with the same identity comparisons. `economy_try_hold` no longer inserts. A conflict returns before any write. An insufficient batch returns before any write and does not set existing rows to `released`. An exact replay of held keys returns `created: false`, `createdKeys: []`, `heldKeys` for every submitted key, and the echoed operation id. Duplicate keys in one batch are malformed and do not write. The function signature stays `economy_try_holds(jsonb)`. The JSON value changes from a bare array to `{ operationId, holds }`.

`economy_note_receipt` and `economy_settle_proposal` are replaced so a different transaction returns `outcome: conflict` before `UPDATE`, and a duplicate returns before `UPDATE`. The journal requirement for settlement is unchanged. `executed` stays false. A reverted receipt note still releases the holds for that proposal. That release is the reverted-proposal path, not the insufficient-batch path.

## Migration review

Files, in order:

1. `supabase/migrations/20261019230000_phase7_economy.sql` (merged Phase 7; do not edit)
2. `supabase/migrations/20261020050000_phase8_receipt_verification.sql`
3. `supabase/migrations/20261021000000_phase8_economy_verifier.sql`

None of these files is applied to hosted Supabase by this change. The Phase 8 files do not insert balances, change `economy_controls`, or mention watcher checkpoints. The receipt file keeps `security invoker` on the functions it replaces. The verifier file switches the listed functions to `security definer` with `search_path = public`. `economy_release_operation(uuid, uuid)` is new. `economy_reservations.operation_id` is a new nullable uuid column. `economy_append_journal` is replaced in the verifier file because the Phase 7 body compares plpgsql variables named `kind`, `ref`, and `asset` with columns of the same names and fails when it is called. The replacement keeps the signature and the posting rules.

Local proof applies every migration, in order, on an in-process Postgres (`openWorldDb` in `src/lib/world/test-db.ts`) and checks privileges by calling the functions as `service_role`, `chogos_economy_verifier`, and `anon`. That is not a hosted Supabase check. Production grants stay at whatever is already applied until an operator runs the files and the verification queries below.

Safe retry of an identical proposal returns the existing row. A retry that changes proposal, asset, or amount fails closed. A retry of the same confirmed or settled transaction does not append another audit row. A live reservation is a replay: the server can approve it with `reserved: true` and does not restamp its operation id. A released reservation with the same identity is re-held under the new operation id when the observed balance covers the amount. It is not treated as a live hold. A reconciled reservation conflicts. `economy_proposal_status_guard` rejects an insert whose status is not `proposed`, so a direct insert cannot start as `confirmed`.

Until the Phase 8 file is applied, hosted `economy_try_holds` still expects a JSON array. An object payload fails the array check and returns `malformed` before the Phase 7 insufficient-batch `UPDATE`. The application maps that outcome to a deferred failure, writes no status, and releases nothing. Reservation saves fail closed. They do not fall through to the old release.

## Trust boundary

Postgres cannot call Monad. `economy_note_receipt`, `economy_settle_proposal`, and `economy_proposal_status_guard` store and compare the fields they are given. Their comments say they do not query Monad and do not verify a receipt. A successful status still needs chain 143, a transaction hash, a block number, a block hash, and, for settlement, a counted journal row. Those checks are shape and consistency checks.

The trusted boundary is the server process. `src/lib/economy/db.ts` and `src/lib/economy/load.ts` import `server-only`. `confirmEconomyReceipt` and `settleEconomyProposal` call `verifyMainnetReceipt` before they build SQL arguments, and the only caller input is the proposal key and the transaction hash. No file under `src/app` calls those functions or the SQL names. The economy page loader does not call the verifier.

Phase 7 enables row level security on the economy tables and creates no permissive policy, so `anon` and `authenticated` receive no rows through the table API. It revokes table privileges from `public`, `anon`, and `authenticated`, and it grants `service_role` select, insert, and update on proposals and reservations. Journal and audit stay insert-only for that role. The service role bypasses row level security. That is why the application uses it only from server code.

Phase 7 revokes function execute from `public` and grants it to `service_role`. Supabase default privileges can still leave execute with `anon` and `authenticated` after a revoke from `public`. The Phase 8 receipt file revokes execute on the economy functions from `public`, `anon`, and `authenticated` when those roles exist, then grants execute back to `service_role` for the functions the server calls. Trigger functions are revoked and are not granted. In that file the functions stay `security invoker`. The verifier file is the one that switches the called functions to `security definer` and revokes `service_role` table writes. `economy_release_operation`, `economy_try_holds`, and the ordinary status functions stay executable by `service_role` after that switch, so reservation cleanup still has a path.

Until an operator applies the Phase 8 receipt file, hosted Postgres still has the Phase 7 `economy_try_holds` release and the Phase 7 function grants. The application in this change no longer sends that function a bare array, so the old release is not what a current reservation save executes. Applying the Phase 8 receipt file is still required before a reservation save can succeed. Applying the verifier file is still required before `service_role` loses the receipt and journal writes.

## Verifier role

`service_role` bypasses row level security. After only the Phase 8 receipt file, it can still call `economy_note_receipt` and `economy_settle_proposal`, update receipt columns, insert a journal line, and update `economy_reservations.state`. The verifier migration is what removes those grants. It is in the repository. It has not been applied to hosted Supabase, so those production grants are unchanged until an operator applies it and runs the queries below.

The migration creates `chogos_economy_verifier` as `noinherit` and `nologin` when the role is missing. On a database that has `authenticator` (hosted Supabase does; the local test harness creates it too), it runs:

```sql
grant chogos_economy_verifier to authenticator;
```

It then marks these functions `security definer` with `search_path = public`: `economy_note_receipt`, `economy_settle_proposal`, `economy_append_journal`, `economy_open_proposal`, `economy_apply_status`, `economy_try_holds`, `economy_release_operation`, and `economy_ledger_snapshot`. They run as the table owner, which is the role that applies the migration. `economy_try_hold` stays an invoker function that inserts nothing.

Grants after that file:

```sql
revoke all on function economy_note_receipt(text, text, text, integer, numeric, text, text) from public, anon, authenticated, service_role;
revoke all on function economy_settle_proposal(text, text) from public, anon, authenticated, service_role;
revoke all on function economy_append_journal(jsonb) from public, anon, authenticated, service_role;
revoke all on function economy_try_hold(text, uuid, numeric, text, text, numeric, numeric) from public, anon, authenticated, service_role;

grant execute on function economy_note_receipt(text, text, text, integer, numeric, text, text) to chogos_economy_verifier;
grant execute on function economy_settle_proposal(text, text) to chogos_economy_verifier;
grant execute on function economy_append_journal(jsonb) to chogos_economy_verifier;

grant execute on function economy_open_proposal(jsonb) to service_role;
grant execute on function economy_apply_status(text, text, text, text) to service_role;
grant execute on function economy_try_holds(jsonb) to service_role;
grant execute on function economy_release_operation(uuid, uuid) to service_role;
grant execute on function economy_ledger_snapshot(timestamp with time zone) to service_role;

revoke insert, update, delete, truncate on table economy_proposals from service_role;
revoke insert, update, delete, truncate on table economy_reservations from service_role;
revoke insert, update, delete, truncate on table economy_journal from service_role;
revoke insert, update, delete, truncate on table economy_proposal_audit from service_role;
grant select on table economy_proposals, economy_reservations, economy_journal, economy_proposal_audit to service_role;
```

The file does not grant `chogos_economy_verifier` to `service_role`, `anon`, or `authenticated`. It does not grant the verifier table privileges. It does not create a password. The verifier role is not `BYPASSRLS`.

| Capability | Who can do it after the verifier file is applied |
| --- | --- |
| Insert a proposal as `proposed` | `service_role` through `economy_open_proposal`. The insert guard still rejects any other status. |
| Ordinary status | `service_role` through `economy_apply_status`. That function rejects `confirmed`, `reverted`, and `settled`. |
| Receipt confirmation, revert release, and settlement | `chogos_economy_verifier` through `economy_note_receipt` and `economy_settle_proposal`. |
| Chain journal line | `chogos_economy_verifier` through `economy_append_journal`. |
| Create, re-hold, or release a reservation | `service_role` through `economy_try_holds` and `economy_release_operation`. |
| Legacy one-row hold | Nobody. `economy_try_hold` stays revoked and does not insert. |

Receipt and settlement updates to reservations run inside the definer functions. `service_role` cannot call those functions and cannot update the rows itself after the revoke.

Settlement journal: a receipt has no transfer amount. After `verifyMainnetReceipt` returns a successful branded receipt, and after a service-role read shows the proposal is `confirmed` or `settled` on that same transaction, the server posts two `external` lines of kind `receipt_observed`, amount `1`, evidence key `143:<tx>:receipt`. That key satisfies the settlement check. It is a linkage, not a decoded transfer, and it is not a treasury account, so the ledger transfer query does not count it. A conflicting or unconfirmed proposal does not get this posting. A second call finds the evidence key and returns duplicate. The verifier migration adds `receipt_observed` to the journal kind check without rewriting existing lines.

Application:

- `createEconomyVerifierClient` lives in `src/lib/db/client.ts`, which imports `server-only`. It reads `SUPABASE_ECONOMY_VERIFIER_KEY` and throws when that value is empty. It does not read the service-role key.
- `confirmEconomyReceipt` calls `verifyMainnetReceipt` first. Only a branded receipt is passed to `economy_note_receipt`, and only through the verifier client.
- `settleEconomyProposal` uses the same verifier client for `economy_append_journal` and then `economy_settle_proposal`.
- If the key is unset, both functions return a failure and do not call SQL with the service role.
- `saveEconomyDecision` and `readEconomyLedger` stay on the service role.
- No file under `src/app` imports these functions. Client components do not reference the verifier key.

Credential, created by an operator. This change does not mint it:

- Mint a Supabase JWT whose `role` claim is `chogos_economy_verifier`, signed with the existing project JWT secret.
- Store it only as the server environment variable `SUPABASE_ECONOMY_VERIFIER_KEY`.
- Do not put the token, a sample token, or the JWT secret in the repo or in a `NEXT_PUBLIC_` variable.

## Deployment order

Zero-downtime mixing is unsafe. Use a maintenance window and stop the running app before the SQL. Prerequisites: the migration role owns the economy tables; `anon`, `authenticated`, `service_role`, and `authenticator` exist; no watcher checkpoint is moved; execution stays disabled.

1. If `economy_proposals` is missing, apply `20261019230000_phase7_economy.sql`. Do not edit that file. Skip this step when Phase 7 is already present.
2. Apply `20261020050000_phase8_receipt_verification.sql`.
3. Apply `20261021000000_phase8_economy_verifier.sql`.
4. Run the verification queries in the next section on that database and keep the output. Until that output matches, production permissions are not fixed.
5. Set `SUPABASE_ECONOMY_VERIFIER_KEY` on the server. This repository change does not do that.
6. Deploy this application. Confirm and settle stay closed until both the migration and the key are present. They do not fall back to `service_role`.
7. Do not enable execution, the watcher, a signer, or a relayer.

Compatibility:

| Database | Application | Result |
| --- | --- | --- |
| Phase 7 only | This commit | Reservation saves send `{ operationId, holds }`. Phase 7 expects an array, returns malformed before its insufficient-batch release, and the app records a deferred failure with no status write and no release. The proposal stays `proposed`. Confirm and settle fail closed because the verifier role does not exist. |
| Phase 8 receipt file, no verifier file | An older build that sends a bare hold array | `economy_try_holds` returns malformed before any insert. That older build records status `deferred`, which blocks a later `approved`. Do not combine them. |
| Phase 8 receipt file, no verifier file | This commit | Reservation saves can succeed. `service_role` can still write receipts, journal lines, and reservation state. Confirm and settle fail closed without the verifier role. |
| Verifier file applied | An older build that confirms through `service_role` | Those calls fail. Reservation saves through `economy_try_holds` still work. |
| Verifier file applied, key unset | This commit | Confirm and settle fail closed. Reservation saves still use `service_role`. |
| Verifier file applied, key set | This commit | Confirm and settle use the verifier client only after `verifyMainnetReceipt` succeeds. |

Both unapplied files are safe to run again. They use `create or replace`, `add column if not exists`, and conditional role and constraint changes. They do not delete economic rows, drop tables, or rewrite posted history. If a statement fails inside a transaction, the runner rolls that migration back. Run the same file again. Do not repair receipt columns by hand.

Rollback, if the verifier file was applied and must be undone. This does not drop columns or delete rows:

1. `GRANT EXECUTE` on `economy_note_receipt`, `economy_settle_proposal`, and `economy_append_journal` back to `service_role`.
2. `GRANT INSERT, UPDATE` on `economy_proposals` and `economy_reservations` to `service_role`. `GRANT INSERT` on `economy_journal` and `economy_proposal_audit` to `service_role`.
3. Deploy an application that sends confirm, journal append, and settle through the service role again.
4. Leave `operation_id`, `economy_release_operation`, the proposed-insert guard, and `receipt_observed` in place.
5. Do not set `execution_enabled`, configure a signer, or enable a relayer.

The table owner remains a break-glass path.

## Verification queries

Run these on the database after step 3. Expected booleans are in the comments. The local PGlite test asserts the same predicates. Hosted output is still required before calling production permissions fixed.

```sql
select has_function_privilege('service_role', 'economy_note_receipt(text, text, text, integer, numeric, text, text)', 'execute'); -- false
select has_function_privilege('service_role', 'economy_settle_proposal(text, text)', 'execute'); -- false
select has_function_privilege('service_role', 'economy_append_journal(jsonb)', 'execute'); -- false
select has_function_privilege('service_role', 'economy_try_hold(text, uuid, numeric, text, text, numeric, numeric)', 'execute'); -- false
select has_function_privilege('service_role', 'economy_try_holds(jsonb)', 'execute'); -- true
select has_function_privilege('chogos_economy_verifier', 'economy_note_receipt(text, text, text, integer, numeric, text, text)', 'execute'); -- true
select has_function_privilege('chogos_economy_verifier', 'economy_try_holds(jsonb)', 'execute'); -- false
select has_table_privilege('service_role', 'economy_proposals', 'update'); -- false
select has_table_privilege('service_role', 'economy_reservations', 'update'); -- false
select has_table_privilege('service_role', 'economy_journal', 'insert'); -- false
select has_table_privilege('service_role', 'economy_proposals', 'select'); -- true
select pg_has_role('service_role', 'chogos_economy_verifier', 'member'); -- false
select pg_has_role('authenticator', 'chogos_economy_verifier', 'member'); -- true
select rolbypassrls, rolcanlogin, rolinherit from pg_roles where rolname = 'chogos_economy_verifier'; -- false, false, false
select execution_enabled from economy_controls; -- false
```

Local re-run: `src/lib/economy/phase8-verifier.test.ts` opens a database, applies every migration file, runs the reservation and settlement flow, repeats the verifier file, and checks that proposal, reservation, and journal counts stay the same. Reproduce it with `npx vitest run src/lib/economy/phase8-verifier.test.ts`. It does not connect to hosted Supabase.

## Observer

`readEconomicTreasury` and `assessTreasuryRead` are unchanged. Tests cover:

- `not_configured` when the economic address is unset. Balances stay null.
- `stale` when the read is older than the allowed age. Raw MON and `$CHOG` can be shown, and unallocated amounts stay null.
- `unavailable` when the RPC throws or no RPC URL is configured. The error text redacts the URL.
- `wrong_chain` for chain 10143. Native and token balance calls are not made, and unallocated amounts stay null.
- A non-canonical token is `malformed`. A fresh read keeps MON at 18 decimals and uses the decimals returned for canonical `$CHOG`.

`CHOG_BANK_ASSET_ADDRESS` is not set by this change. The NFT treasury is not substituted.

## What stayed disabled

`evaluateProductionEconomy` still sets `executionEnabled: false` and `factoryDeployed: false`. The signer kind stays `none`. `productionBankRuntime` stays fail-closed. `/api/transactions` still calls `assertExecutionDisabled`. `account.executeSession` is still refused. The navigation does not link to `/economy`. No Solidity, relayer, or watcher file is changed.

## Residual risk

Hosted Supabase is unchanged. Until an operator applies the Phase 8 receipt file, the Phase 8 verifier file, and checks the queries above, production `service_role` can still call `economy_note_receipt` and `economy_settle_proposal`, update receipt columns, insert a journal line, and update reservation state. Hosted `economy_try_hold` can still insert a row with a null `operation_id`. The status guard checks shape, chain 143, and a journal row. It does not see Monad. SQL does not verify a receipt. This change does not apply the files and does not create `SUPABASE_ECONOMY_VERIFIER_KEY`.

After those files are applied, the table owner can still write directly. That break-glass path is outside the verifier role. `receipt_observed` is not a decoded transfer amount. A stored hash on the economy page stays unverified until some server call runs `verifyMainnetReceipt` for it. The page loader does not do that.

`interpretLedgerSnapshot` leaves `chainVerified` false. `presentEconomy` builds an explorer link only when `applyRpcVerification` has already marked that row from a branded receipt in the same call. A passing test is not a claim that a particular production transaction was verified.

The civilization treasury query on `/economy` can still hold the document open. That behavior is unchanged.

No test in this phase calls a live RPC endpoint or hosted Supabase. The signer stays unset, the relayer stays disabled, the economic treasury stays unconfigured, and `executionEnabled` stays false. `/api/transactions` still returns 403. Mainnet settlement is not production-ready.

## Production state

No production state was changed. No SQL was applied, no environment variable was written, no watcher checkpoint was read or moved, and no transaction was signed or broadcast.
