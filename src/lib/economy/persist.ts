import type { TreasurySnapshot } from "@/lib/economy/observe";
import type { EconomicProposal, EconomyDecision } from "@/lib/economy/proposal";
import type { Hold } from "@/lib/economy/reserve";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OpenResult = { ok: true; id: string; created: boolean } | { ok: false; reason: string };
export type StatusResult = { ok: true; status: string; duplicate: boolean } | { ok: false; reason: string };
export type HoldsResult =
  | { ok: true; created: boolean; createdKeys?: unknown }
  | { ok: false; outcome: string; reason: string };

const UNRESOLVED_HOLD_REASON =
  "The reservation response did not identify the new holds. Existing reservations were left unchanged. Retry the same proposal; nothing was released.";

export type CreatedKeySelection =
  | { ok: true; keys: readonly string[] }
  | { ok: false; code: "missing" | "malformed"; reason: string };

/**
 * Keys this call may release are the ones the database listed and this call submitted.
 * A missing or malformed list is not evidence that every submitted key is new.
 */
export function selectCreatedKeys(
  held: { created: boolean; createdKeys?: unknown },
  submittedKeys: readonly string[],
): CreatedKeySelection {
  const submitted = new Set(submittedKeys.filter((key) => key.length > 0 && key.length <= 120));
  if (held.createdKeys === undefined) {
    if (held.created) {
      return { ok: false, code: "missing", reason: UNRESOLVED_HOLD_REASON };
    }
    return { ok: true, keys: [] };
  }
  if (!Array.isArray(held.createdKeys)) {
    return { ok: false, code: "malformed", reason: UNRESOLVED_HOLD_REASON };
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of held.createdKeys) {
    if (typeof item !== "string" || item.length === 0 || item.length > 120 || !submitted.has(item) || seen.has(item)) {
      return { ok: false, code: "malformed", reason: UNRESOLVED_HOLD_REASON };
    }
    seen.add(item);
    keys.push(item);
  }
  if (held.created && keys.length === 0) {
    return { ok: false, code: "missing", reason: UNRESOLVED_HOLD_REASON };
  }
  if (!held.created && keys.length > 0) {
    return { ok: false, code: "malformed", reason: UNRESOLVED_HOLD_REASON };
  }
  return { ok: true, keys };
}

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
  | { ok: false; reason: string; reserved: false; outcome?: "deferred" };

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
  let createdKeys: readonly string[] = [];
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
        const selected = selectCreatedKeys(held, inserts.map((row) => row.key));
        if (!selected.ok) {
          logEconomyPersist({
            event: "hold_ownership_unresolved",
            code: selected.code,
            idempotencyKey: input.proposal.idempotencyKey,
            proposalId: opened.id,
            submittedCount: inserts.length,
            created: held.created,
            releaseCount: 0,
          });
          return { ok: false, reason: selected.reason, reserved: false, outcome: "deferred" };
        }
        createdKeys = selected.keys;
      }
    }
  }

  const applied = await gateway.applyStatus({
    key: input.proposal.idempotencyKey,
    status,
    reason: reason.slice(0, 500),
  });
  if (!applied.ok) {
    let releaseOk: boolean | null = null;
    if (createdKeys.length > 0) {
      const released = await gateway.release(opened.id, createdKeys);
      releaseOk = released.ok;
    }
    logEconomyPersist({
      event: "hold_status_unapplied",
      idempotencyKey: input.proposal.idempotencyKey,
      proposalId: opened.id,
      submittedCount: createdKeys.length,
      created: createdKeys.length > 0,
      releaseCount: createdKeys.length,
      releaseOk,
    });
    const failure = releaseOk === false
      ? `${applied.reason} The identified new reservations could not be released.`
      : applied.reason;
    return { ok: false, reason: failure, reserved: false };
  }
  return { ok: true, proposalId: opened.id, status: applied.status, reserved: createdKeys.length > 0 && status === "approved" };
}

function logEconomyPersist(input: {
  event: "hold_ownership_unresolved" | "hold_status_unapplied";
  code?: "missing" | "malformed";
  idempotencyKey: string;
  proposalId: string;
  submittedCount: number;
  created: boolean;
  releaseCount: number;
  releaseOk?: boolean | null;
}): void {
  console.warn(
    JSON.stringify({
      source: "economy.persist",
      event: input.event,
      code: input.code ?? null,
      idempotencyKey: safeDiagnosticId(input.idempotencyKey),
      proposalId: safeDiagnosticId(input.proposalId),
      submittedCount: input.submittedCount,
      created: input.created,
      releaseCount: input.releaseCount,
      releaseOk: input.releaseOk ?? null,
    }),
  );
}

function safeDiagnosticId(value: string): string {
  if (/https?:|bearer|private|secret|token=|service_role/i.test(value)) {
    return "[redacted]";
  }
  return value.slice(0, 120);
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
