# Phase 6 completion status

Date: 19 October 2026. Read-only checks against Monad mainnet block 114788937 and the hosted Supabase project. Nothing in this audit was deployed, broadcast, funded, or enabled.

Phase 6 is not operational. Account execution stays closed. The blocker is the Chog Genesis transfer race, not a missing build.

## Closeout on 19 October 2026

PR #31 is merged (`b58905c`, 15:30 UTC). This closeout does not deploy, broadcast, enable the signer, change Vercel, or apply hosted SQL. The backfill process that was already running was left in place. Its cursor was not reset.

The earlier “11 full passes” figure and cursor `113098027` describe the same scan. The first run covered 5,000 blocks, `112864028` through `112869027`. Each later pass covers 20,000 blocks. Eleven completed passes end at `113089027`. The cursor `113098027` was 9,000 blocks into the twelfth pass, which had not finished, so it was not one of the eleven. `5000 + 11×20000 + 9000 = 234000`, and `112864028 + 234000 - 1 = 113098027`.

At 17:35 UTC the saved cursor was block `113142527`, with `last_error` null and backfill `112864028`. The tip was `114816183`, so 1,673,656 blocks remained. `nft_transfer_logs` had 47 rows. That read is a point in time. The scan was still moving.

`executeSession` is now refused in authorization, preflight, sponsorship, and the relayer gate, including when the supplied transfer list is empty. An observed transfer still queues `invalidateSession`. The V1.1 contract is unchanged, so the on-chain race remains. `/api/transactions` still calls `assertExecutionDisabled`.

`https://rpc.monad.xyz` rejects an `eth_getLogs` span above 101 blocks. The default range is 100. The message “limited to a 100 range” is classified as a splittable limit. `supabase/migrations/20261019160000_watcher_save_timeout.sql` records the 120-second function timeout and the dedupe index. Those statements were already pasted by hand. This file was not applied by the agent.

## What each layer is allowed to do

| Layer | Safe today | Not safe to turn on |
| --- | --- | --- |
| Citizen identity | Enrollment is permanent. A transfer may change `observed_owner` only. | Suspending or deleting a citizen because the NFT left ChogTreasury. |
| Transfer index | The range watcher can read `eth_getLogs` and checkpoint, once its SQL exists and an operator runs it off Vercel. | `CHOG_WATCHER_ENABLED` on Vercel, or a scan before the SQL order below. |
| Citizen account | `execute` follows live `ownerOf`. V1 delegation reverts. | `executeSession` after an unseen A→B→A. |
| ChogBank | Gas, deployment, and business capital are separate accounting buckets. The relayer cannot broadcast. | Sponsorship, a signer, or a second machine sharing one reservation without a database lock. |
| Transactions | `POST /api/transactions` returns 403. | Any path that signs or sends. |

## Session race

`CitizenAccount.syncOwner` returns immediately when `ownerOf` equals `lastSeenOwner`. `executeSession` then checks `currentOwner() == ownerAtOpen`. Both succeed after A→B→A if nobody called the account while the other holder had the NFT. Foundry test `testRoundTripWithoutSyncStillNeedsInvalidation` records that: the session call succeeds, and only a later `invalidateSession` kills it.

Chog Genesis is an ordinary ERC-721. It has no transfer callback and no ownership nonce. The account cannot read historical `Transfer` logs. A caught-up watcher can queue `invalidateSession`, but that transaction is not atomic with `executeSession`. The same block can order the round trip before the invalidation, or the execution can land before the watcher has seen the logs. Zero lag does not close the race.

A new account that stores its own nonce at `openSession` still cannot see a round trip that never called the account. Editing the current bytecode would also move the V1.1 CREATE2 address. Both predicted factories stay empty and must stay unused:

- V1 `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c`
- V1.1 `0xA2edAC990B30A488D61fc4607D4365b22e41e39c`

Owner `execute` is not this bug. It checks the current owner at call time. The unsafe surface is a lingering executor session.

## Where each piece stands

### Implemented and tested locally

