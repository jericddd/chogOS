# Phase 1 — Genesis roster and world

chogOS has one civilization. A Chog Genesis NFT is one citizen. Founding citizens are the NFTs held by the existing ChogTreasury wallet. Community citizens are enrolled by wallets that currently own other tokens from the same collection. Phase 1 does not deploy contracts, move NFTs, or spend `$CHOG`.

## Discovery

The server reads the official collection on the configured Monad chain:

1. `tokensOfOwner(ChogTreasury)` from the verified contract ABI.
2. `ownerOf` for every returned id, through Multicall3 when the node accepts it.
3. `balanceOf` as a comparison, not as the list of ids.

The contract is not treated as ERC-721 Enumerable. The server does not scan the chain and does not invent ids when a call fails. `EXPECTED_FOUNDING_COUNT` (default 59) is only a label for a discrepancy. Run the live check with:

```bash
npm run discover:treasury
```

An optional indexer is a second candidate list. Set `NFT_INDEXER=alchemy` and `NFT_INDEXER_API_KEY` for Alchemy's Monad mainnet NFT API (`getNFTsForOwner`). Set `NFT_INDEXER=custom` and `NFT_INDEXER_URL` to an https endpoint that accepts `owner` and `contract` query parameters and returns `{ "tokenIds": ["1"] }`. A custom API key, when set, is sent as `Authorization: Bearer`. Indexer credentials stay in server environment variables. Ids that fail `ownerOf` are stale and are not stored. If `tokensOfOwner` already succeeded, an indexer failure does not erase those ids.

Metadata is read from `tokenURI` and fetched only when the URI is `ipfs://` rewritten onto `IPFS_GATEWAY` (default `https://gateway.pinata.cloud/ipfs`). The portrait falls back to local artwork when metadata or the image is missing.

## Persistence

Create a Supabase project and run, in order:

1. `supabase/migrations/20261010180000_initial_schema.sql`
2. `supabase/migrations/20261010200000_phase1_genesis.sql`

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server. The URL must be https. `http://127.0.0.1` and `http://localhost` are also accepted so a local PostgREST can stand in for Supabase. Do not put the service role key in client code. Row level security stays on, with no anon policies.

Without those variables the world still shows a live treasury read and labels it as not persisted. The activity feed stays empty. Refresh on `/treasury` writes the roster when the database is configured. A second refresh at the same block does not duplicate citizens or events. If `ownerOf` cannot recheck a token that disappeared from `tokensOfOwner`, the founding row is marked stale and is not deactivated.

Set `SYNC_SECRET` to require `POST /api/sync/genesis` with `Authorization: Bearer <secret>`. Leave it unset to use the button on the treasury page. Synchronization is locked to one running row and waits 15 seconds between successes.

## Enrollment

`/enroll` connects an injected EVM wallet, checks the chain, and discovers owned Chog Genesis NFTs with `tokensOfOwner` or with token ids typed by the holder. The server rechecks `ownerOf` before issuing a signed challenge and again before writing a row. A treasury-held NFT is rejected. One wallet can enroll several NFTs. The database unique key is `(chain_id, nft_contract, token_id)`.

If a founding NFT leaves the treasury, synchronization keeps the citizen, updates the observed owner, marks founding membership inactive, and suspends enrollment until the current owner signs a claim. The previous owner cannot pass that signature check.

## World

`/` is the civilization scene. Citizens, the Genesis Treasury, and history are linked from the scene and the status panel. Counts come from the latest chain read and from stored rows. The AI provider is not called. `AI_PROVIDER=ajax` still refuses, because no Ajax URL or request format is assumed.

## Not in this phase

Citizen smart wallets, a shared economic treasury, `$CHOG` transfers, and autonomous AI actions are later work. The ChogTreasury address is the existing NFT holder, not a contract this app deploys.
