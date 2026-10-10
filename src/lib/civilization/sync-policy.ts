export const SYNC_LOCK_MS = 120_000;

export function decideSyncLock(input: {
  nowMs: number;
  minIntervalMs: number;
  runningStartedAtMs: number | null;
  lastSuccessFinishedAtMs: number | null;
}): "start" | "expire" | "already_running" | "too_soon" {
  if (input.runningStartedAtMs !== null) {
    if (input.nowMs - input.runningStartedAtMs < SYNC_LOCK_MS) {
      return "already_running";
    }
    return "expire";
  }
  if (
    input.lastSuccessFinishedAtMs !== null &&
    input.nowMs - input.lastSuccessFinishedAtMs < input.minIntervalMs
  ) {
    return "too_soon";
  }
  return "start";
}
