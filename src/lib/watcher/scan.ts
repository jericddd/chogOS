import { getAddress } from "viem";
import { tokenKey } from "@/lib/watcher/identity";
import type { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import type { LogSource, RawTransfer } from "@/lib/watcher/types";

export type ScanReport =
  | { ok: true; fromBlock: bigint; toBlock: bigint; logs: number; invalidations: number }
  | { ok: false; reason: string };

/**
 * Durable Transfer scan. Callers must keep this outside world_tick().
 * A queued invalidation is not an onchain invalidateSession.
 * This does not remove the race between a transfer and a transaction already in flight.
 */
export async function scanTransfers(store: MemoryWatcherStore, source: LogSource, now: string): Promise<ScanReport> {
  const latest = await source.latest();
  if ("error" in latest) {
    store.setError(latest.error);
    return { ok: false, reason: latest.error };
  }

  const rewound = await rewind(store, source);
  if (!rewound.ok) {
    return rewound;
  }

  const cursor = store.getCursor();
  if (cursor.lastScannedBlock === null && cursor.backfillFrom === null) {
    const reason = "backfill start is not configured";
    store.setError(reason);
    return { ok: false, reason };
  }

  const start = cursor.lastScannedBlock === null ? cursor.backfillFrom! : cursor.lastScannedBlock + 1n;
  if (start > latest.number) {
    if (cursor.lastScannedBlock === null) {
      const reason = "backfill start is ahead of the chain tip";
      store.setError(reason);
      return { ok: false, reason };
    }
    store.commitBlock(latest, now);
    return { ok: true, fromBlock: start, toBlock: latest.number, logs: 0, invalidations: 0 };
  }

  let logs = 0;
  let invalidations = 0;
  for (let block = start; block <= latest.number; block++) {
    const header = await source.header(block);
    if ("error" in header) {
      store.setError(header.error);
      return { ok: false, reason: header.error };
    }
    const page = await source.transfers(block, block);
    if ("error" in page) {
      store.setError(page.error);
      return { ok: false, reason: page.error };
    }
    const ordered = [...page].sort((a, b) => a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    for (const log of ordered) {
      const applied = applyLog(store, header.hash, log);
      logs += applied.saved ? 1 : 0;
      invalidations += applied.invalidations;
    }
    store.commitBlock(header, now);
  }

  return { ok: true, fromBlock: start, toBlock: latest.number, logs, invalidations };
}

function applyLog(
  store: MemoryWatcherStore,
  headerHash: RawTransfer["blockHash"],
  log: RawTransfer,
): { saved: boolean; invalidations: number } {
  if (log.removed) {
    return { saved: false, invalidations: 0 };
  }
  if (log.blockHash.toLowerCase() !== headerHash.toLowerCase()) {
    return { saved: false, invalidations: 0 };
  }
  if (!sameContract(log.address, store.getCursor().nftContract)) {
    return { saved: false, invalidations: 0 };
  }
  const saved = store.saveLog(log);
  if (!saved.created) {
    return { saved: false, invalidations: 0 };
  }
  let invalidations = 0;
  for (const session of store.sessionsFor(tokenKey(log.tokenId))) {
    if (log.blockNumber <= session.openedBlock) {
      continue;
    }
    const before = store.invalidations.length;
    store.queueInvalidation({
      requestId: session.requestId,
      transferId: saved.row.id,
      reason: "nft transferred after the session opened",
    });
    if (store.invalidations.length > before) {
      invalidations += 1;
    }
  }
  return { saved: true, invalidations };
}

async function rewind(store: MemoryWatcherStore, source: LogSource): Promise<ScanReport | { ok: true }> {
  let block = store.getCursor().lastScannedBlock;
  while (block !== null) {
    const header = await source.header(block);
    if ("error" in header) {
      store.setError(header.error);
      return { ok: false, reason: header.error };
    }
    const stored = store.blockHash(block);
    if (stored && stored.toLowerCase() === header.hash.toLowerCase()) {
      return { ok: true };
    }
    if (!stored) {
      return { ok: true };
    }
    store.forgetBlock(block);
    block = store.getCursor().lastScannedBlock;
  }
  return { ok: true };
}

function sameContract(left: string, right: string): boolean {
  return getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
}
