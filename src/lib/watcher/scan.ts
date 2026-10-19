import { getAddress } from "viem";
import { readWithRetry } from "@/lib/watcher/range";
import { tokenKey } from "@/lib/watcher/identity";
import type { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import type { BlockHeader, LogSource, RawTransfer } from "@/lib/watcher/types";

export type ScanReport =
  | {
      ok: true;
      fromBlock: bigint;
      toBlock: bigint;
      tipBlock: bigint;
      logs: number;
      invalidations: number;
      caughtUp: boolean;
      ranges: number;
    }
  | { ok: false; reason: string };

export type ScanLimits = {
  /** Inclusive eth_getLogs span. A limit response splits this in half. */
  rangeBlocks: bigint;
  /** Stop after this many blocks so a run can checkpoint and exit before the tip. */
  maxBlocks: bigint;
  /** A full page at this size is treated as truncated and split. One block at the cap does not advance. */
  maxLogsPerRange: number;
  maxAttempts: number;
  /** Base backoff for a transient RPC error. Zero skips the wait. */
  retryMs: number;
  /** Pause after a committed range when more blocks remain in this run. */
  pauseMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each committed range, including a split leaf. A throw stops the run. */
  onCheckpoint?: () => Promise<void>;
};

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  rangeBlocks: 1000n,
  maxBlocks: 5000n,
  maxLogsPerRange: 2000,
  maxAttempts: 4,
  retryMs: 0,
  pauseMs: 0,
};

export function resolveScanLimits(partial?: Partial<ScanLimits>): ScanLimits {
  return {
    rangeBlocks: partial?.rangeBlocks ?? DEFAULT_SCAN_LIMITS.rangeBlocks,
    maxBlocks: partial?.maxBlocks ?? DEFAULT_SCAN_LIMITS.maxBlocks,
    maxLogsPerRange: partial?.maxLogsPerRange ?? DEFAULT_SCAN_LIMITS.maxLogsPerRange,
    maxAttempts: partial?.maxAttempts ?? DEFAULT_SCAN_LIMITS.maxAttempts,
    retryMs: partial?.retryMs ?? DEFAULT_SCAN_LIMITS.retryMs,
    pauseMs: partial?.pauseMs ?? DEFAULT_SCAN_LIMITS.pauseMs,
    sleep: partial?.sleep,
    onCheckpoint: partial?.onCheckpoint,
  };
}

/**
 * Durable Transfer scan. One eth_getLogs call covers a block range, then the cursor advances.
 * A crash before the checkpoint save retries that range. Callers must keep this outside world_tick().
 * A queued invalidation is not an onchain invalidateSession.
 */
export async function scanTransfers(
  store: MemoryWatcherStore,
  source: LogSource,
  now: string,
  options?: Partial<ScanLimits>,
): Promise<ScanReport> {
  const limits = resolveScanLimits(options);
  if (!validLimits(limits)) {
    const reason = "watcher scan limits are invalid";
    store.setError(reason);
    return { ok: false, reason };
  }

  const latest = await readWithRetry(limits, () => source.latest(), false);
  if (!latest.ok) {
    store.setError(latest.error);
    return { ok: false, reason: latest.error };
  }

  const rewound = await rewind(store, source, limits);
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
  if (start > latest.value.number) {
    if (cursor.lastScannedBlock === null) {
      const reason = "backfill start is ahead of the chain tip";
      store.setError(reason);
      return { ok: false, reason };
    }
    store.commitBlock(latest.value, now);
    const saved = await checkpoint(store, limits);
    if (!saved.ok) {
      return saved;
    }
    return {
      ok: true,
      fromBlock: start,
      toBlock: latest.value.number,
      tipBlock: latest.value.number,
      logs: 0,
      invalidations: 0,
      caughtUp: true,
      ranges: 0,
    };
  }

  let scanned = 0n;
  let logs = 0;
  let invalidations = 0;
  let ranges = 0;
  let cursorStart = start;
  while (cursorStart <= latest.value.number && scanned < limits.maxBlocks) {
    const end = minBlock(
      latest.value.number,
      cursorStart + limits.rangeBlocks - 1n,
      cursorStart + (limits.maxBlocks - scanned) - 1n,
    );
    const window = await scanWindow(store, source, limits, cursorStart, end, now);
    if (!window.ok) {
      store.setError(window.reason);
      return window;
    }
    logs += window.logs;
    invalidations += window.invalidations;
    ranges += window.ranges;
    scanned += window.toBlock - cursorStart + 1n;
    cursorStart = window.toBlock + 1n;
    if (cursorStart <= latest.value.number && scanned < limits.maxBlocks && limits.pauseMs > 0) {
      await pause(limits, limits.pauseMs);
    }
  }

  const toBlock = store.getCursor().lastScannedBlock;
  if (toBlock === null) {
    const reason = "watcher cursor was not committed";
    store.setError(reason);
    return { ok: false, reason };
  }
  return {
    ok: true,
    fromBlock: start,
    toBlock,
    tipBlock: latest.value.number,
    logs,
    invalidations,
    caughtUp: cursorStart > latest.value.number,
    ranges,
  };
}

type WindowResult =
  | { ok: true; logs: number; invalidations: number; ranges: number; toBlock: bigint }
  | { ok: false; reason: string };

