# Onchain transfer watcher

The watcher reads Chog Genesis `Transfer` logs on Monad mainnet and projects them into Activities → Onchain. It does not sign, broadcast, or change citizenship. An NFT transfer updates the stored owner only. Enrollment, home, work, role, and personality stay where they are.

Leave `CHOG_WATCHER_ENABLED` unset until this procedure has been reviewed. The process does not start on boot, and it is not part of `world_tick`.

## How a run works

- The contract is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` on chain 143. Any other contract or chain exits before a read.
- An empty cursor starts at `CHOG_WATCHER_BACKFILL_FROM`. Unset does not mean block 0.
- Each `eth_getLogs` call covers `CHOG_WATCHER_RANGE_BLOCKS` blocks (default 100). `https://rpc.monad.xyz` rejects a span above 101 blocks with “eth_getLogs is limited to a 100 range”. That message is a range limit, so a larger setting is split and reread instead of moving the cursor. Keep 100 on that endpoint so the first request succeeds.
- The cursor, block hash, and logs are saved after every range that commits. A timeout or a failed later range resumes from that block.
- One process stops after `CHOG_WATCHER_MAX_BLOCKS_PER_RUN` blocks (default 5000) and exits 0 with `caughtUp: false`. Run it again to continue.
- A response that reports a size or block-range limit is split in half and reread. A page that reaches `CHOG_WATCHER_MAX_LOGS_PER_RANGE` is treated the same way. A single block that still meets the cap does not advance the cursor.
- A rate limit, timeout, or temporary connection error is retried `CHOG_WATCHER_RPC_ATTEMPTS` times, waiting `CHOG_WATCHER_RPC_RETRY_MS` and then doubling. A pause of `CHOG_WATCHER_RPC_PAUSE_MS` sits between committed ranges.
- The same chain, transaction hash, and log index cannot create a second activity. Log identity also includes the block hash, so a replay of the same log is ignored.
- The next run checks the checkpoint block hash. A mismatch drops that block and every log above the previous checkpoint, then reads the canonical range again. An orphaned activity is hidden. It is not shown as confirmed.
- An unremoved log whose block hash disagrees with the header just read does not advance the cursor. The range is retried instead of skipping that transfer. A log marked removed is ignored.
- No private key is read. `/api/transactions` stays closed.

Exit 0 with `caughtUp: false` means the checkpoint advanced and more blocks remain. Exit 1 means the cursor stayed at the last successful range and `lastError` says why. `lagBlocks` is large during a backfill. That keeps sponsorship off. It does not remove citizens.

## Database order

Hosted Supabase does not apply files from git. Paste each file's contents into the SQL editor, in this order, and only the files that are missing. Stop on a red error.

1. `supabase/migrations/20261017220000_phase6b_chogbank.sql` creates `chogbank_activation_requests`. The Phase 6c file references that table.
2. `supabase/migrations/20261019120000_phase6c_transfer_watcher.sql`
3. `supabase/migrations/20261019130000_phase6d_watcher_durable.sql`
4. `supabase/migrations/20261019140000_permanent_citizenship.sql`. It replaces `save_nft_watcher_snapshot` so a saved range also projects Onchain activities. Running it again restores nothing new.
5. `supabase/migrations/20261019160000_watcher_save_timeout.sql` last. It raises the two watcher function timeouts to 120 seconds and adds the transfer dedupe index. Hosted Supabase already received these statements by hand on 19 October 2026. Pasting the file again is safe. It does not move the watcher cursor.

Check:

```sql
select to_regclass('public.nft_transfer_logs') as logs,
       to_regprocedure('public.project_nft_transfer_activities(text)') as project,
       to_regprocedure('public.save_nft_watcher_snapshot(jsonb)') as save;
```

All three must be present before a scan.

## Activation

Do this from a trusted machine. Do not put the service role key in the browser, git, or the SQL editor. Do not set these variables on Vercel, and do not add a Vercel cron.

```bash
export CHOG_WATCHER_ENABLED=true
export MONAD_CHAIN_ID=143
export MONAD_RPC_URL=https://your-monad-mainnet-endpoint
export SUPABASE_URL=https://pjsedyqourngnjjdcenl.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=the-server-key
export CHOG_WATCHER_BACKFILL_FROM=112864028
npm run watcher:run
```

`112864028` is the earlier ownerOf observation for tokens 104 and 129. The transfer itself is in a later block, before `114679059`. The watcher does not invent that transaction. Keep the default range and budget for the first run. At 5000 blocks per run, the distance from `112864028` to today's tip is a few hundred runs.

The JSON line should show `ok: true`, a `toBlock` ahead of the backfill, and `caughtUp: false`. Then confirm citizenship did not move:

```sql
select token_id, enrollment_status, founding_membership_active, observed_owner
from citizens
where chain_id = 143 and token_id in (104, 129);
```

Both rows stay `active` with founding membership true. Home, work, and role stay as they were. Only `observed_owner` may change, and only after a real log for that token has been saved.

Repeat `npm run watcher:run` until `caughtUp` is true and `lastError` is null. A shell loop is optional:

```bash
export CHOG_WATCHER_LOOP=true
export CHOG_WATCHER_SECONDS=60
npm run watcher:run
```

Raise `CHOG_WATCHER_MAX_BLOCKS_PER_RUN` only after a run finishes inside the RPC provider's limits. The maximum accepted value is 50000.

## What you should see

Activities → Onchain on https://chogos.vercel.app lists one row per confirmed Chog Genesis transfer. The transaction hash links to Monadscan when the stored log is a complete canonical mainnet record: chain 143, the official Chog Genesis contract, and a valid transaction, block, block hash, log index, sender, receiver, and token id. A confirmed chain status alone does not create that link. A second run does not duplicate the row. A reorg hides the orphaned row instead of leaving it confirmed.

Tokens 104 and 129 remain founding citizens. The treasury roster still calls them permanent citizens when the NFT is outside ChogTreasury.

## Leave these off

- `CHOG_WATCHER_ENABLED` on Vercel
- Any `CHOG_BANK_*` private key
- `CHOG_BANK_RELAYER_ENABLED`
- Contract deployment, broadcast, and `/api/transactions`
- `world:init`, `verify:cutover`, and another paste of the older world migrations
