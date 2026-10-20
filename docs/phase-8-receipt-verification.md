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
- An insufficient `economy_try_holds` batch releases held rows whose keys are in that batch. It does not release unrelated keys.

Those database checks do not read Monad. They accept the arguments the service role sends.

## Audit findings

1. `assessReceiptEvidence` accepted a caller-built object and returned a TypeScript value named as a verified receipt. `noteVerifiedReceipt` and `settleVerifiedProposal` wrote that object into SQL. A cast or a matching shape was treated as proof.
2. `interpretLedgerSnapshot` set `chainVerified` from stored receipt columns and from an evidence-key prefix. The economy page could render an explorer link for a hash this process had not read.
3. `economy_try_hold`, `economy_try_holds`, and the in-memory `tryHold` returned success when an idempotency key already existed, without comparing proposal, asset, or amount. `economy_open_proposal` did the same for a repeated key.
4. Two `tryHold` calls that do not share a lock can both succeed against one observed balance. `economy_lock` is the production serializer. A process-local mutex is not.
5. The read-only observer already returns `not_configured`, `stale`, `unavailable`, and `wrong_chain` without inventing a zero balance, and it reads `$CHOG` only from `addresses.chogToken`. This phase re-checks that behavior. It does not change the observer into a writer.

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

`tryHold` compares proposal id, token id, asset, bucket, and amount. A difference returns `conflict` and does not change the existing hold. An exact replay returns `created: false`.

`holdFailureStatus("conflict")` is `rejected`. `persistEconomyDecision` writes that status and does not release the prior hold. `insufficient_funds` stays `insufficient_funds`. Other hold failures stay `deferred`.

The new migration replaces `economy_try_hold`, `economy_try_holds`, and `economy_open_proposal` with the same comparisons. A conflict returns before any `UPDATE` or release. An exact replay still returns the existing id and `created: false`.

`economy_note_receipt` and `economy_settle_proposal` are replaced so a different transaction returns `outcome: conflict` before `UPDATE`, and a duplicate returns before `UPDATE`. The journal requirement for settlement is unchanged. `executed` stays false.

## Migration review

File: `supabase/migrations/20261020050000_phase8_receipt_verification.sql`.

Apply manually, later, and only in this order:

1. `supabase/migrations/20261019230000_phase7_economy.sql`
2. `supabase/migrations/20261020050000_phase8_receipt_verification.sql`

This change does not apply either file. It does not insert balances, change `economy_controls`, or mention watcher checkpoints. The replaced functions keep `security invoker`, `search_path = public`, and `FOR UPDATE` on `economy_lock`. Execute is revoked from `public` and granted to `service_role` when that role exists. Signatures are unchanged, so this is a `CREATE OR REPLACE` rather than a new argument list.

Safe retry of an identical proposal or an identical reservation returns the existing row. A retry that changes proposal, asset, or amount fails closed. A retry of the same confirmed or settled transaction does not append another audit row.

One Phase 7 behavior remains. `economy_try_holds`, after the identity check, can still release held rows whose keys are in an insufficient batch. A batch that mixes an existing matching key with a new key can therefore release the earlier hold when the combined amount does not fit. A conflict returns before that release. The in-memory `tryHold` path does not release on conflict.

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

Postgres cannot call Ethereum. A process that already has the service role can still execute `economy_note_receipt` or `economy_settle_proposal` with fields it invented. The application path will not do that, and this review does not claim the database can detect a lie from that role. Closing that gap would mean a later design that does not grant those functions to a role which also accepts caller-supplied receipt fields.

The hosted migration is not applied, so production reservations still have the Phase 7 idempotency behavior until an operator applies both files. This agent did not apply them.

The economy page does not re-check stored hashes during render. Explorer links appear only after `applyRpcVerification` has a branded receipt from the same call. A loaded ledger therefore shows stored proposals without calling them verified.

The civilization treasury query on `/economy` can still hold the document open. That behavior is unchanged.

No test in this phase calls a live RPC endpoint or hosted Supabase. A passing test is not a claim that a particular production transaction was verified.

## Production state

No production state was changed. No SQL was applied, no environment variable was written, no watcher checkpoint was read or moved, and no transaction was signed or broadcast.
