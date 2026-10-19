import type { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import type { WatcherHealth, WatcherStatus } from "@/lib/watcher/types";

export function assessWatcher(input: {
  store: MemoryWatcherStore;
  tipBlock: bigint | null;
  nowMs: number;
  maxLagBlocks: bigint;
  maxStaleMs: number;
}): WatcherHealth {
  const cursor = input.store.getCursor();
  const pendingInvalidations = input.store.invalidations.filter((row) => row.state === "queued" || row.state === "submitted").length;
  const failedInvalidations = input.store.invalidations.filter((row) => row.state === "failed").length;
  const confirmedInvalidations = input.store.invalidations.filter((row) => row.state === "confirmed").length;
  const base = {
    cursorBlock: cursor.lastScannedBlock,
    tipBlock: input.tipBlock,
    lastError: cursor.lastError,
    lastSuccessAt: cursor.lastSuccessAt,
    pendingInvalidations,
    failedInvalidations,
    confirmedInvalidations,
  };

  if (cursor.lastError && cursor.lastScannedBlock === null) {
    return { ...base, status: "error", executionAllowed: false, lagBlocks: null };
  }
  if (cursor.lastScannedBlock === null || cursor.lastSuccessAt === null) {
    return { ...base, status: "uninitialized", executionAllowed: false, lagBlocks: null };
  }

  const lagBlocks = input.tipBlock === null ? null : input.tipBlock - cursor.lastScannedBlock;
  const stale = input.nowMs - Date.parse(cursor.lastSuccessAt) > input.maxStaleMs;
  let status: WatcherStatus = "healthy";
  if (cursor.lastError) {
    status = "error";
  } else if (stale || lagBlocks === null || lagBlocks > input.maxLagBlocks) {
    status = "stalled";
  } else if (lagBlocks > 0n) {
    status = "lagging";
  }

  return {
    ...base,
    status,
    executionAllowed: status === "healthy" && lagBlocks === 0n,
    lagBlocks,
  };
}
