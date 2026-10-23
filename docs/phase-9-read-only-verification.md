> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 9 — Read-only mainnet verification

Date: 20 October 2026.
Base: `cursor/phase-1-genesis-world-155c` at the Phase 8 merge `066123b`.
Status: **code-complete, operationally blocked**. This change does not apply SQL, change a Vercel variable, deploy, sign, or broadcast. Spending stays off.

## What this phase checks

The economy page and `GET /api/economy/receipt?tx=` re-read a transaction that is already stored on an economy proposal or a counted journal line. The read uses `verifyMainnetReceipt`. There is no second receipt verifier.

A check reports one of four results:

| Status | Meaning |
| --- | --- |
| `verified` | A successful receipt was checked, and its block hash matches the canonical Monad mainnet block at that height. |
| `reverted` | The receipt exists on the canonical block and its status is reverted. |
| `pending_or_unavailable` | No receipt was found, the RPC failed, the RPC is unset, or the read budget is spent. |
| `invalid_or_inconsistent` | The hash, chain, receipt, logs, or canonical block do not agree. |

`verified` on a fresh row means the check just ran. A cached row keeps the same status and says it is not a fresh verification. The cache lasts 30 seconds in the server process. It is not a shared store, and it is not a substitute for the next read.

A stored `receipt_block_hash` or `receipt_status` that disagrees with the canonical receipt is shown as a discrepancy. The stored row is not labeled as freshly verified.

Opening `/economy` does not call `economy_note_receipt`, `economy_append_journal`, or `economy_settle_proposal`. It does not change a proposal, a reservation, or a journal row.

## Three facts that stay separate

**Receipt evidence.** The canonical receipt check above. Success is not a transfer.

**Decoded transfer evidence.** A `Transfer(address,address,uint256)` log from the configured `$CHOG` token, decoded from that same receipt. The topic is `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`. The token address is `addresses.chogToken` in `src/lib/blockchain/addresses.ts`, recorded in [contracts.md](contracts.md). Decimals shown beside the raw amount are the recorded value 18 from 10 October 2026. This page does not call `decimals()`.

Direction is relative to `CHOG_BANK_ASSET_ADDRESS` when that public address is set:

- `treasury_in` and `treasury_out` name the configured economic treasury.
- `external` is a transfer between other wallets. It is not treasury revenue or expenditure.
- `unattributed` means the economic treasury address is not configured.
- `ambiguous` means the sender and recipient do not give one direction.

Every decoded transfer has `countsInTreasury: false`. This phase does not post a journal line for it. A decoded transfer is not a settlement.

**Accounting settlement.** A proposal whose stored status is `settled`. The page repeats that stored status and says the page did not settle it. A receipt check cannot settle a proposal.

`receipt_observed` keeps the Phase 8 meaning: a linkage between a verified receipt and settlement, with external accounts and amount 1. The ledger snapshot still does not count those rows as treasury transfers, and the page drops that kind if it appears in the transfer list. This phase does not add a journal kind.

## What it does not verify

- Native MON value. Receipt success is not turned into a MON amount.
- Tokens other than the configured `$CHOG` contract. Wrapped MON and any other log are unsupported.
- That a proposal's calldata moved funds.
- That a stored settlement is still the right accounting entry. The page does not rewrite history.
- Production database grants. Local tests read the Phase 8 migration text and the local PGlite suite. They do not connect to hosted Supabase.
- A live Monad RPC. The tests use a scripted caller. An unset `MONAD_RPC_URL` fails closed as unavailable.

The NFT watcher is unchanged. It stays disabled. This phase does not move a checkpoint. A reorg is the canonical block check inside `verifyMainnetReceipt`: a block hash that no longer matches is `invalid_or_inconsistent`. A removed log, a repeated log index, or a log whose transaction or block hash disagrees with the receipt fails the receipt as malformed.

## Bounds

The page checks at most 8 distinct recorded hashes per load. `?tx=` is placed first when that hash is already recorded. A hash that is not in the loaded proposals or counted journal lines is not sent to the RPC.

`GET /api/economy/receipt` uses the existing in-memory `rateLimit` helper, 12 requests a minute per forwarded client. The response is `cache-control: no-store`. A malformed hash is 400. An unknown hash is 404. A missing ledger is 503. The route does not accept an arbitrary hash as a public RPC proxy.

The server also stops new RPC reads after 30 cache misses in a minute, in that process. A paused read is not cached and is not called verified.

Identical reads that are already in flight share one RPC check.

## Local tests

```bash
npx vitest run src/lib/economy/phase9-public-verification.test.ts src/lib/economy/phase8-verifier.test.ts src/lib/economy/phase8-receipt.test.ts
npm test
npx tsc --noEmit
npm run lint
npm run build
```

The Phase 8 verifier test still applies every migration on local PGlite and checks the role grants. Phase 9 does not add a migration.

## Before a deploy

No new SQL is required. Do not apply a migration, rotate a key, or set `CHOG_BANK_ASSET_ADDRESS` as part of this phase.

1. Leave `SUPABASE_ECONOMY_VERIFIER_KEY` as it is. Confirm and settle still use it. The public page does not.
2. Leave execution, the signer, the relayer, and the watcher off.
3. `MONAD_RPC_URL` must be an https URL already present on the server. This change does not set it. Without it, receipt rows say the read is unavailable.
4. Deploy only when an operator chooses to. This branch does not deploy.
5. After deploy, open `/economy`. With no recorded hash, the page says it does not invent a transaction. `POST /api/transactions` still returns 403.

Hosted Supabase grants are unchanged by this commit. They remain whatever the operator applied for Phase 8. This repository cannot see that database from the test run.

## Rollback

Redeploy the previous application build. There is no Phase 9 migration to reverse. Cached reads disappear with the process. Journal and proposal rows are not rewritten by this code.
