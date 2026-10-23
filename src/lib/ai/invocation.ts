/**
 * Stop starting work before the route's maxDuration. Hobby allows 300s.
 * GitHub's poke stops waiting at 260s and records an empty body if nothing
 * has been written. 200s leaves the in-flight call, claim release, and the
 * response itself inside that window.
 */
export const AI_INVOCATION_DEADLINE_MS = 200_000;
/** Kept after citizen decisions so a wallet review can still start. */
export const AI_TAIL_RESERVE_MS = 48_000;
/** Returned at the deadline plus this grace, even if one call is still pending. */
export const AI_HOST_GRACE_MS = 8_000;
/**
 * Used when the caller will hang up at 90s. The GitHub timer on main still
 * does that until its workflow asks for the long wait.
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

/** Citizen decisions stop early enough for one wallet review to start. */
export function citizenDeadlineMs(deadlineMs: number): number {
  const reserve = Math.min(AI_TAIL_RESERVE_MS, Math.floor(deadlineMs / 3));
  return Math.max(15_000, deadlineMs - reserve);
}

/** One PostgREST call in the mind. A hung query ends here instead of holding the run. */
export const AI_DB_CALL_MS = 20_000;

export function fetchWithDeadline(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const parent = init?.signal;
    if (parent?.aborted) {
      controller.abort();
    } else {
      parent?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !parent?.aborted) {
        throw new Error(`database timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve with the in-progress value if `work` is still pending at `timeoutMs`.
 * The pending work is not cancelled; the caller can still return a summary.
 */
export async function finishBeforeDeadline<T>(work: Promise<T>, fallback: () => T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
