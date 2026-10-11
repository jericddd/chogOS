# Database plan

The migration is `supabase/migrations/20261010180000_initial_schema.sql`. Apply it when a Supabase project exists. The dashboard does not query it in Phase 0.

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

`civilization_state` allows one row, enforced by a boolean primary key that must be true. The seed row says the civilization is in `foundation`: no enrolled citizens and no treasury wallet.

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

## Access

Row level security is enabled on every application table. No policies are defined. When the Supabase `anon` and `authenticated` roles exist, their table grants are revoked. The service role bypasses row level security, so it stays in server code.

Phase 1 adds policies with the enrollment signature checks. It should not disable row level security to make the dashboard easier to build.

## Not stored

Browser sessions, private keys, session-key material, and live prices are outside this migration. Session keys, when they exist, belong to the wallet contract. The database may store a public description of a permission, not the key that can exercise it.
