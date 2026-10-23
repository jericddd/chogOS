> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 6d — watcher, gas observation, and signer

Phase 6d makes the Phase 6c transfer watcher restart-safe and adds a read-only view of the gas-paying MON balance. It does not deploy contracts, broadcast transactions, create citizen accounts, move assets, apply hosted SQL, or enable a signer.

The production branch remains `cursor/phase-1-genesis-world-155c`. The network is Monad mainnet, chain id 143. Chog Genesis is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`.

## What is implemented

- The existing in-memory scanner is unchanged. A run loads a snapshot, scans, and saves it back in one database function.
- Cursor, canonical block hashes, transfer logs, watched sessions, invalidation jobs, and the id counter are stored for chain 143.
- Log identity is `143:<blockHash>:<txHash>:<logIndex>`. The `nft_transfer_logs.id` uuid is not that identity. Replaying a block does not create a second job.
- A hash mismatch rewinds the cursor and the next save drops the orphaned block.
- `npm run watcher:run` is a separate process. It is not imported by `world_tick()` or the AI runner. With `CHOG_WATCHER_ENABLED` unset, it exits 0 and does not open an RPC client.
- Health includes status, cursor, tip, lag, last success, last error, and invalidation counts. `executionAllowed` means the cursor is fresh and at the tip. `sponsorshipAllowed` also requires zero queued, submitted, or failed invalidations.
- Gas observation reports the observed balance, timestamp, block, reserved gas, reserved deployment, available gas, business capital, and the configured limits. Business capital is not added to available gas. A model claim is not a balance (`fundsFromModel` returns null).
- The gas signer interface allows only `factory.create`, `account.executeSession`, and `account.invalidateSession`. `canSign` is false.

## What stays disabled

- No transaction is signed or broadcast. `CHOG_BANK_RELAYER_ENABLED=true` still does not broadcast.
- `/api/transactions` still returns 403 through `assertExecutionDisabled`.
- The V1.1 factory `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` is not deployed. The V1 prediction `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` stays unused.
- Hosted Supabase does not receive this migration from the application.
- A queued or submitted invalidation is not an onchain `invalidateSession`. Nothing in this phase marks one confirmed.

## Environment

Never put a private key, mnemonic, keystore password, or KMS credential in the environment, Git, the browser, model context, or Supabase.

| Variable | Required to scan | Meaning |
| --- | --- | --- |
| `CHOG_WATCHER_ENABLED` | yes, `true` | Off by default. Does not start on boot. |
| `MONAD_CHAIN_ID` | `143` | Any other chain exits 1 without scanning. |
| `MONAD_RPC_URL` | yes | HTTPS endpoint the watcher reads. A missing URL exits 1. |
| `SUPABASE_URL` | yes | Service database. Loopback HTTP is accepted for local PostgREST. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only. Bypasses row level security. |
| `CHOG_WATCHER_BACKFILL_FROM` | first run | Block number where an empty cursor starts. Unset does not mean block 0. The scan records an error until this, or a saved cursor, exists. |
| `CHOG_WATCHER_RANGE_BLOCKS` | no | Default 100, maximum 5000. Inclusive block span of one `eth_getLogs` request. The public Monad RPC rejects a span above 101 blocks. |
| `CHOG_WATCHER_MAX_BLOCKS_PER_RUN` | no | Default 5000, maximum 50000. The process checkpoints and exits. The next run continues. |
| `CHOG_WATCHER_MAX_LOGS_PER_RANGE` | no | Default 2000. A page this size is split. A single block at the cap does not advance the cursor. |
| `CHOG_WATCHER_RPC_ATTEMPTS` | no | Default 4. Transient errors only. A size limit splits instead of using these attempts. |
| `CHOG_WATCHER_RPC_PAUSE_MS` | no | Default 200. Wait between committed ranges in one run. |
| `CHOG_WATCHER_RPC_RETRY_MS` | no | Default 400. Base backoff after a rate limit or timeout. |
| `CHOG_WATCHER_SECONDS` | loop only | Default 60. Used when `CHOG_WATCHER_LOOP=true`. |
| `CHOG_WATCHER_MAX_LAG_BLOCKS` | health | Default 20. Lag above this is stalled. |
| `CHOG_WATCHER_MAX_STALE_MS` | health | Default 120000. A quiet cursor older than this is stalled even if it once matched the tip. |
| `CHOG_NFT_ADDRESS` | must stay Genesis | Any other contract exits 1. |
| `CHOG_BANK_GAS_ADDRESS` | before spending | Public gas-paying address. Observation only. |
| `CHOG_BANK_ASSET_ADDRESS` | optional | Public asset-control address. Configuration refuses to load if it equals the gas address. |
| `CHOG_BANK_OBSERVATION_MAX_AGE_MS` | observation | Default 120000. Older readings are stale and not spendable. |
| `CHOG_BANK_*_WEI` | limits | Spending caps. They are not a balance. |

`CHOG_BANK_RELAYER_PRIVATE_KEY`, `CHOG_BANK_SIGNER_KEY`, `CHOG_BANK_TREASURY_PRIVATE_KEY`, `CHOG_BANK_GAS_PRIVATE_KEY`, and `CHOG_BANK_ASSET_PRIVATE_KEY` are refused. The process does not copy them into a signer.

## Scheduling

Apply the migrations below before enabling the watcher. Then use cron for one shot:

```bash
CHOG_WATCHER_ENABLED=true npm run watcher:run
```

Exit 0 means the scan committed, including a run that stopped at its block budget before the tip. Exit 1 means it did not, or it committed an error cursor after a partial scan. The JSON line includes `caughtUp`, `ranges`, `fromBlock`, `toBlock`, `status`, `cursorBlock`, `tipBlock`, `lagBlocks`, `lastError`, and the invalidation backlog.

`CHOG_WATCHER_LOOP=true` repeats until a scan exits 1. Prefer cron or a process supervisor so a stuck loop is visible. Do not run this inside the world tick route.

Each run requests `eth_getLogs` for ranges of `CHOG_WATCHER_RANGE_BLOCKS` (default 100) and stops after `CHOG_WATCHER_MAX_BLOCKS_PER_RUN` (default 5000). The public Monad endpoint allows about 100 blocks per call. A larger range that returns “limited to a 100 range” is split. The cursor is saved after every committed range. The next run resumes there. A rate limit or timeout is retried. See [onchain-watcher.md](onchain-watcher.md). Leave the watcher disabled until that procedure has been reviewed. `lagBlocks` stays above zero during a backfill, and sponsorship stays off. `executeSession` stays refused even after the watcher catches up.

## Database

Prerequisite, in order, on the database the watcher will use:

1. `supabase/migrations/20261019120000_phase6c_transfer_watcher.sql`
2. `supabase/migrations/20261019130000_phase6d_watcher_durable.sql`

Phase 6d adds `nft_watched_sessions`, `nft_watcher_invalidations`, and `nft_watcher_state`, plus `load_nft_watcher_snapshot(nft)` and `save_nft_watcher_snapshot(payload)`. Those functions are the only supported write path. They are not applied to hosted Supabase by this change.

If the functions are missing, the watcher exits 1 with `Phase 6d watcher migration has not been applied` and does not treat that as an empty chain.

Anon and authenticated roles have no grants. The service role does.

Saving a snapshot replaces the chain-143 rows for that NFT inside one database transaction. A crash before the function commits keeps the previous cursor. The next run retries from that cursor.

## Failure recovery

- RPC error: the last committed block stays. `lastError` is set. `executionAllowed` and `sponsorshipAllowed` are false. Fix the RPC and run again. Do not delete the cursor to “unstick” a scan unless the hash data is known to be wrong.
- Reorg: the next scan compares stored hashes with the canonical header, drops the divergent suffix, and replays. Do not hand-edit logs.
- Stale process: if `lastSuccessAt` is older than `CHOG_WATCHER_MAX_STALE_MS`, sponsorship stays off until a new successful scan.
- Invalidation backlog: queued, submitted, and failed rows block sponsorship for the whole watcher. Confirmed is not a backlog, but that session must not be sponsored again.
- This phase has no receipt writer. Do not mark a row confirmed by hand. A confirmed row means a later phase observed `invalidateSession` on chain.
- A failed invalidation stays failed until an operator has a real receipt path. Deleting it reopens sponsorship and can hide a transfer. Do not delete it to make a demo pass.
- Wrong chain or a gas balance read for another address produces no available balance. Available is null, not zero, unless a fresh chain-143 read actually observed the configured address.

## Gas and treasury

Three pools stay separate:

- Business investment capital. Recorded on its own. Never counted as gas.
- Deployment gas. Reserved on its own when a later phase is allowed to deploy.
- Sponsored-transaction gas. The balance that matters here is the configured `CHOG_BANK_GAS_ADDRESS`.

`CHOG_TREASURY_ADDRESS` remains the Chog Genesis mint receiver. It is not the economic treasury and not the gas signer.

Observation checks chain id 143, the configured address, the RPC balance, and the age of the reading. Reserved gas and reserved deployment are subtracted only after that reading is fresh. Hypothetical revenue is ignored. The AI model cannot submit a balance or mark funds received.

A fresh zero balance is a real observation: available is 0 and sponsorship is refused. A failed RPC is not a zero balance.

The in-process sponsorship lock stops two concurrent requests in one process from both reserving the same MON. It does not coordinate multiple machines. The relayer is off, so that limit is not a live spending control yet. A later phase needs a database lock around reservations before any broadcast.

## Signer

Inspected dependencies: `viem`, `@supabase/supabase-js`, and `next`. There is no AWS KMS client, Google Cloud KMS client, Privy SDK, Turnkey SDK, or Fireblocks SDK.

Until one of those is deliberately added and reviewed, signing stays disabled. Setup when a later phase is authorized:

1. Choose a custody system outside this repository. Do not add a raw private key to the environment.
2. Create a gas-paying key that cannot move treasury assets. Put only its public address in `CHOG_BANK_GAS_ADDRESS`.
3. Keep the asset-control key in a different custody entry. Put only that public address in `CHOG_BANK_ASSET_ADDRESS`.
4. Implement `sign` for the three approved operations and nothing else. Do not enable `CHOG_BANK_RELAYER_ENABLED` in the same change.
5. Prove chain id, factory bytecode, watcher health, and a fresh gas observation before any broadcast is even proposed.

`loadGasSigner().canSign` is false in this phase, including when the public gas address is set.

## Session transfer race

V1.1 `CitizenAccount.syncOwner` returns immediately when `ownerOf` equals `lastSeenOwner`. `executeSession` then checks `currentOwner() == ownerAtOpen`. Both pass after A→B→A if nobody called the account while B held the NFT. `grantDelegation` still reverts `DelegationDisabled`; that does not fix sessions.

The watcher sees both transfers and queues one invalidation. That queue is not atomic with `executeSession`. A transfer can be ordered before the invalidation in the same block, or the execution can land before the watcher has included `invalidateSession`. Zero lag is necessary and not sufficient.

Chog Genesis cannot supply an ownership nonce or a transfer callback. Calling `syncOwner` after the NFT has returned to A does not invalidate the session. No change in this phase alters CitizenAccount bytecode, because that would move the V1.1 CREATE2 address.

Smallest later change: a new account that records an ownership nonce at `openSession` and requires that same nonce in `executeSession`. Genesis does not have that nonce, so the account cannot be a drop-in edit of V1.1. The new bytecode needs a new factory address. Leave both `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` and `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` undeployed. No citizen account exists yet, so there is no account state to migrate; the cost is that every predicted address changes and must be recomputed from the new factory.

Until that design exists, the honest limit is: only a trusted executor should be able to call `executeSession`, and that executor must refuse while the watcher is unhealthy, stale, backlogged, or missing history. Other callers are not bound by the watcher. This repository does not enable that executor.

## Mainnet launch prerequisites

All of the following are still open:

1. Apply the Phase 6c and 6d SQL by hand and confirm `load_nft_watcher_snapshot` returns a snapshot.
2. Set `CHOG_WATCHER_BACKFILL_FROM` to the block of the earliest session that will ever be sponsored, then backfill until lag is zero.
3. Run `npm run watcher:run` on a supervisor. Confirm a restart continues from the saved cursor.
4. Fund the gas-paying address out of band. Record its public address. Observe a fresh balance on chain 143. Do not count business capital or forecast revenue.
5. Install and review a real custody signer. Keep it separate from the asset key. `canSign` must remain false until that review.
6. Decide the session-race design above. Do not deploy V1 or V1.1 while `executeSession` can succeed after an unseen A→B→A.
7. Verify factory bytecode at the address that will actually be deployed. A predicted address is not deployed code.
8. Only then consider a separate change that broadcasts. `/api/transactions` stays closed until that change.
