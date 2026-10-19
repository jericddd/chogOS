import type { EconomyOutcome } from "@/lib/economy/proposal";

export const PROPOSAL_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "deferred",
  "insufficient_funds",
  "budget_exhausted",
  "unsupported_protocol",
  "cancelled",
  "expired",
  "submitted",
  "confirmed",
  "reverted",
  "settled",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type ProposalAudit = {
  at: string;
  status: ProposalStatus;
  reason: string;
};

export type ProposalRecord = {
  id: string;
  idempotencyKey: string;
  tokenId: string;
  status: ProposalStatus;
  attempts: number;
  outcome: EconomyOutcome | null;
  reason: string;
  expiresAtMs: number;
  /** Always false. A database row is not a broadcast. */
  executed: false;
  txHash: string | null;
  history: ProposalAudit[];
};

const RETRYABLE = new Set<ProposalStatus>(["deferred", "insufficient_funds", "budget_exhausted", "unsupported_protocol"]);
const TERMINAL = new Set<ProposalStatus>(["rejected", "cancelled", "expired", "reverted", "settled"]);
const MAX_ATTEMPTS = 3;

export function openProposal(
  existing: readonly ProposalRecord[],
  input: { id: string; idempotencyKey: string; tokenId: string; expiresAtMs: number; at: string },
): { record: ProposalRecord; records: ProposalRecord[]; created: boolean } {
  const prior = existing.find((record) => record.idempotencyKey === input.idempotencyKey);
  if (prior) {
    return { record: prior, records: [...existing], created: false };
  }
  const record: ProposalRecord = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    tokenId: input.tokenId,
    status: "proposed",
    attempts: 1,
    outcome: null,
    reason: "Structured proposal received. It is not a transaction.",
    expiresAtMs: input.expiresAtMs,
    executed: false,
    txHash: null,
    history: [{ at: input.at, status: "proposed", reason: "Structured proposal received. It is not a transaction." }],
  };
  return { record, records: [...existing, record], created: true };
}

export function applyDecision(
  records: readonly ProposalRecord[],
  key: string,
  outcome: EconomyOutcome,
  reason: string,
  at: string,
  nowMs: number,
): ProposalRecord[] {
  return records.map((record) => {
    if (record.idempotencyKey !== key || record.status !== "proposed") {
      return record;
    }
    if (record.expiresAtMs <= nowMs) {
      return move(record, "expired", "The proposal expired before a decision.", at);
    }
    return { ...move(record, outcome, reason, at), outcome };
  });
}

export function retryProposal(
  records: readonly ProposalRecord[],
  key: string,
  at: string,
  nowMs: number,
): { ok: true; records: ProposalRecord[] } | { ok: false; reason: string; records: ProposalRecord[] } {
  const current = records.find((record) => record.idempotencyKey === key);
  if (!current) {
    return { ok: false, reason: "No proposal exists for that key.", records: [...records] };
  }
  if (current.expiresAtMs <= nowMs) {
    return { ok: true, records: records.map((record) => (record.idempotencyKey === key ? move(record, "expired", "The proposal expired.", at) : record)) };
  }
  if (!RETRYABLE.has(current.status)) {
    return { ok: false, reason: "This proposal cannot be retried from its current status.", records: [...records] };
  }
  if (current.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "The proposal has used its retries.", records: [...records] };
  }
  return {
    ok: true,
    records: records.map((record) => {
      if (record.idempotencyKey !== key) {
        return record;
      }
      const next = move(record, "proposed", "Retry requested. No funds were created.", at);
      return { ...next, attempts: record.attempts + 1 };
    }),
  };
}

export function cancelProposal(records: readonly ProposalRecord[], key: string, at: string): ProposalRecord[] {
  return records.map((record) => {
    if (record.idempotencyKey !== key || TERMINAL.has(record.status) || record.status === "confirmed" || record.status === "submitted") {
      return record;
    }
    return move(record, "cancelled", "Cancelled before broadcast. Any reservation must be released.", at);
  });
}

/** A submission record is still not a confirmed transaction. */
export function noteSubmission(records: readonly ProposalRecord[], key: string, at: string): ProposalRecord[] {
  return records.map((record) => {
    if (record.idempotencyKey !== key || record.status !== "approved") {
      return record;
    }
    return move(record, "submitted", "Submission was recorded. No receipt has been observed.", at);
  });
}

export function noteReceipt(
  records: readonly ProposalRecord[],
  key: string,
  evidence: { status: "success" | "reverted" | "missing"; txHash: string | null },
  at: string,
): ProposalRecord[] {
  return records.map((record) => {
    if (record.idempotencyKey !== key || record.status !== "submitted") {
      return record;
    }
    if (evidence.status === "missing" || !evidence.txHash || !/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash)) {
      return record;
    }
    if (evidence.status === "reverted") {
      return { ...move(record, "reverted", "The receipt reverted. No revenue was realized.", at), txHash: evidence.txHash };
    }
    return { ...move(record, "confirmed", "The receipt succeeded. Settlement still requires a ledger posting.", at), txHash: evidence.txHash };
  });
}

export function settleProposal(records: readonly ProposalRecord[], key: string, at: string): ProposalRecord[] {
  return records.map((record) => {
    if (record.idempotencyKey !== key || record.status !== "confirmed") {
      return record;
    }
    return move(record, "settled", "Settled against chain evidence. This row is not itself a transfer.", at);
  });
}

function move(record: ProposalRecord, status: ProposalStatus, reason: string, at: string): ProposalRecord {
  return {
    ...record,
    status,
    reason,
    executed: false,
    history: [...record.history, { at, status, reason }],
  };
}
