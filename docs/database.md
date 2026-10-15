# Database plan

Apply the files in `supabase/migrations/` in filename order when a Supabase project exists. The world reads citizens only through the server service role.

## Rule for value

Monad is the record of assets. The database records identity, history, intent, and evidence.

- `balance_observations.amount_raw` is a raw integer observed at `block_number` from an RPC. It can be stale the moment it is written. Spendable balances are read from the chain again.
- `business_ledger_entries.is_onchain_verified` can be true only when `receipt_id` is set.
- `transaction_receipts.raw_receipt` is inserted from a node receipt, not from an AI summary.
- There is no citizen wealth column. Wealth is derived, when needed, from fresh chain reads plus unverified claims that stay labeled.
- There is no maximum number of businesses, ledger rows, or asset rows.

Chain ids are constrained to Monad mainnet `143` and Monad testnet `10143`.

## Citizens and enrollment

`citizens` is one row per `(chain_id, nft_contract, token_id)`. `token_id` is `numeric(78, 0)` so it is not limited to a JavaScript integer.

`observed_owner`, `ownership_observed_block`, and `ownership_observed_at` store the last `ownerOf` observation. They do not prove the row is still current and they are not signing keys.

`enrollment_status` is `pending`, `active`, `suspended`, or `withdrawn`. Phase 1 should leave a row pending until the observed owner signs.

`citizen_profiles.life_status` is application state: `unknown`, `active`, `away`, or `inactive`. It is not an on-chain enum.

`citizen_skills.level` runs from 1 to 100 as a proficiency scale. That scale is not a cap on wealth or on how many businesses a citizen can form.

`citizen_jobs` optionally points at a business. `citizen_relationships` stores a directed note, and a unique index treats the pair as unordered for a given `kind` so the same relationship is not inserted twice.

## Civilization state and history

`civilization_state` allows one row, enforced by a boolean primary key that must be true. The Phase 1 migration names that row chogOS. The economic treasury wallet is still unset.

`treasury_wallet_id` points at a `wallets` row of kind `treasury` once one exists. The table does not store a treasury balance.

`civilization_events` is the shared history. `chain_status` is `offchain`, `submitted`, or `confirmed`. An off-chain sentence can exist without a transaction. `confirmed` is reserved for an event that has a matching receipt. The column does not itself check that match; application code writes `confirmed` only in the same change that inserts the receipt.

## AI memory and decisions

`ai_memories` is scoped to the civilization, one citizen, or one business. A check constraint requires the matching foreign key and forbids the others. Memory text must not contain API keys or seed phrases.

`ai_decisions` stores a purpose, a status (`draft`, `proposed`, `rejected`, `accepted`, `failed`), an optional rationale, and the provider and model names. An accepted decision is still not a signature.

`proposals` are the concrete actions prepared from a decision against a wallet. Status moves from `draft` through approval and submission. Phase 0 creates no proposals.

## Businesses and financial records

`businesses` has a name, a status, an optional founder, and a summary. Nothing in the schema counts them toward a maximum.

`business_ledger_entries` holds an optional raw amount and a link to a receipt. Unverified entries are allowed so the civilization can draft a plan. They cannot be flagged verified without the receipt.

`supported_assets` is a catalog, not a portfolio. The seed lists mainnet MON, the observed $CHOG proxy, and the source-verified Chog Genesis NFT. Notes in the seed repeat the evidence limits from [contracts.md](contracts.md).

## Wallets and receipts

`wallets` stores an address after a smart wallet exists. Kinds are `citizen`, `business`, and `treasury`.

- A citizen wallet requires a citizen and no business.
- A business wallet requires a business and no citizen.
- The treasury wallet has neither.
- One treasury wallet is allowed per chain.
- One citizen wallet is allowed per citizen per chain.
- `(chain_id, address)` is unique.

`deployment_tx_hash` records the creation transaction once it exists. A wallet row still does not imply a balance.

`transaction_receipts` is unique on `(chain_id, tx_hash)` and stores the raw receipt JSON, status, and block number.

`balance_observations` points at a wallet and an asset key. `source` can only be `rpc`.

## Genesis roster

`20261010200000_phase1_genesis.sql` adds founding membership, metadata snapshots, `genesis_roster`, `ownership_snapshots`, `enrollment_challenges`, and `sync_runs`. `civilization_events.dedupe_key` makes a repeated sync at the same block idempotent. The migration does not insert token ids.

`citizens.origin` is `founding_treasury` or `community`. `founding_membership_active` is true only while a verified `ownerOf` read says the ChogTreasury wallet holds that NFT. A stored owner is still a snapshot.

## Access

Row level security is enabled on every application table, including the Phase 1 tables. No policies are defined. When the Supabase `anon` and `authenticated` roles exist, their table grants are revoked. The service role bypasses row level security, so it stays in server code. Enrollment does not open those tables to the browser. The server checks the signature and `ownerOf`, then writes with the service role.

## Phase 2 wallets and treasury

`20261012220000_phase2_wallets.sql` is additive. It does not insert citizens, token ids, or a treasury address.

- `citizen_wallet_registry` is one row per `(citizen_id, chain_id, scheme)`. The only scheme is `unassigned`. `not_configured` requires both addresses to be null. `deployed` and `verified` require `account_address`. A trigger refuses to replace a stored predicted or account address.
- `civilization_treasuries` is one row per chain. `not_configured` has a null address. The ChogTreasury NFT wallet is rejected by a check constraint. A trigger refuses to replace a stored address.
- `treasury_funding` is unique on chain, transaction hash, asset kind, and token address. `confirmed` requires an amount, a recipient, and a block number.
- `treasury_balance_readings` stores RPC readings only. `source` must be `rpc`, and `amount_raw` cannot be null, so a failed read is not inserted as zero.

