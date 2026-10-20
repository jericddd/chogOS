import { sum } from "@/lib/economy/amounts";

export type HoldBucket = "gas" | "deployment" | "business_capital";

export type Hold = {
  id: string;
  key: string;
  proposalId: string;
  /** Citizen token id. Budget checks match this field exactly. */
  tokenId: string;
  asset: "MON" | "CHOG";
  bucket: HoldBucket;
  amountRaw: bigint;
  state: "held" | "reconciled" | "released";
};

export type HoldResult =
  | { ok: true; holds: Hold[]; hold: Hold; created: boolean }
  | { ok: false; outcome: "insufficient_funds" | "malformed" | "conflict"; reason: string; holds: Hold[] };

export function heldRaw(holds: readonly Hold[], asset: "MON" | "CHOG", bucket?: HoldBucket): bigint {
  return sum(
    holds
      .filter((hold) => hold.state === "held" && hold.asset === asset && (bucket ? hold.bucket === bucket : true))
      .map((hold) => hold.amountRaw),
  );
}

export type HoldRequest = {
  id: string;
  key: string;
  proposalId: string;
  tokenId: string;
  asset: "MON" | "CHOG";
  bucket: HoldBucket;
  amountRaw: bigint;
  observedRaw: bigint | null;
};

export type HoldBatchResult =
  | { ok: true; holds: Hold[]; created: boolean }
  | { ok: false; outcome: "insufficient_funds" | "malformed" | "conflict"; reason: string; holds: Hold[] };

/**
 * Apply holds one at a time against the same observed balance.
 * A later refusal does not release an earlier hold. Production batches use tryHoldBatch.
 */
export function holdSequentially(
  holds: readonly Hold[],
  requests: readonly HoldRequest[],
): { holds: Hold[]; results: HoldResult[] } {
  let current = [...holds];
  const results: HoldResult[] = [];
  for (const request of requests) {
    const result = tryHold(current, request);
    results.push(result);
    current = result.holds;
  }
  return { holds: current, results };
}

/**
 * Validate a whole batch, then insert only the new keys.
 * A conflict, a malformed request, or an insufficient balance returns the original holds unchanged.
 */
export function tryHoldBatch(holds: readonly Hold[], requests: readonly HoldRequest[]): HoldBatchResult {
  if (requests.length < 1 || requests.length > 3) {
    return batchFailure(holds, "malformed", "A reservation needs a positive amount and an observed balance.");
  }
  const seen = new Set<string>();
  for (const request of requests) {
    if (!request.key || seen.has(request.key)) {
      return batchFailure(holds, "malformed", "A reservation needs a positive amount and an observed balance.");
    }
    seen.add(request.key);
    if (!request.tokenId || request.amountRaw <= 0n || request.observedRaw === null || request.observedRaw < 0n) {
      return batchFailure(holds, "malformed", "A reservation needs a positive amount and an observed balance.");
    }
    if ((request.bucket === "gas" || request.bucket === "deployment") && request.asset !== "MON") {
      return batchFailure(holds, "malformed", "Gas and deployment reservations are native MON, not $CHOG.");
    }
    const existing = holds.find((hold) => hold.key === request.key);
    if (existing && !sameHoldIdentity(existing, request)) {
      return batchFailure(holds, "conflict", "This idempotency key is already used for a different reservation.");
    }
  }
  const pending = requests.filter((request) => !holds.some((hold) => hold.key === request.key));
  if (pending.length === 0) {
    return { ok: true, holds: [...holds], created: false };
  }
  for (const asset of new Set(requests.map((request) => request.asset))) {
    const observations = requests.filter((request) => request.asset === asset).map((request) => request.observedRaw);
    const observed = observations[0];
    if (observed === null || observations.some((value) => value !== observed)) {
      return batchFailure(holds, "malformed", "A reservation needs a positive amount and an observed balance.");
    }
    const needed = sum(pending.filter((request) => request.asset === asset).map((request) => request.amountRaw));
    if (heldRaw(holds, asset) + needed > observed) {
      return batchFailure(holds, "insufficient_funds", "The remaining observed balance cannot cover another reservation.");
    }
  }
  const added = pending.map((request): Hold => ({
    id: request.id,
    key: request.key,
    proposalId: request.proposalId,
    tokenId: request.tokenId,
    asset: request.asset,
    bucket: request.bucket,
    amountRaw: request.amountRaw,
    state: "held",
  }));
  return { ok: true, holds: [...holds, ...added], created: true };
}

function batchFailure(
  holds: readonly Hold[],
  outcome: "insufficient_funds" | "malformed" | "conflict",
  reason: string,
): HoldBatchResult {
  return { ok: false, outcome, reason, holds: holds.map((hold) => ({ ...hold })) };
}

export function tryHold(
  holds: readonly Hold[],
  request: HoldRequest,
): HoldResult {
  const existing = holds.find((hold) => hold.key === request.key);
  if (existing) {
    if (!sameHoldIdentity(existing, request)) {
      return {
        ok: false,
        outcome: "conflict",
        reason: "This idempotency key is already used for a different reservation.",
        holds: [...holds],
      };
    }
    return { ok: true, holds: [...holds], hold: existing, created: false };
  }
  if (!request.tokenId || request.amountRaw <= 0n || request.observedRaw === null || request.observedRaw < 0n) {
    return {
      ok: false,
      outcome: "malformed",
      reason: "A reservation needs a positive amount and an observed balance.",
      holds: [...holds],
    };
  }
  if ((request.bucket === "gas" || request.bucket === "deployment") && request.asset !== "MON") {
    return {
      ok: false,
      outcome: "malformed",
      reason: "Gas and deployment reservations are native MON, not $CHOG.",
      holds: [...holds],
    };
  }
  const used = heldRaw(holds, request.asset);
  const free = request.observedRaw > used ? request.observedRaw - used : 0n;
  if (free < request.amountRaw) {
    return {
      ok: false,
      outcome: "insufficient_funds",
      reason: "The remaining observed balance cannot cover another reservation.",
      holds: [...holds],
    };
  }
  const hold: Hold = {
    id: request.id,
    key: request.key,
    proposalId: request.proposalId,
    tokenId: request.tokenId,
    asset: request.asset,
    bucket: request.bucket,
    amountRaw: request.amountRaw,
    state: "held",
  };
  return { ok: true, holds: [...holds, hold], hold, created: true };
}

function sameHoldIdentity(
  existing: Hold,
  request: { proposalId: string; tokenId: string; asset: "MON" | "CHOG"; bucket: HoldBucket; amountRaw: bigint },
): boolean {
  return (
    existing.proposalId === request.proposalId &&
    existing.tokenId === request.tokenId &&
    existing.asset === request.asset &&
    existing.bucket === request.bucket &&
    existing.amountRaw === request.amountRaw
  );
}

export function settleHold(
  holds: readonly Hold[],
  key: string,
  outcome: "confirmed" | "rejected" | "cancelled" | "failed",
): Hold[] {
  return holds.map((hold) => {
    if (hold.key !== key || hold.state !== "held") {
      return hold;
    }
    return { ...hold, state: outcome === "confirmed" ? "reconciled" : "released" };
  });
}