- CitizenAccount and factory: 17 Foundry tests passed, including the round-trip session test. `forge test` skipped the three mainnet-fork tests because this run did not start a fork. Direct `eth_getCode` covered the deployment question instead.
- ChogBank policy, reservations, receipt reconciliation, and the disabled relayer. The sponsorship lock is process-local only.
- Transfer watcher, durable snapshot, and the range scanner. A non-canonical unremoved log does not advance the cursor. Removed logs are ignored. Checkpoints resume after a budget stop or a later RPC failure.
- Permanent citizenship. A projected transfer does not change enrollment, home, work, role, or personality.
- `loadGasSigner().canSign` is false. Refused environment names are not copied into a signer.
- `npx vitest run`, `tsc --noEmit`, `npm run lint`, and `npm run build` are the application checks for this branch.

### Merged into `cursor/phase-1-genesis-world-155c`

PRs #26, #27, #28, #29, #30, and #31. The closeout that refuses `executeSession` and records the public RPC limit is a separate pull request. It is not merged by this change.

### Deployed to https://chogos.vercel.app

The merged application is deployed. On 19 October 2026, `POST /api/transactions` returned 403 with "Blockchain transaction execution is disabled." Tokens 104 and 129 are on the map as permanent founding citizens. PR #31 is not deployed. The watcher is a manual process, not a Vercel cron.

### Applied or configured in hosted Supabase

Applied: `repair_permanent_citizenship`, `project_nft_transfer_activities`, `nft_transfer_dedupe`, and `save_nft_watcher_snapshot`.

Applied by hand after the audit above: Phase 6b, Phase 6c, Phase 6d, the citizenship file again, then the 120-second timeouts and `civilization_events_nft_transfer_dedupe`. The watcher is saving checkpoints. The migration file for that timeout was added to git afterwards and was not pasted again.

Citizens: 60 rows. Tokens 104 and 129 are `founding_treasury`, `active`, founding membership true. Token 104 is gathering at Violet Quarry with home House 13 and role stonecutter. Token 129 is resting with home House 09, work Workshop B, and role crafter.

Wallet registry: 60 rows, all `unassigned` / `not_configured` / `none`. No predicted or deployed account address.

### Verified on Monad mainnet

Chain id 143, block 114788937, `https://rpc.monad.xyz`, read-only `eth_getCode`:

| Address | Code |
| --- | --- |
| Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` | 17264 bytes |
| Arachnid CREATE2 `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69 bytes, the public deployer, not a chogOS factory |
| V1 factory `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` | empty |
| V1.1 factory `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` | empty |

No citizen account was created. No transaction was sent.

## Still blocked

These need an explicit decision. This audit did not do them.

1. Do not deploy either factory, and do not open executor sessions, while `executeSession` accepts an unseen A→B→A.
2. Do not add a private key, KMS client, or `CHOG_BANK_RELAYER_ENABLED` path that can sign. `canSign` stays false.
3. Do not enable `CHOG_WATCHER_ENABLED` on Vercel. The scan that is already running stays on a trusted machine. Do not start a second writer against the same cursor.
4. A fresh database needs Phase 6b, Phase 6c, Phase 6d, `20261019140000_permanent_citizenship.sql`, then `20261019160000_watcher_save_timeout.sql`. Hosted Supabase already has those statements. Do not rerun world initialization.
5. A multi-machine reservation lock does not exist. The in-process lock is not a spending control while the relayer is off, and it is not sufficient if a later change broadcasts from more than one process.
6. Business capital, reserved gas, and deployment reserves stay separate in code. No mainnet balance has been designated as the gas payer.

## Safest next action

Leave the running scan alone. It resumes from the saved cursor and does not need another SQL paste.

Leave factory deployment, account creation, session opening, and gas sponsorship unapproved. The server now refuses `executeSession` even when no transfer is in the supplied list. The current contract still cannot see an unseen A→B→A, because Chog Genesis does not tell the account that the round trip happened. Opening `/api/transactions` would not repair that.