async function scanWindow(
  store: MemoryWatcherStore,
  source: LogSource,
  limits: ScanLimits,
  start: bigint,
  end: bigint,
  now: string,
): Promise<WindowResult> {
  const page = await readWithRetry(limits, () => source.transfers(start, end), true);
  if (!page.ok && page.split) {
    return splitWindow(store, source, limits, start, end, now, page.error);
  }
  if (!page.ok) {
    return { ok: false, reason: page.error };
  }
  if (page.value.length >= limits.maxLogsPerRange) {
    if (start >= end) {
      return {
        ok: false,
        reason: `block ${start} returned ${page.value.length} logs, which meets the log cap; the cursor was not advanced`,
      };
    }
    return splitWindow(store, source, limits, start, end, now, "log page reached the cap");
  }
  return commitWindow(store, source, limits, end, now, page.value.filter((log) => log.blockNumber >= start && log.blockNumber <= end));
}

async function splitWindow(
  store: MemoryWatcherStore,
  source: LogSource,
  limits: ScanLimits,
  start: bigint,
  end: bigint,
  now: string,
  reason: string,
): Promise<WindowResult> {
  if (start >= end) {
    return { ok: false, reason };
  }
  const mid = start + (end - start) / 2n;
  const left = await scanWindow(store, source, limits, start, mid, now);
  if (!left.ok) {
    return left;
  }
  const right = await scanWindow(store, source, limits, mid + 1n, end, now);
  if (!right.ok) {
    return right;
  }
  return {
    ok: true,
    logs: left.logs + right.logs,
    invalidations: left.invalidations + right.invalidations,
    ranges: left.ranges + right.ranges,
    toBlock: right.toBlock,
  };
}

async function commitWindow(
  store: MemoryWatcherStore,
  source: LogSource,
  limits: ScanLimits,
  end: bigint,
  now: string,
  logs: RawTransfer[],
): Promise<WindowResult> {
  const endHeader = await readWithRetry(limits, () => source.header(end), false);
  if (!endHeader.ok) {
    return { ok: false, reason: endHeader.error };
  }
  const headers = new Map<string, BlockHeader>([[end.toString(), endHeader.value]]);
  const ordered = [...logs].sort(
    (a, b) =>
      compareBlock(a.blockNumber, b.blockNumber) || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
  );
  for (const log of ordered) {
    if (log.removed || headers.has(log.blockNumber.toString())) {
      continue;
    }
    const header = await readWithRetry(limits, () => source.header(log.blockNumber), false);
    if (!header.ok) {
      return { ok: false, reason: header.error };
    }
    headers.set(log.blockNumber.toString(), header.value);
  }

  let savedLogs = 0;
  let invalidations = 0;
  for (const log of ordered) {
    const header = headers.get(log.blockNumber.toString());
    if (!header) {
      continue;
    }
    const applied = applyLog(store, header.hash, log);
    savedLogs += applied.saved ? 1 : 0;
    invalidations += applied.invalidations;
    if (applied.saved) {
      store.noteBlock(header);
    }
  }
  store.commitBlock(endHeader.value, now);
  const saved = await checkpoint(store, limits);
  if (!saved.ok) {
    return saved;
  }
  return { ok: true, logs: savedLogs, invalidations, ranges: 1, toBlock: end };
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

async function rewind(
  store: MemoryWatcherStore,
  source: LogSource,
  limits: ScanLimits,
): Promise<ScanReport | { ok: true }> {
  let block = store.getCursor().lastScannedBlock;
  while (block !== null) {
    const reading = block;
    const header = await readWithRetry(limits, () => source.header(reading), false);
    if (!header.ok) {
      store.setError(header.error);
      return { ok: false, reason: header.error };
    }
    const stored = store.blockHash(reading);
    if (!stored || stored.toLowerCase() === header.value.hash.toLowerCase()) {
      return { ok: true };
    }
    store.forgetBlock(reading);
    block = store.getCursor().lastScannedBlock;
  }
  return { ok: true };
}

async function checkpoint(store: MemoryWatcherStore, limits: ScanLimits): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await limits.onCheckpoint?.();
    return { ok: true };
  } catch (error) {
    const reason = `checkpoint save failed: ${error instanceof Error ? error.message : "watcher checkpoint failed"}`;
    store.setError(reason);
    return { ok: false, reason };
  }
}

async function pause(limits: ScanLimits, ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (limits.sleep) {
    await limits.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function validLimits(limits: ScanLimits): boolean {
  return (
    limits.rangeBlocks >= 1n &&
    limits.maxBlocks >= 1n &&
    Number.isSafeInteger(limits.maxLogsPerRange) &&
    limits.maxLogsPerRange >= 1 &&
    Number.isSafeInteger(limits.maxAttempts) &&
    limits.maxAttempts >= 1 &&
    Number.isSafeInteger(limits.retryMs) &&
    limits.retryMs >= 0 &&
    Number.isSafeInteger(limits.pauseMs) &&
    limits.pauseMs >= 0
  );
}

function minBlock(a: bigint, b: bigint, c: bigint): bigint {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}

function compareBlock(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameContract(left: string, right: string): boolean {
  return getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
}
