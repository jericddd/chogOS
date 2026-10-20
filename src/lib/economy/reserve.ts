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

/**
 * Apply holds one at a time against the same observed balance.
 * The database function takes the row lock; this is the same arithmetic.
 */
export function holdSequentially(
  holds: readonly Hold[],
  requests: readonly {
    id: string;
    key: string;
    proposalId: string;
    tokenId: string;
    asset: "MON" | "CHOG";
    bucket: HoldBucket;
    amountRaw: bigint;
    observedRaw: bigint | null;
  }[],
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

export function tryHold(
  holds: readonly Hold[],
  request: {
    id: string;
    key: string;
    proposalId: string;
    tokenId: string;
    asset: "MON" | "CHOG";
    bucket: HoldBucket;
    amountRaw: bigint;
    observedRaw: bigint | null;
  },
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
