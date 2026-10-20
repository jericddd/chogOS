# Phase 7 — Treasury, ChogBank, and the citizen economy

Date: 19 October 2026.
Base: `cursor/phase-1-genesis-world-155c`. PR #34 is already merged there as `f1dc993`.
Status: **implementation and review only**. No contract deploy, no signed transaction, no broadcast, no hosted SQL, no watcher checkpoint change, no production configuration change.

## Architecture

One Chog Genesis NFT keeps one citizen and one predicted permanent wallet. A transfer changes the controlling human. It does not create a second citizen or clear history.

Four public addresses stay distinct:

| Address | Role |
| --- | --- |
| `addresses.chogTreasury` | ChogTreasury NFT wallet. It holds founding NFTs. It is not the economic treasury. |
| Civilization Treasury row | Database record configured through `POST /api/treasury/configure`. |
| `CHOG_BANK_GAS_ADDRESS` | Public gas-paying address. Observation only. |
| `CHOG_BANK_ASSET_ADDRESS` | Optional public economic treasury. Unset means **not configured**. |

The economic observer reads only `CHOG_BANK_ASSET_ADDRESS` on Monad mainnet, chain id `143`. Native MON is read as wei. `$CHOG` is read from `addresses.chogToken`. Decimals come from that contract. A failed `decimals()` call does not assume 18. MON and `$CHOG` are never treated as the same unit, and no swap price is invented.

`productionBankRuntime` stays fail-closed: its treasury source remains unset and `relayerEnabled` stays false. A live economic observation is not copied into that runtime, so wallet activation does not start approving because a balance was read.

Predicted V2 wallets stay predicted until bytecode is observed at the address. This phase does not deploy the implementation, the factory, a citizen wallet, or EventAnchor, and it does not change their bytecode.

## What the bank decides

A citizen submits a structured proposal: objective, rationale, operation, target, selector, asset, integer base-unit amounts, estimated gas, funding request, and expected outcome. The server validates it. Model text is an estimate.

Outcomes are `approved`, `rejected`, `deferred`, `insufficient_funds`, `budget_exhausted`, and `unsupported_protocol`. Each one carries a reason.

The production path calls `evaluateProductionEconomy`, which sets `executionEnabled: false` and `factoryDeployed: false`. A configured factory address, `CITIZEN_ACCOUNT_FACTORY_CODE_VERIFIED`, or `CHOG_BANK_RELAYER_ENABLED` does not broadcast. When the other policy checks pass, including a fresh mainnet balance and a known daily gas total, the same path can record an offchain hold. That hold is an accounting reservation. `executed` stays false, and `authorizes_execution` cannot be stored as true. Turning on `executionEnabled` still requires a deployed factory before any hold, and this phase never turns that flag on.

The executable protocol allowlist defaults to empty. `ECONOMY_PROTOCOL_ALLOWLIST` must be explicit JSON with chain id 143, a checksum target, selectors, and assets `MON` or `CHOG`. Malformed JSON becomes an empty list. No router, pool, or marketplace address is built in. `EXECUTABLE_ADAPTERS` is empty. An allowlisted call without a registered adapter stays non-executable.

`$CHOG` spending limits default to `0`, so token spending is closed until an operator sets a base-unit integer. There is no lifetime transaction-count cap.

## Accounting

Holds and journal lines are different:

- A hold (`gas`, `deployment`, or `business_capital`) is an offchain reservation. It is not a payment and it does not authorize a signature.
- Gas and deployment holds are native MON. Business capital may be MON or `$CHOG`.
- Available funds are the fresh observed balance minus holds of that asset. A missing observation stays null. It is not zero.
- Journal lines are append-only and balanced. Counted treasury position includes account `treasury` with status `observed` or `realized` only.
- Proposed, submitted, and reverted lines do not count.
- The same chain evidence cannot be posted twice. A reverted receipt is stored once and does not become a later credit.
- Realized earnings, returned revenue, recovered capital, and losses classify a transfer that was already reconciled. They do not debit or credit the treasury a second time.
- Actual gas and deployment spend require a successful outgoing MON receipt.
- `journalFromModelClaim` returns null. A sentence about a deposit or a profit does not create a line.

The onchain balance of the configured treasury is authoritative. The journal reconciles evidence against it. It does not invent a deposit.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `MONAD_CHAIN_ID` | mainnet `143` for this observer | Any other application chain is `wrong_chain` and is not read as spendable. |
| `MONAD_RPC_URL` | optional https URL | Read-only. A missing URL yields `unavailable`. Timeouts yield `timed_out`. |
| `CHOG_BANK_ASSET_ADDRESS` | optional public address | Economic treasury. Rejected when it is the NFT treasury, the NFT contract, the token contract, the zero address, or the gas address. |
| `CHOG_BANK_GAS_ADDRESS` | optional | Must differ from the asset address. |
| `CHOG_BANK_OBSERVATION_MAX_AGE_MS` | optional | Older than this, a read is `stale` and its unallocated amounts are null. |
| `CHOG_BANK_MAX_CITIZEN_CAPITAL_WEI` | optional | Default `1000000000000000000` (1 MON). |
| `CHOG_BANK_MAX_BUSINESS_CAPITAL_WEI` | optional | Default `2000000000000000000` (2 MON). |
| `CHOG_BANK_MAX_TX_WEI` | existing | Per-transaction MON and gas limit. Default `0.1` MON. |
| `CHOG_BANK_MAX_DAILY_GAS_WEI` | existing | Default `1` MON. Unknown daily usage does not count as zero on the production path. |
| `CHOG_BANK_MAX_TREASURY_EXPOSURE_WEI` | existing | Default `5` MON. |
| `CHOG_BANK_MAX_CHOG_PER_TX_RAW` | optional | Default `0`. |
| `CHOG_BANK_MAX_CITIZEN_CHOG_RAW` | optional | Default `0`. |
| `CHOG_BANK_MAX_BUSINESS_CHOG_RAW` | optional | Default `0`. |
| `ECONOMY_PROTOCOL_ALLOWLIST` | optional JSON | Empty unless every rule is valid. |

