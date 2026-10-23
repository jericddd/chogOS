/**
 * Stop starting Gemini calls before the route's maxDuration. Hobby allows 300s.
 * Four minutes leaves one in-flight call, up to the 40s request timeout, time
 * to finish. The GitHub poke waits 290s for that body.
 */
export const AI_INVOCATION_DEADLINE_MS = 240_000;
/**
 * Used when the caller does not send the long-wait header. The GitHub workflow
 * sends x-chog-ai-wait: long and waits 290s.
 */
export const AI_INVOCATION_DEADLINE_SHORT_MS = 80_000;
export const AI_LONG_WAIT_HEADER = "x-chog-ai-wait";
/** Five requests per minute. The tighter free-tier pace for Gemini Flash. */
export const FREE_TIER_REQUEST_GAP_MS = 12_000;
const RESERVE_MS = 2_500;
const MIN_PROVIDER_MS = 3_000;

export function freeTierWaitMs(lastStartedAtMs: number, nowMs: number): number {
  if (lastStartedAtMs <= 0) {
    return 0;
  }
  return Math.max(0, FREE_TIER_REQUEST_GAP_MS - (nowMs - lastStartedAtMs));
}

export function deadlineForRequest(request: Request): number {
  return request.headers.get(AI_LONG_WAIT_HEADER) === "long"
    ? AI_INVOCATION_DEADLINE_MS
    : AI_INVOCATION_DEADLINE_SHORT_MS;
}

/**
 * Wait until another Gemini request can start, then return the timeout that
 * still fits in this poke. Returns null without sleeping when the gap would
 * run past the invocation deadline.
 */

export async function awaitFreeTierSlot(
  lastStartedAtMs: number,
  invocationStartedAtMs: number,
  configuredTimeoutMs: number,
  nowMs: number = Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs: number = AI_INVOCATION_DEADLINE_MS,
): Promise<{ startedAtMs: number; timeoutMs: number } | null> {
  const wait = freeTierWaitMs(lastStartedAtMs, nowMs);
  const startedAtMs = nowMs + wait;
  const timeoutMs = timeoutWithinDeadline(invocationStartedAtMs, configuredTimeoutMs, startedAtMs, deadlineMs);
  if (timeoutMs === null) {
    return null;
  }
  if (wait > 0) {
    await sleep(wait);
  }
  return { startedAtMs, timeoutMs };
}

export function timeoutWithinDeadline(
  startedAtMs: number,
  configuredTimeoutMs: number,
  nowMs: number = Date.now(),
  deadlineMs: number = AI_INVOCATION_DEADLINE_MS,
): number | null {
  const remaining = deadlineMs - (nowMs - startedAtMs) - RESERVE_MS;
  if (remaining < MIN_PROVIDER_MS) {
    return null;
  }
  return Math.min(configuredTimeoutMs, remaining);
}
