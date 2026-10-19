# Phase 6 completion status

Date: 19 October 2026. Read-only checks against Monad mainnet block 114788937 and the hosted Supabase project. Nothing in this audit was deployed, broadcast, funded, or enabled.

Phase 6 is not operational. Account execution stays closed. The blocker is the Chog Genesis transfer race, not a missing build.

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

PRs #26, #27, #28, #29, and #30. PR #31 is a draft and is not merged.

### Deployed to https://chogos.vercel.app

The merged application is deployed. On 19 October 2026, `POST /api/transactions` returned 403 with "Blockchain transaction execution is disabled." Tokens 104 and 129 are on the map as permanent founding citizens. PR #31 is not deployed. The watcher is a manual process, not a Vercel cron.

### Applied or configured in hosted Supabase

Applied: `repair_permanent_citizenship`, `project_nft_transfer_activities`, `nft_transfer_dedupe`, and `save_nft_watcher_snapshot`.

Not applied: `nft_transfer_logs`, `nft_transfer_cursors`, `chogbank_activation_requests`, `nft_watched_sessions`, and `load_nft_watcher_snapshot`. Calling `project_nft_transfer_activities` fails because `nft_transfer_logs` does not exist. `save_nft_watcher_snapshot` is present from the citizenship file, but it cannot persist a scan until the watcher tables exist and that file is applied again last.

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
3. Do not enable `CHOG_WATCHER_ENABLED` on Vercel. A scan belongs on a trusted machine after PR #31 is reviewed.
4. Before any scan, paste the missing SQL in order: Phase 6b, Phase 6c, Phase 6d, then `20261019140000_permanent_citizenship.sql` again so `save_nft_watcher_snapshot` still projects activities. Stop on a red error. Do not rerun world initialization.
5. A multi-machine reservation lock does not exist. The in-process lock is not a spending control while the relayer is off, and it is not sufficient if a later change broadcasts from more than one process.
6. Business capital, reserved gas, and deployment reserves stay separate in code. No mainnet balance has been designated as the gas payer.

## Safest next action

Review PR #31. If the only goal is the Onchain activity tab, apply the watcher SQL in the order above and run `npm run watcher:run` from a trusted machine with `CHOG_WATCHER_BACKFILL_FROM=112864028`. That indexes real logs. It does not sponsor transactions.

Leave factory deployment, account creation, session opening, and gas sponsorship unapproved until there is a session design that dies when the NFT leaves and returns without an intervening account call. The current contract cannot express that, because Chog Genesis does not tell the account that the round trip happened.