No private key, deployer key, or service-role key belongs in these variables. `loadProtectedSigner` still refuses to load one.

## Migration order

Apply only after the existing Phase 6 migrations, including `20261019160000_watcher_save_timeout.sql`. Do not edit those files.

Review and apply manually, later:

`supabase/migrations/20261019230000_phase7_economy.sql`

That file creates `economy_lock`, `economy_controls`, `economy_proposals`, `economy_proposal_audit`, `economy_reservations`, and `economy_journal`. Amounts are `numeric(78, 0)`. Chain id is checked as `143`. Row level security is enabled. `anon` and `authenticated` are revoked when those roles exist. `service_role` receives table grants. Journal and audit rows are insert-only. `economy_open_proposal` inserts a proposal, and a trigger appends the audit row. `economy_try_holds` takes `economy_lock` with `FOR UPDATE` and can reserve while `execution_enabled` is false. That column is still constrained false, so turning execution on requires a new migration. `authorizes_execution` is constrained false on every reservation.

`/economy` reads `economy_ledger_snapshot` through the service role. A missing configuration, a missing function, or a failed read stays "not loaded" and is not shown as zero. Unallocated amounts stay unavailable until that read succeeds. The page does not apply this migration.

`economy_apply_status` cannot mark a proposal confirmed, reverted, or settled. `economy_note_receipt` accepts only chain 143, a 32-byte transaction hash, a block number, a block hash, and a success or reverted status. `economy_settle_proposal` then requires that stored success receipt plus a counted `economy_journal` posting for the same transaction. A hash alone does not settle.

## Operational states

Treasury reads: `not_configured`, `observed`, `stale`, `unavailable`, `wrong_chain`, `malformed`, `timed_out`.

Only `observed` on chain `143` exposes unallocated amounts. Those amounts are still not a spending authorization.

Proposal statuses: `proposed`, `approved`, `rejected`, `deferred`, `insufficient_funds`, `budget_exhausted`, `unsupported_protocol`, `cancelled`, `expired`, `submitted`, `confirmed`, `reverted`, `settled`.

`submitted` is not `confirmed`. `confirmed` requires a verified Monad mainnet receipt: chain 143, a 32-byte transaction hash, a block number, and a block hash. `settled` also requires a counted journal posting for that receipt. Explorer links are rendered only for that verified evidence. A proposal that only has a hash does not receive a link.

## Invariants

- Integer base units only. JavaScript numbers and decimal strings are rejected.
- A posting has at least two lines, and debits equal credits for each asset.
- Historical lines are not rewritten to force a balance.
- Duplicate evidence keys and duplicate kind/ref/asset pairs do not create another posting.
- Two holds against one observed balance are applied sequentially. The second fails when the remainder is too small. The database lock is what serializes production callers. A process-local mutex is not the production guard.
- Releasing a hold after rejection, cancellation, or failure does not create revenue.
- A predicted wallet address is not a balance.
- `/api/transactions` still calls `assertExecutionDisabled`.
- `account.executeSession` is still refused by `gateRelayerOp`.
- The production signer kind remains `none`.

## Security limitations

The V2 wallet bytecode has not had an independent full audit. Documented hazards remain: unsafe NFT transfer handling, trust in token `balanceOf`, and approval behavior. This phase does not enable autonomous citizen spending and does not treat an unreviewed token as safe because a policy test passed.

The economic observer is read-only. RPC errors are redacted before they are shown. The page does not receive the RPC URL or any secret.

`CITIZEN_ACCOUNT_FACTORY_CODE_VERIFIED=true` still does not mean this process read bytecode during an economy decision. The production economy path keeps `factoryDeployed` false.

There is no live end-to-end transaction test. Signing and broadcasting stay disabled.

## Before any later decision to permit live operations

All of the following are separate work. None of them is authorized by merging this PR:

1. Keep the verification rules from merged PR #34. This pull request targets `cursor/phase-1-genesis-world-155c`.
2. Review and apply `20261019230000_phase7_economy.sql` to the hosted database. Do not reset the watcher cursor while doing so.
3. Choose a public economic treasury that is not the NFT treasury, fund it manually, and set `CHOG_BANK_ASSET_ADDRESS` plus `MONAD_RPC_URL`. Confirm a fresh mainnet observation.
4. Deploy the V2 implementation, factory, and wallets only under a separate review. Do not change the bytecode that the predicted addresses were computed from unless that review also recomputes every address.
5. Observe factory bytecode independently and record that observation. A boolean by itself is not enough.
6. Obtain an independent audit of the wallet, including NFT transfers, token balance trust, and approvals.
7. Add a signer backend that is not an environment private key. `loadProtectedSigner` must keep refusing raw keys.
8. Review each protocol target and selector, then set `ECONOMY_PROTOCOL_ALLOWLIST` and register an adapter. Swaps need a real quote and an explicit slippage bound.
9. Set `$CHOG` base-unit limits deliberately. Do not infer them from a MON price.
10. Remove the `execution_enabled = false` constraint in a new migration only as part of that decision, and keep `/api/transactions` closed until the same decision names the route that may broadcast.
11. Reconcile the first real receipts into `economy_journal` from chain evidence. Do not seed balances.

## Tests

Phase 7 unit and integration tests are local. They inject treasury reads. They do not sign, broadcast, or call hosted Supabase. No test in this phase is a live end-to-end transaction.
