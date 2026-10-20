import type { TreasurySnapshot } from "@/lib/economy/observe";
import type { EconomicProposal, EconomyDecision } from "@/lib/economy/proposal";
import type { Hold } from "@/lib/economy/reserve";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OpenResult = { ok: true; id: string; created: boolean } | { ok: false; reason: string };
export type StatusResult = { ok: true; status: string; duplicate: boolean } | { ok: false; reason: string };
export type HoldsResult =
  | { ok: true; created: boolean; createdKeys?: readonly string[] }
  | { ok: false; outcome: string; reason: string };

export type HoldInsert = {
  key: string;
  proposalId: string;
  tokenId: string;
  asset: "MON" | "CHOG";
  bucket: "gas" | "deployment" | "business_capital";
  amountRaw: string;
  observedRaw: string;
};

export type EconomyGateway = {
  openProposal(row: Record<string, string>): Promise<OpenResult>;
  applyStatus(input: { key: string; status: string; reason: string }): Promise<StatusResult>;
  tryHolds(holds: readonly HoldInsert[]): Promise<HoldsResult>;
  release(proposalId: string, keys: readonly string[]): Promise<{ ok: boolean }>;
};

export type PersistResult =
  | { ok: true; proposalId: string; status: string; reserved: boolean }
  | { ok: false; reason: string; reserved: false };

/** Conflict is terminal for this key. Other hold failures stay retryable. */
export function holdFailureStatus(outcome: string): "insufficient_funds" | "rejected" | "deferred" {
  if (outcome === "insufficient_funds") {
    return "insufficient_funds";
  }
  if (outcome === "conflict") {
    return "rejected";
  }
  return "deferred";
}

export function proposalRow(proposal: EconomicProposal): Record<string, string> | { error: string } {
  if (!UUID.test(proposal.citizenId)) {
    return { error: "The citizen id is not a permanent citizen id." };
  }
  return {
    idempotencyKey: proposal.idempotencyKey,
    citizenId: proposal.citizenId,
    nftContract: proposal.nftContract,
    tokenId: proposal.tokenId,
    operation: proposal.operation,
    objective: proposal.objective,
    rationale: proposal.rationale,
    expectedOutcome: proposal.expectedOutcome,
    target: proposal.target ?? "",
    selector: proposal.selector ?? "",
    asset: proposal.asset,
    amountRaw: proposal.amountRaw.toString(10),
    estimatedGasWei: proposal.estimatedGasWei.toString(10),
    fundingRequestRaw: proposal.fundingRequestRaw.toString(10),
    quotePriceRaw: proposal.quotePriceRaw === null ? "" : proposal.quotePriceRaw.toString(10),
    slippageBps: proposal.slippageBps === null ? "" : String(proposal.slippageBps),
    expiresAt: new Date(proposal.expiresAtMs).toISOString(),
  };
}

/**
 * Write the proposal, its status audit, and any offchain holds.
 * Holds are saved before the approved status so a failed reservation does not
 * leave an approved row. The gateway does not sign or broadcast.
 */
export async function persistEconomyDecision(
  gateway: EconomyGateway,
  input: {
    proposal: EconomicProposal;
    decision: EconomyDecision;
    holds: readonly Hold[];
    observation: TreasurySnapshot;
  },
): Promise<PersistResult> {
  const row = proposalRow(input.proposal);
  if ("error" in row) {
    return { ok: false, reason: row.error, reserved: false };
  }
  const opened = await gateway.openProposal(row);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason, reserved: false };
  }

  let status = input.decision.outcome;
  let reason = input.decision.reason;
  let createdKeys: string[] = [];
  if (input.decision.reserved) {
    const inserts = holdInserts(input.proposal, input.holds, input.observation, opened.id);
    if ("error" in inserts) {
      return { ok: false, reason: inserts.error, reserved: false };
    }
    if (inserts.length > 0) {
      const held = await gateway.tryHolds(inserts);
      if (!held.ok) {
        status = holdFailureStatus(held.outcome);
        reason = held.reason;
      } else {
        createdKeys = held.createdKeys ? [...held.createdKeys] : held.created ? inserts.map((row) => row.key) : [];
      }
    }
  }

  const applied = await gateway.applyStatus({
    key: input.proposal.idempotencyKey,
    status,
    reason: reason.slice(0, 500),
  });
  if (!applied.ok) {
    if (createdKeys.length > 0) {
      await gateway.release(opened.id, createdKeys);
    }
    return { ok: false, reason: applied.reason, reserved: false };
  }
  return { ok: true, proposalId: opened.id, status: applied.status, reserved: createdKeys.length > 0 && status === "approved" };
}

function holdInserts(
  proposal: EconomicProposal,
  holds: readonly Hold[],
  observation: TreasurySnapshot,
  proposalId: string,
): HoldInsert[] | { error: string } {
  const relevant = holds.filter(
    (hold) =>
      hold.state === "held" &&
      (hold.key === proposal.idempotencyKey || hold.key === `${proposal.idempotencyKey}:gas`),
  );
  const inserts: HoldInsert[] = [];
  for (const hold of relevant) {
    const observed = hold.asset === "MON" ? observation.mon.raw : observation.chog.raw;
    if (observed === null) {
      return { error: "A balance is missing, so the reservation was not saved." };
    }
    inserts.push({
      key: hold.key,
      proposalId,
      tokenId: hold.tokenId,
      asset: hold.asset,
      bucket: hold.bucket,
      amountRaw: hold.amountRaw.toString(10),
      observedRaw: observed.toString(10),
    });
  }
  return inserts;
}
