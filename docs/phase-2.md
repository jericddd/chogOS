> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 2 — citizen wallets and the Civilization Treasury

Phase 2 added a wallet registry and a shared treasury record. That phase did not deploy a smart account and did not send a transaction. Citizen wallets were created later from `CitizenAccountFactoryV3`. See [README.md](../README.md).

## What a citizen is

A citizen is one row in `citizens`, unique on chain id, Chog Genesis contract, and token id. The current NFT owner is not that key. A transfer can change who may enroll or refresh the record. The citizen id, history, and wallet assignment stay with the NFT identity. A citizen profile loads that NFT's events directly, so a founding event is still shown when it falls outside the latest 40 events on the world feed.

The app still reads `ownerOf` when it shows a profile. A stored owner snapshot is not treated as current authority.

## Wallet registry

`citizen_wallet_registry` holds at most one assignment per citizen, chain, and scheme. The only scheme is `unassigned`.

Statuses the schema allows:

- `not_configured` — no predicted address and no account address
- `pending` — setup started, no account address
- `address_predicted` — a predicted address only
- `deployment_pending` — a deployment was submitted, and the account is not verified
- `deployed` — account code was observed
- `verified` — code matched an expected implementation and the NFT ownership check passed
- `failed` — the last check failed; a stored address is not replaced

The application writes `not_configured` only. A predicted address is not shown as a deployed account. A browser request cannot set `verified`, `deployed`, or `address_predicted`. There is no route that accepts a wallet status from the client.

Refreshing the founding roster, or using “Record wallet assignments” when `SYNC_SECRET` is unset, inserts missing rows. Running it again updates nothing and does not create a second row. `POST /api/sync/genesis` does the same insert after a successful sync.

No private key, seed phrase, or signer is stored.

## Why no smart account is deployed

Safe proxy factories 1.3.0, 1.4.1, and 1.5.0, the matching singletons, EntryPoint v0.6, EntryPoint v0.7, and the ERC-6551 registry were hash-checked on Monad mainnet on 12 October 2026. EntryPoint v0.8 and v0.9 have code, and that code does not match Ethereum, so they are not treated as canonical. Details are in [docs/contracts.md](docs/contracts.md).

A Safe does not change owners when an NFT moves. Binding today's owner into a Safe would leave the previous owner in control after a transfer. No hash-matched ERC-6551 account implementation was selected, so no citizen address is derived. `walletControlFollowsNftOwner()` is false on purpose.

Phase 2 did not choose an `ownerOf` wallet. The wallet that was later deployed is `CitizenAccountV3`. The NFT holder is not its signer. See [README.md](../README.md).

## Civilization Treasury

This is not the ChogTreasury NFT wallet `0x84113421A8a564b594ee9Ae78c875310332d7023`. That wallet holds founding Chog Genesis NFTs. The Genesis Treasury page still shows that roster.

`civilization_treasuries` starts empty. The page says “Treasury not configured” until an address is stored. A configured address is labeled from what the server observed:

- no code: externally owned account, observed, not a Safe
- `masterCopy()` matches a hash-checked Safe singleton: Safe proxy observed, not a chogOS deployment
- other code: contract observed, not a verified Safe

The server rejects the zero address, the ChogTreasury wallet, the Chog NFT and `$CHOG` contracts, Wrapped MON, and the infrastructure addresses above. A stored treasury address cannot be replaced.

No address is configured by this phase. A database row would not, by itself, mean a wallet was created.

### Balances

MON is read with `getBalance` on the configured chain. `$CHOG` is read with `balanceOf` only when the token bytecode matches the observed proxy. A failed read shows “Unavailable” and, if one exists, the last stored reading marked stale. It does not show zero in place of a failure. A live figure is a reading at a block, not a promise that the amount can be spent.

### Funding

`POST /api/treasury/funding` checks a transaction hash on the server’s chain. Confirmation requires a successful receipt and either native value sent to the configured treasury or an ERC-20 `Transfer` from the configured `$CHOG` contract to that treasury. A missing receipt stays `unverified`. A reverted receipt stays `reverted`. A successful receipt with no matching transfer stays `failed`. The same chain, hash, asset, and token are not inserted twice.

