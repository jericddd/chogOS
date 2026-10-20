# Phase 10 — Read-only mainnet activity discovery

Date: 20 October 2026.
Base: `cursor/phase-1-genesis-world-155c` at the Phase 9 merge `80133da`.
Status: the local read-only check below found one historical `$CHOG` transfer and matched it to a successful canonical receipt. That check did not deploy this branch. A unit test, a cached row, or a page that returns HTTP 200 is not that demonstration.

This phase does not apply SQL, change a Vercel variable, deploy, sign, or broadcast. Spending stays off. The NFT watcher stays disabled and its checkpoint is not moved.

## What discovery does

`/economy` and `GET /api/economy/activity` ask the configured Monad RPC for historical `Transfer(address,address,uint256)` logs of the configured `$CHOG` token, then check each displayed log with the existing `verifyMainnetReceipt` function. There is no second receipt verifier.

The token is `addresses.chogToken` in `src/lib/blockchain/addresses.ts`:

`0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`

The event topic is `CHOG_TRANSFER_TOPIC` in `src/lib/economy/decode-transfer.ts`:

`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`

A public request cannot replace that token, topic, or block span. `eth_getLogs` in `jsonRpcCaller` rejects any other contract, any other topic, and any span above 100 blocks. The chain must be Monad mainnet, chain id 143.

## Log versus receipt

| Evidence | Meaning |
| --- | --- |
| Discovered log | A row returned by `eth_getLogs`. It is not displayed as a transfer by itself. |
| Fresh canonical receipt | `verifyMainnetReceipt` just checked chain 143, the transaction hash, receipt status, block number, and canonical block hash. |
| Decoded transfer | The same log index, token, topic, sender, recipient, and raw amount were found in that receipt. |
| Cached verification | The receipt result is reused for 30 seconds in this server process. The row says it is not a fresh verification. |
| Unavailable or inconsistent | The receipt is missing, reverted, malformed, on the wrong chain, or no longer the canonical block. It is counted and not shown as a successful transfer. |

`verified` on a displayed row means the receipt check succeeded and that specific transfer was inside it. A reverted receipt is not a successful transfer. A successful receipt with no matching `$CHOG` log is not displayed as the requested transfer. A block hash that no longer matches the canonical block is inconsistent, which is how a reorg is dropped.

Human-readable amounts use the recorded 18 decimals from 10 October 2026 (`recordedCheck.token.decimals`). The page does not call `decimals()`. The raw integer is kept beside that text. Amounts are not calculated with floating-point numbers.

## Bounds

One request scans at most 400 blocks, in chunks of at most 100. The public Monad endpoint rejects a wider `eth_getLogs` span; a limit response is split down to 10 blocks and then reported, not treated as an empty chain. See [onchain-watcher.md](onchain-watcher.md). This phase does not import the watcher scan and does not save a checkpoint.

The server also caps one request at 24 RPC calls, 3 receipt verifications, and 3 displayed rows. A caller `limit` may only be 1, 2, or 3. There is no deployment-block constant and no claim that one response contains the token's full history.

The continuation cursor is a base64url JSON object bound to version 1, chain 143, and `addresses.chogToken`. It means "resume at this block and log, then walk older." A malformed cursor, a cursor for another token, or a cursor above the current tip is rejected. The tip is read with `eth_blockNumber`. Older pages are linked from the economy page as "Older activity."

`GET /api/economy/activity` accepts only `cursor` and `limit`. Any other parameter, including `token`, `topic`, `fromBlock`, and `toBlock`, is HTTP 400 and does not call the RPC. The route uses the existing in-memory `rateLimit` helper, 8 requests a minute per forwarded client. Responses are `cache-control: no-store`.

An empty list is used only when the budgeted window completed and returned no Transfer logs. The text names that block range and says older blocks were not scanned. A missing RPC, a provider limit, a rate limit, a reverted receipt, or a budget stop names that failure instead of pretending the token has no transfers.

