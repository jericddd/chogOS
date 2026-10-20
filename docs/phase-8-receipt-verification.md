# Phase 8 — Mainnet read-only economy verification

Date: 20 October 2026.
Base: `cursor/phase-1-genesis-world-155c` at `1984e5339693d9b5ae288bab6ba3dd4d2b218dda` (merge of Phase 7, pull request #35).
Status: **review only**. No hosted SQL, no environment change, no watcher checkpoint change, no signature, and no broadcast.

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

`tryHold` and `tryHoldBatch` compare proposal id, token id, asset, bucket, and amount. A difference returns `conflict` and leaves every existing hold as it was, including a new key that shared the batch. An exact replay of every key returns `created: false` before the balance check, so a later lower observation does not release those holds.

`tryHoldBatch` is the in-memory batch used by `reserveApproved`. It checks shape, duplicate keys, identity, and funding for the whole batch before it appends anything. Funding counts every current `held` amount once, then adds only keys that are not already reserved. If that sum is above the observed balance, the function returns `insufficient_funds` and the original holds. `holdSequentially` remains the one-at-a-time demonstration; a later refusal does not change an earlier hold to `released`.

`holdFailureStatus("conflict")` is `rejected`. `persistEconomyDecision` writes that status and does not release the prior hold. `insufficient_funds` stays `insufficient_funds` and does not release. Any other hold failure, including a Phase 7 function rejecting the new payload as malformed, returns a deferred failure without writing status and without releasing. The proposal row stays `proposed`.

`createdKeys` is not ownership. The server generates `operationId` with `crypto.randomUUID()` and sends `economy_try_holds` the object `{ operationId, holds }`. The function stamps that id only on rows it inserts. Existing rows are not updated, and `economy_reservation_immutable` rejects any later change to `operation_id`, including null to a value. The success body echoes `operationId`. `proveHoldOperation` accepts the body only when that echo matches the id this attempt generated and `createdKeys` is a unique subset of the keys this call submitted. A missing list, a duplicate, a foreign key, or a different operation id is unresolved.

Unresolved ownership releases nothing. The server does not call `economy_release_operation`, does not update `economy_reservations`, and does not write `approved`. It returns a deferred failure so the same proposal can be retried. Rows this attempt inserted stay `held` under the id the database stored. A retry that finds every key already stored gets `created: false` and can write the status. It still does not release them.

When the body is proven and `created` is true, a failed status write calls `economy_release_operation(operationId, proposalId)`. That function takes no key list. It sets `state = 'released'` only where `operation_id` equals this attempt, `proposal_id` equals this proposal, and `state` is `held`. A forged `createdKeys` list that names a pre-existing hold cannot widen that update. A response that echoes another attempt's id cannot select that attempt, because the server releases only after the echo matches, and the argument it passes is the id it generated. Two concurrent attempts use different ids. One failed status write releases only its own rows.

`economy_try_hold` still inserts with `operation_id` null. The server does not call it. `economy_release_operation` does not match those rows. A reverted receipt, after `economy_note_receipt` has stored that status, releases every `held` row for that proposal id. That path is proposal scope, not the status-write cleanup, and it does not read `createdKeys`.

The diagnostic log records `economy.persist`, the event, a `missing` or `malformed` code, the proposal id, the operation id, and counts. It does not record balances, key lists, raw responses, or credentials.

The new migration replaces `economy_try_hold`, `economy_try_holds`, and `economy_open_proposal` with the same identity comparisons. A conflict returns before any insert. An insufficient batch returns before any insert and does not set existing rows to `released`. An exact replay returns `created: false`, `createdKeys: []`, and the echoed operation id. Duplicate keys in one batch are malformed and do not write. The function signature stays `economy_try_holds(jsonb)`. The JSON value changes from a bare array to `{ operationId, holds }`.

`economy_note_receipt` and `economy_settle_proposal` are replaced so a different transaction returns `outcome: conflict` before `UPDATE`, and a duplicate returns before `UPDATE`. The journal requirement for settlement is unchanged. `executed` stays false. A reverted receipt note still releases the holds for that proposal. That release is the reverted-proposal path, not the insufficient-batch path.

## Migration review

File: `supabase/migrations/20261020050000_phase8_receipt_verification.sql`.

Apply manually, later, and only in this order:

1. `supabase/migrations/20261019230000_phase7_economy.sql`
2. `supabase/migrations/20261020050000_phase8_receipt_verification.sql`

This change does not apply either file. It does not insert balances, change `economy_controls`, or mention watcher checkpoints. The replaced functions keep `security invoker`, `search_path = public`, and `FOR UPDATE` on `economy_lock`. SQL function signatures are unchanged, so this is `CREATE OR REPLACE` rather than a new argument list. `economy_release_operation(uuid, uuid)` is new. `economy_reservations.operation_id` is a new nullable uuid column.

Safe retry of an identical proposal or an identical reservation returns the existing row. A retry that changes proposal, asset, or amount fails closed. A retry of the same confirmed or settled transaction does not append another audit row. A reservation key left in `released` still exists, so a later `economy_try_holds` treats it as already stored and does not insert a new hold. The retry can record `approved` with `reserved: false`. That is the current idempotency rule. It does not re-reserve a released key.

Until the Phase 8 file is applied, hosted `economy_try_holds` still expects a JSON array. An object payload fails the array check and returns `malformed` before the Phase 7 insufficient-batch `UPDATE`. The application maps that outcome to a deferred failure, writes no status, and releases nothing. Reservation saves fail closed. They do not fall through to the old release.

## Trust boundary

Postgres cannot call Monad. `economy_note_receipt`, `economy_settle_proposal`, and `economy_proposal_status_guard` store and compare the fields they are given. Their comments say they do not query Monad and do not verify a receipt. A successful status still needs chain 143, a transaction hash, a block number, a block hash, and, for settlement, a counted journal row. Those checks are shape and consistency checks.

The trusted boundary is the server process. `src/lib/economy/db.ts` and `src/lib/economy/load.ts` import `server-only`. `confirmEconomyReceipt` and `settleEconomyProposal` call `verifyMainnetReceipt` before they build SQL arguments, and the only caller input is the proposal key and the transaction hash. No file under `src/app` calls those functions or the SQL names. The economy page loader does not call the verifier.

Phase 7 enables row level security on the economy tables and creates no permissive policy, so `anon` and `authenticated` receive no rows through the table API. It revokes table privileges from `public`, `anon`, and `authenticated`, and it grants `service_role` select, insert, and update on proposals and reservations. Journal and audit stay insert-only for that role. The service role bypasses row level security. That is why the application uses it only from server code.

Phase 7 revokes function execute from `public` and grants it to `service_role`. Supabase default privileges can still leave execute with `anon` and `authenticated` after a revoke from `public`. The Phase 8 file revokes execute on the economy functions from `public`, `anon`, and `authenticated` when those roles exist, then grants execute back to `service_role` for the functions the server calls. Trigger functions are revoked and are not granted. The functions stay `security invoker`. Revoking `service_role` update, or moving the functions to `security definer` in this change, would break `release` and the verified confirm and settle path. This migration does not do that.

Until an operator applies the Phase 8 file, hosted Postgres still has the Phase 7 `economy_try_holds` release and the Phase 7 function grants. The application in this change no longer sends that function a bare array, so the old release is not what a current reservation save executes. Applying the Phase 8 file is still required before a reservation save can succeed.

## Verifier role (design only, not applied)

`service_role` bypasses row level security. Today it can:

- call `economy_note_receipt` and `economy_settle_proposal` with invented hashes, block numbers, and statuses;
- `UPDATE economy_proposals`, including `tx_hash` and the receipt columns, subject only to the status guard's shape checks;
- `INSERT` a proposal row whose status is already `confirmed` or `settled` if the receipt columns and a journal row satisfy that guard;
- `INSERT` into `economy_journal`, which is the row settlement looks for;
- `UPDATE economy_reservations` from `held` to `released` or `reconciled` without calling `economy_release_operation`.

The status guard checks chain 143, hash shape, block fields, and a journal prefix. It does not see Monad. This change does not revoke those grants. Doing so while the functions stay `security invoker` would break the server's own confirm, settle, and release calls. No verifier credential is created here.

Phase 9 needs a new migration, applied only after the Phase 8 file and the application that sends `{ operationId, holds }` are both in place. Suggested file: `supabase/migrations/20261021000000_phase9_economy_verifier.sql`. It is not in this branch.

Roles:

- `chogos_economy_verifier`: `NOINHERIT`, no `BYPASSRLS`, no table privileges, no membership in `service_role`, `anon`, or `authenticated`.
- Do not create a password in the migration. Do not commit a key.

Functions:

- `ALTER FUNCTION economy_note_receipt(text, text, text, integer, numeric, text, text) SECURITY DEFINER`.
- `ALTER FUNCTION economy_settle_proposal(text, text) SECURITY DEFINER`.
- Owner is the migration role that owns the economy tables. `SET search_path = public` stays pinned.
- `REVOKE ALL` on both functions `FROM public, anon, authenticated, service_role`.
- `GRANT EXECUTE` on both functions `TO chogos_economy_verifier` only.
- The verifier does not receive `EXECUTE` on `economy_try_holds`, `economy_release_operation`, `economy_apply_status`, `economy_open_proposal`, or `economy_append_journal`.

Table privileges, in the same migration:

- `REVOKE INSERT, UPDATE ON economy_proposals FROM service_role`.
- `GRANT UPDATE (status, reason) ON economy_proposals TO service_role` so `economy_apply_status` can still move ordinary statuses while it stays `security invoker`.
- Do not grant `UPDATE` on `tx_hash`, `receipt_chain_id`, `receipt_block_number`, `receipt_block_hash`, or `receipt_status` to `service_role` or to the verifier role. Those columns change only inside the two definer functions.
- Add a `BEFORE INSERT` guard: `status` must be `proposed`. Receipt statuses are reached only by a later update through the definer functions. `economy_open_proposal` already inserts `proposed`.
- Leave `service_role` `UPDATE` on `economy_reservations` in this first migration so `economy_release_operation` keeps working as `security invoker`.

Credential, created by an operator later, not by this change:

- Mint a Supabase JWT whose `role` claim is `chogos_economy_verifier`, signed with the existing project JWT secret.
- Store it as `SUPABASE_ECONOMY_VERIFIER_KEY`.
- Do not add that variable, a sample token, or the JWT secret to the repo.

Application, deployed only after the role and the grants exist:

- `confirmEconomyReceipt` and `settleEconomyProposal` call `verifyMainnetReceipt` first, as they do now.
- Only after that function returns a branded receipt do they call `economy_note_receipt` or `economy_settle_proposal`, and only with the verifier client.
- There is no fallback to `service_role` for those two calls.
- `saveEconomyDecision` stays on `service_role` until a later operator split.

A later optional split, still not this change: create `chogos_economy_operator` `NOINHERIT`, move `economy_try_holds` and `economy_release_operation` to `security definer`, grant that role `EXECUTE` on those two functions, and `REVOKE UPDATE ON economy_reservations FROM service_role`. The operator does not receive the receipt functions. The verifier does not receive the reservation functions. `service_role` `INSERT` on `economy_journal` can still supply the posting `economy_settle_proposal` requires. Closing that means a later function that inserts a chain journal line only from fields copied out of the branded receipt, with `EXECUTE` granted to the verifier and revoked from `service_role`.

Rollback of the verifier step:

1. `GRANT EXECUTE` on `economy_note_receipt` and `economy_settle_proposal` back to `service_role`.
2. `GRANT UPDATE ON economy_proposals TO service_role`.
3. Point confirm and settle back at the service-role client.
4. Leave `operation_id` and `economy_release_operation` in place. Do not drop columns.
5. Do not set `execution_enabled`, configure a signer, or enable a relayer.

The table owner and the Supabase dashboard role remain a break-glass path. They can still update rows directly. `anon` and `service_role` cannot call the receipt functions after the revoke.

## Deployment order

1. Apply `20261019230000_phase7_economy.sql` on any database that does not already have it. Do not edit that file.
2. Apply `20261020050000_phase8_receipt_verification.sql`. This adds `operation_id`, replaces `economy_try_holds`, adds `economy_release_operation`, and revokes `anon` / `authenticated` execute. It does not create a verifier role and does not enable execution.
3. Deploy the application commit that sends `{ operationId, holds }` and releases through `economy_release_operation`. If this deploy lands before step 2, reservation saves fail closed as described above. If step 2 lands while an older build still sends a bare array, the new function returns malformed before any insert. That older build records the failure as status `deferred`, which blocks a later `approved` on the same proposal. Apply the migration only together with this application.
4. Apply the Phase 9 verifier migration. Confirm and settle through `service_role` start failing at this moment. Reservation saves still use `service_role`.
5. Set `SUPABASE_ECONOMY_VERIFIER_KEY` in the host. This change does not do that.
6. Deploy the server that uses the verifier client only after `verifyMainnetReceipt` succeeds.
7. Do not enable execution, the watcher, a signer, or a relayer in any of these steps.

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

The service role can still call `economy_note_receipt` and `economy_settle_proposal`, or update `economy_proposals`, with fields it invented. The status guard checks shape, chain 143, and a journal row. It does not see Monad. A service-role client that also inserts a chain journal line can settle a proposal the RPC verifier never read. The application path does not do that. This review does not claim that SQL verifies a receipt. The verifier-role migration above is the reviewed way to remove that grant. It is not applied, and no verifier credential exists in this change.

The hosted Phase 8 migration is not applied. This application will not successfully save a reservation until an operator applies the Phase 7 file, if needed, and then the Phase 8 file. Before that, the object payload is rejected before the Phase 7 insufficient-batch release, and the server returns a deferred failure without writing status or releasing holds. A `createdKeys` list is not used as the cleanup predicate. Cleanup releases rows whose `operation_id` and `proposal_id` match this attempt. If the response does not echo that id, nothing is released. `economy_try_hold` rows have a null `operation_id` and are outside that cleanup. A released idempotency key is not inserted again on retry. Direct `service_role` update of `economy_reservations.state` can still release any held row until a later migration revokes that privilege.

`interpretLedgerSnapshot` leaves `chainVerified` false. `presentEconomy` builds an explorer link only when `applyRpcVerification` has already marked that row from a branded receipt in the same call. The page loader does not call the verifier, so a stored hash is shown without a verified label and without an explorer link. A passing test is not a claim that a particular production transaction was verified.

The civilization treasury query on `/economy` can still hold the document open. That behavior is unchanged.

No test in this phase calls a live RPC endpoint or hosted Supabase. The signer stays unset, the relayer stays disabled, the economic treasury stays unconfigured, and `executionEnabled` stays false. `/api/transactions` still returns 403.

## Production state

No production state was changed. No SQL was applied, no environment variable was written, no watcher checkpoint was read or moved, and no transaction was signed or broadcast.