Submitting a hash does not confirm it. The route does not broadcast a transaction. Before a receipt is trusted, the RPC's chain id has to match `MONAD_CHAIN_ID`. Two transfers of the same asset in one transaction are added into one row. An unverified check can be replaced when a later read confirms the receipt. A confirmed row is kept, so the same hash is not counted again. An address with no contract code is not labeled an externally owned account until that is actually known.

## Administrator routes

There is no user-account admin login. Treasury changes use a separate server secret.

- `TREASURY_ADMIN_SECRET` unset: both routes return 403
- set: `Authorization: Bearer <TREASURY_ADMIN_SECRET>` is required

`POST /api/treasury/configure` body: `{ "address": "0x..." }`. Chain id, status, and verification sent by the client are rejected.

`POST /api/treasury/funding` body: `{ "txHash": "0x..." }`. Amount, chain, and confirmation status sent by the client are rejected.

The chain id is always `MONAD_CHAIN_ID` (143 or 10143). A testnet hash is not confirmed on mainnet, because the receipt is read from the configured network.

`POST /api/transactions` still returns 403. Nothing in page rendering or synchronization sends a mainnet transaction.

## Database

The new files are `supabase/migrations/20261012220000_phase2_wallets.sql` and `supabase/migrations/20261012233000_phase2_funding_guards.sql`. They do not drop, truncate, or rewrite citizens. Apply them in the existing Supabase project after the Phase 0 and Phase 1 files, in filename order. Do not paste a file path into the SQL editor; paste the file contents.

Whether that file has been applied is recorded at the bottom of this document and can change. A migration file in git is not proof the hosted database has it.

The app reuses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The service role stays in server code. It is not a `NEXT_PUBLIC_` variable and it is not read by client components.

## Environment

Already used by Phase 1:

- `MONAD_CHAIN_ID`, `MONAD_RPC_URL`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `SYNC_SECRET` optional
- Chog NFT, token, and ChogTreasury addresses, with defaults in code

Added for Phase 2:

- `TREASURY_ADMIN_SECRET` optional. Leave it unset until you are ready to record a real treasury address. It is not a wallet key.

## Local checks

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Open `/`, `/treasury`, `/economy`, `/citizens/7`, and `/activity`. Founding citizens should still be the persisted roster. Wallet lines should say that no account is deployed. The Civilization Treasury should say it is not configured unless you have completed the admin steps below.

## What you still do by hand

1. Apply `supabase/migrations/20261012220000_phase2_wallets.sql` and then `supabase/migrations/20261012233000_phase2_funding_guards.sql` if the migration status below says pending. Paste the contents, not the file path.
2. On the treasury page, use “Record wallet assignments”, or refresh the founding roster. That writes `not_configured` rows. It does not deploy anything.
3. When you have a real wallet you control, set `TREASURY_ADMIN_SECRET` in `.env.local` and restart the server. Then `POST /api/treasury/configure` with that bearer token and the address. Do not use the ChogTreasury NFT wallet.
4. Fund that address yourself from your own wallet. Then `POST /api/treasury/funding` with the transaction hash. The app checks the receipt. It does not send the funds.
5. Before citizen wallets can be created, choose an account implementation that follows the current NFT owner, review its bytecode, and only then add a deployment step. Do not give the AI a signing key.

## Migration status

Checked against the configured Supabase project on 12 October 2026. `citizens` still returns 59 rows. `citizen_wallet_registry` is not in the schema cache, so neither Phase 2 SQL file has been applied there. The service-role key can read tables through the Data API. It cannot run this DDL.

Both Phase 2 files were applied successfully on a local PostgreSQL 16 database after the Phase 0 and Phase 1 migrations. Duplicate wallet rows, the ChogTreasury address, address replacement, a mixed-case duplicate funding hash, and a confirmed row without an amount were all rejected. That local database is not the hosted project.

Paste the contents of both Phase 2 files into the Supabase SQL editor, in filename order. Do not paste the file path, and do not re-run the Phase 0 or Phase 1 files.