If `CHOG_BANK_ASSET_ADDRESS` is unset, every row is `unattributed`. A configured treasury can be named `treasury_in` or `treasury_out`. Either way `countsInTreasury` is false. The row is not income, expenditure, a proposal, or a settlement.

## Why this is not accounting

Discovery does not call `economy_note_receipt`, `economy_append_journal`, or `economy_settle_proposal`. It does not open the economy database client, the verifier role, or an execution path. It does not insert proposals, reservations, journal rows, or watcher checkpoints. Phase 9 receipt checks of hashes already stored on the ledger are unchanged.

A durable index of every historical transfer would need a new table, a production migration, and a background worker. That is a separate operator decision. This phase does not add one.

## RPC

`MONAD_RPC_URL` must be an `https` URL for the server. An unset or non-https URL fails closed with "Monad mainnet RPC is not configured." The browser bundle does not receive the URL. Errors pass through `publicRpcError`, which strips `http` URLs and credential-like fragments.

The read methods are `eth_chainId`, `eth_blockNumber`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, and `eth_getLogs`. Anything else, including a send method, is rejected before a request is made.

Receipt checks still time out at 4 seconds. Log reads use an 8 second fetch timeout on the page path. The 30 second cache is process memory only. A cached success can be stale after a reorg until it expires; the row is labeled cached so it is not presented as a new canonical check.

## Local tests

```bash
npx vitest run src/lib/economy/phase10-discovery.test.ts src/components/economy/discovered-activity.test.tsx
npm test
npx tsc --noEmit
npm run lint
npm run build
```

The scripted tests do not prove that a live Monad log exists.

## Optional live read

```bash
npx tsx scripts/discover-chog-activity.ts
```

The script reads at most eight windows of 100 blocks, verifies at most one receipt per window, and stops when one fresh match is found. It prints the block range, the log count, and the matched transaction. It does not print the RPC URL. Exit 0 means a fresh canonical match. Exit 2 means the bounded read finished without one. Exit 1 means the read threw.

If `MONAD_RPC_URL` is unset, the script uses the recorded public endpoint `https://rpc.monad.xyz` from `src/lib/blockchain/recorded-check.ts`. That endpoint may reject a historical range or rate-limit the process. The printed `detail` is the result. Do not invent a transaction to fill the gap.

### Read recorded on 20 October 2026

The development environment's `MONAD_RPC_URL` was the recorded public mainnet endpoint. The script scanned backward from tip `115139274`.

| Blocks | Logs returned | Result |
| --- | --- | --- |
| 115139175–115139274 | 0 | Empty window. Older blocks were not scanned. |
| 115139075–115139174 | 0 | Empty window. |
| 115138975–115139074 | 0 | Empty window. |
| 115138875–115138974 | 1 | One fresh canonical match. |

The match was transaction `0xea00ca7b29a7931e64a618014894b5eca97fb5f4172e57f2554d5e61531f35c5`, block `115138908`, block hash `0x702162957304afcb83bb82d20cf5b96396c28a59910b75638a2a1db4ca5c1d47`, log index `41`, raw amount `2809642411265201626`. A separate receipt read confirmed chain 143, receipt status success, the same block hash on the canonical block, the configured token, the Transfer topic, and that raw amount. The row was fresh, not cached. It was not written to the ledger.

## What this phase does not do

- It does not scan the entire chain.
- It does not re-read `decimals()` or token source.
- It does not turn a discovered transfer into a journal line or a treasury total.
- It does not enable the watcher, the relayer, a signer, or `POST /api/transactions`.
- It does not change production SQL, Vercel, or Supabase.

## Before a deploy

No new SQL is required. Do not set `CHOG_BANK_ASSET_ADDRESS`, enable `CHOG_WATCHER_ENABLED`, or rotate a key as part of this phase. A deployed page can discover activity only when production `MONAD_RPC_URL` is an https Monad mainnet endpoint. Confirm that variable is already present before expecting live rows. Do not print its value.
