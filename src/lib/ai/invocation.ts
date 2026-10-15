/** Leave headroom under Vercel Hobby's 60s function kill. */
export const AI_INVOCATION_DEADLINE_MS = 48_000;
const RESERVE_MS = 2_500;
const MIN_PROVIDER_MS = 3_000;

export function timeoutWithinDeadline(
  startedAtMs: number,
  configuredTimeoutMs: number,
  nowMs: number = Date.now(),
): number | null {
  const remaining = AI_INVOCATION_DEADLINE_MS - (nowMs - startedAtMs) - RESERVE_MS;
  if (remaining < MIN_PROVIDER_MS) {
    return null;
  }
  return Math.min(configuredTimeoutMs, remaining);
}
