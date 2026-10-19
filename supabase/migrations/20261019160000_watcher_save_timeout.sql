-- Watcher save timeout and transfer-activity index.
-- Additive. Does not insert citizens, reset the world, or move nft_transfer_cursors.
-- Not applied to hosted Supabase by deploying this file.
-- The same statements were pasted by hand on 19 October 2026 after
-- save_nft_watcher_snapshot hit statement timeout 57014. Pasting this file
-- again is safe: the index is created only when missing, and the function
-- setting is idempotent.

alter function public.project_nft_transfer_activities(text) set statement_timeout = '120s';
alter function public.save_nft_watcher_snapshot(jsonb) set statement_timeout = '120s';

create index if not exists civilization_events_nft_transfer_dedupe
  on public.civilization_events (dedupe_key)
  where kind = 'nft.transferred' and chain_id = 143;
