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
    return finish(base, "error", false, null);
  }
  if (cursor.lastScannedBlock === null || cursor.lastSuccessAt === null) {
    return finish(base, "uninitialized", false, null);
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

  return finish(base, status, status === "healthy" && lagBlocks === 0n, lagBlocks);
}

function finish(
  base: Omit<WatcherHealth, "status" | "executionAllowed" | "sponsorshipAllowed" | "lagBlocks">,
  status: WatcherStatus,
  executionAllowed: boolean,
  lagBlocks: bigint | null,
): WatcherHealth {
  const backlog = base.pendingInvalidations > 0 || base.failedInvalidations > 0;
  return {
    ...base,
    status,
    executionAllowed,
    sponsorshipAllowed: executionAllowed && !backlog,
    lagBlocks,
  };
}

/**
 * Sponsored execution needs a fresh zero-lag cursor and a clear invalidation backlog.
 * A confirmed invalidation has left the backlog, but that session must not run again.
 * This does not close the race with a transfer mined around the same block.
 */
export function canSponsorExecution(
  health: WatcherHealth,
  sessionInvalidation: "queued" | "submitted" | "confirmed" | "failed" | null = null,
): { allowed: true } | { allowed: false; reason: string } {
  if (health.cursorBlock === null || health.lastSuccessAt === null) {
    return { allowed: false, reason: "watcher has not established transfer history" };
  }
  if (health.status !== "healthy" || !health.executionAllowed || health.lagBlocks !== 0n) {
    return { allowed: false, reason: `watcher is ${health.status}` };
  }
  if (health.pendingInvalidations > 0 || health.failedInvalidations > 0 || !health.sponsorshipAllowed) {
    return { allowed: false, reason: "unresolved invalidation blocks sponsorship" };
  }
  if (sessionInvalidation === "confirmed") {
    return { allowed: false, reason: "session was invalidated" };
  }
  if (sessionInvalidation === "queued" || sessionInvalidation === "submitted" || sessionInvalidation === "failed") {
    return { allowed: false, reason: "session invalidation is not confirmed" };
  }
  return { allowed: true };
}
