# Phase 6c — NFT transfer watcher and restricted relayer

Date: 19 October 2026.
Base: production `cursor/phase-1-genesis-world-155c` after Phase 6b PR #27 (`00f365b`).
Status: **implementation and review only**. No factory deploy, no broadcast, no live signer, no hosted SQL, no world reset.

## What this adds

- A restart-safe scanner for ERC-721 `Transfer` logs on Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`, chain 143.
- Cursor, block hash, and log identity so a process can stop and resume. Duplicate logs are ignored. A hash mismatch rewinds and replays the canonical block.
- Session invalidation queue when any transfer has a block number above the session `openedBlock`. A→B and A→B→A both qualify. The row stays `queued` until a receipt exists.
- Preflight before `executeSession`: watcher must be caught up, chain/NFT/account/token must match, and any post-open transfer refuses the call.
- Relayer gate for `factory.create`, `account.executeSession`, and `account.invalidateSession` only. Production mode does not sign or broadcast.
- Receipt reconciliation that will not spend a reservation twice, will not spend on revert or unknown receipts, and will not move a reservation when the hash is ambiguous.

`world_tick()` does not scan and does not wait on RPC. `/api/transactions` still refuses execution.

## Transfer revocation

1. The watcher stores each Transfer with block number, block hash, transaction hash, transaction index, log index, token id, and endpoints.
2. A watched session is stale when any stored transfer for that token is after `openedBlock`.
3. `sponsorSessionCall` reads that history even if the caller passes an empty transfer list. It also reads the current owner.
4. Stale sessions enqueue `invalidateSession`. The local job is not `confirmed` while the relayer is disabled.
5. Returning the NFT to the original owner does not clear the queue and does not allow `executeSession`.

## Residual race

Offchain monitoring is not onchain enforcement.

- A transfer mined after the watcher last scanned, or included in the same block as a sponsored transaction, can still be ordered before `invalidateSession`.
- `executeSession` on the account still accepts A→B→A when nobody has called the account and `ownerOf` is the original owner. The watcher is what refuses to submit that call. If a transaction was already broadcast, this process cannot pull it back.
- A queued invalidation is not an invalidated session. The onchain session stays live until `invalidateSession` is mined.
- Genesis still has no transfer callback. `syncOwner` only latches when the account itself is called.

## Signer

Dependencies are viem and the app server. There is no KMS, HSM, or custody SDK in the project, and this change does not add one. `loadProtectedSigner` still refuses `CHOG_BANK_*` private keys and does not construct a signing account. `CHOG_BANK_RELAYER_ENABLED` does not broadcast. Tests use a scripted relayer that returns canned outcomes and never opens a socket.

The gas signer, when one exists later, must be a separate key from any treasury asset owner. This PR does not create that key.

## Mocked versus live

| Item | State |
| --- | --- |
| Watcher scan | Library plus in-memory snapshot. Not a running production indexer. |
| SQL `20261019120000_phase6c_transfer_watcher.sql` | In the repo. Not applied to hosted Supabase. |
| Relayer / signer | Disabled. |
| Factory `0xA2edAC99…` and V1 `0x2d8c32…` | Not deployed. |
| Treasury balance | Still unset. Sponsorship fails closed. |
| World, enrollment, AI schedule | Unchanged. |

## Enablement prerequisites (not this PR)

1. Apply the Phase 6c SQL on hosted Supabase by hand.
2. Run the watcher out of band from `world_tick`, with a persisted cursor, against chain 143 Genesis logs. Backfill from the earliest open session block before any sponsored execution.
3. Treat lag, RPC errors, and a stale success timestamp as unhealthy. Do not sponsor while `executionAllowed` is false.
4. Confirm invalidations onchain. A queued row is not enough.
5. Deploy and verify the V1.1 factory only after a separate authorization. Do not deploy V1.
6. Configure an observed treasury balance and a gas signer that is not an env var in git, the browser, or the model.
7. Keep `/api/transactions` closed until those checks pass.

Phase 6d persists the same scanner and still does not broadcast or apply hosted SQL. See [phase-6d-operations.md](phase-6d-operations.md).
