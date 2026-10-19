import type { ScanLimits } from "@/lib/watcher/scan";

/**
 * Classify a chain read failure.
 * A size limit is split into smaller ranges. A rate limit or timeout is retried.
 * Anything else stops the range without moving the cursor.
 */
export function rpcErrorClass(message: string): "limit" | "transient" | "fatal" {
  const text = message.toLowerCase();
  if (
    /429|rate limit|too many requests|timeout|timed out|econnreset|econnrefused|socket|502|503|504|temporarily|header not found|block not found|unknown block|try again/.test(
      text,
    )
  ) {
    return "transient";
  }
  if (
    text.includes("-32005") ||
    /exceed|response size|block range|query returned more|log response size|payload too large|more than \d+|result limit|returned more than|history has been pruned|too many logs|too many results|range is too wide/.test(
      text,
    )
  ) {
    return "limit";
  }
  return "fatal";
}

export function isRpcError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "error" in value && !("hash" in value);
}

/**
 * Retry a transient read. A limit error returns immediately so the caller can halve the range.
 * Backoff is skipped when retryMs is 0, which keeps unit tests synchronous.
 */
export async function readWithRetry<T>(
  limits: Pick<ScanLimits, "maxAttempts" | "retryMs" | "sleep">,
  read: () => Promise<T | { error: string }>,
  splitOnLimit: boolean,
): Promise<{ ok: true; value: T } | { ok: false; split: boolean; error: string }> {
  let last = "chain read failed";
  const attempts = Math.max(1, limits.maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await read();
    if (!isRpcError(value)) {
      return { ok: true, value };
    }
    last = value.error;
    const kind = rpcErrorClass(value.error);
    if (kind === "limit" && splitOnLimit) {
      return { ok: false, split: true, error: value.error };
    }
    if (kind !== "transient" || attempt === attempts) {
      return { ok: false, split: false, error: value.error };
    }
    const waitMs = limits.retryMs * 2 ** (attempt - 1);
    if (waitMs > 0) {
      if (limits.sleep) {
        await limits.sleep(waitMs);
      } else {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  return { ok: false, split: false, error: last };
}