Row level security is enabled on these tables. `anon` and `authenticated` are revoked when those roles exist. `service_role` is granted when that role exists. The existing `wallets` table is unchanged and is still reserved for addresses that already exist. Predicted or missing wallets do not go there.

Apply this file after the Phase 1 migration, then apply `20261012233000_phase2_funding_guards.sql`. That follow-up makes funding hashes and wallet addresses unique without regard to letter case. Paste file contents into the Supabase SQL editor. A file in the repository is not the same as a migration that has been applied. See [docs/phase-2.md](docs/phase-2.md) for the current applied state.

## Phase 3 world

`20261013040000_phase3_world.sql` is additive. It creates no citizens and deletes nothing. Existing history rows stay and are labeled `source = system`, `category = membership`.

- `world_buildings` and `world_routes` store the versioned layout (`genesis-v1.1`, expanded from `genesis-v1`). Each building has a footprint, a door, capacity, job slots, construction progress, production progress, and, for the Storehouse, simulated stock clamped to 0 to 400. Founding building tiles are not moved by an expand.
- `world_state` allows one row. It holds the clock anchor (`anchor_real`, `anchor_world_s`, `speed`), the status (`running` or `paused`), the tick sequence, the last tick time, the maximum catch-up of 150 seconds, `grid_w` / `grid_h`, and the last error.
- `world_regions` names land for later districts (`settlement`, `wilds`, `reserve`, `resource`). Region rows are not buildings and have no jobs.
- `citizen_world_state` is one row per placed citizen, keyed by `citizen_id`. It stores home, job, role, current activity, location, origin and destination, purpose, and both `ends_at` (real time) and `world_ends_s` (world time). `decision_source` records whether the rules or an intent chose the activity.
- `world_intents` is the Phase 4 entry point. A unique partial index allows one pending intent per citizen.
- `civilization_events` gains `seq` (feed order), `source` (`simulation`, `ai`, `onchain`, `system`), `category`, `building_id`, `related_citizen_id`, `world_s`, `tick_seq`, and `schema_version`, plus indexes for each feed filter.

Row level security is enabled on the new tables. `anon` and `authenticated` have no grants on them or on the `world_*` functions. `service_role` may select world tables and insert `world_intents`, but cannot update or delete world rows. All world writes go through `security definer` functions. `world_tick()` takes an advisory lock, and each event's unique `dedupe_key` stops a repeated step from writing twice. When `pg_cron` is available, the migration schedules the tick. After a tick that changed something, `realtime.send` broadcasts a tick number on the public channel `chogos-world`, with no row data.

## Phase 3.75 verification

`20261014120000_phase375_verify.sql` is additive. It does not delete events, move buildings, or reset citizens.

- `civilization_events` gains `state_transition`, `intent_id`, `decision_id`, `integrity_schema`, `integrity_class`, `event_hash`, `prev_event_hash`, `merkle_batch_id`. History bodies are append-only via triggers. Hashes are write-once.
- `event_integrity_batches` stores Merkle roots, tree format, seq range, optional snapshot time, and optional anchor metadata. Confirmed anchors still do not prove the simulation was true.
- `event_integrity_proofs` stores inclusion proofs at batch time.
- `verification_state` is one row for cutover metadata.
- `ai_decisions` gains provenance columns for Phase 4. No AI rows are inserted here.

`anon` and `authenticated` have no grants on the new tables or on `verify_*` writer functions. `service_role` may select and may execute `verify_cutover`, `verify_hash_historical`, `verify_commit_batch`, `verify_record_correction`, and `verify_record_anchor`. Hosted Postgres keeps `pgcrypto` in `extensions`; `20261014133000_phase375_pgcrypto_path.sql` sets that search_path. Paste both files. See [docs/phase-3.75.md](phase-3.75.md).

## Phase 4 mind

`20261014180000_phase4_ai_mind.sql` is additive. It does not insert founding citizens, reset the clock, or rerun event cutover.

- `citizen_personalities` is one deterministic trait row per citizen.
- `citizen_goals` holds a bounded lifecycle (`proposed` through `superseded`).
- `citizen_skills.experience` and `citizen_skill_awards` make skill grants idempotent.
- `ai_memories` gains category, source event, outcome, and uniqueness guards.
- `ai_decisions` status includes `queued`, `executed`, `expired`, and `superseded`.
- `world_plots` lists genesis-v1.1 lots. `world_place_building` is the only insert path for a new house, farm, or workshop.
- `ai_usage_counters`, `ai_scheduler_state`, and `ai_citizen_claims` cap and serialize inference.

The hosted project does not apply a file merely because it is in git. Paste this migration when activating the mind. See [phase-4.md](phase-4.md).

## Phase 5a civil works

`20261015200000_phase5a_civil_works.sql` is additive. It does not reset the clock, rewrite events, or unlock reserved y=2 lots.

- Eleven extra road-served lots on existing east y=11 and south y=57 roads.
- `world_place_building` accepts `house`, `farm`, and `workshop`.
- Completing a farm or workshop converts builders at that site to farmer/crafter jobs and reuses the existing batch production rules.

Paste it on the hosted project after review. See [phase-5.md](phase-5.md).

## Not stored

Browser sessions, private keys, session-key material, and live prices are outside this migration. Session keys, when they exist, belong to the wallet contract. The database may store a public description of a permission, not the key that can exercise it.
