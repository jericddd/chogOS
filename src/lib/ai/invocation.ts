/**
 * Stop starting Gemini calls before the route's maxDuration. Hobby allows 300s.
 * The GitHub poke waits 290s, and that wait includes cold start. New calls stop
 * at four minutes. One in-flight call still finishes inside the response budget.
 */
export const AI_INVOCATION_DEADLINE_MS = 240_000;
/**
 * Used when the caller does not send the long-wait header. The GitHub workflow
 * sends x-chog-ai-wait: long and waits 290s.
 */
export const AI_INVOCATION_DEADLINE_SHORT_MS = 80_000;
/**
 * Return a JSON body while the GitHub curl is still open. 250s of function
 * time leaves room for a cold start inside the 290s curl and stays under the
 * 300s platform limit. Decisions already saved stay saved.
 */
export const AI_RESPONSE_BUDGET_MS = 250_000;
/** Short callers hang up near 90s. Return while that connection is still open. */
export const AI_RESPONSE_BUDGET_SHORT_MS = 85_000;
export const MIND_CUTOFF_REASON =
  "This poke returned before the platform cutoff. Decisions already saved stay saved. The next poke continues.";
export const AI_LONG_WAIT_HEADER = "x-chog-ai-wait";
export const RESPONSE_CUTOFF = Symbol("chog-response-cutoff");
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

export function responseBudgetForRequest(request: Request): number {
  return request.headers.get(AI_LONG_WAIT_HEADER) === "long"
    ? AI_RESPONSE_BUDGET_MS
    : AI_RESPONSE_BUDGET_SHORT_MS;
}

/**
 * Resolve with the mind report, or with RESPONSE_CUTOFF when the budget ends
 * first. The caller returns that cutoff as a normal idle body so the platform
 * does not discard the poke with zero bytes.
 */
export function finishBeforeCutoff<T>(
  work: Promise<T>,
  budgetMs: number,
  schedule: (ms: number, fire: () => void) => () => void = (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
): Promise<T | typeof RESPONSE_CUTOFF> {
  let cancel = () => {};
  const cutoff = new Promise<typeof RESPONSE_CUTOFF>((resolve) => {
    cancel = schedule(Math.max(0, budgetMs), () => resolve(RESPONSE_CUTOFF));
  });
  return Promise.race([work, cutoff]).finally(() => cancel());
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
