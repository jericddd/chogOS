import type { Address, Hex } from "viem";
import { sum } from "@/lib/economy/amounts";

export const JOURNAL_KINDS = [
  "treasury_deposit",
  "treasury_return",
  "gas_spent",
  "deployment_spent",
  "capital_allocated",
  "payment",
  "purchase",
  "earnings",
  "revenue_returned",
  "loss_realized",
  "capital_recovered",
  "receipt_observed",
] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];

export type JournalStatus = "proposed" | "submitted" | "observed" | "realized" | "reverted" | "rejected";

export type JournalAccount = "treasury" | "external" | "spent" | "revenue" | "loss";

export type JournalLine = {
  postingId: string;
  account: JournalAccount;
  asset: "MON" | "CHOG";
  amountRaw: bigint;
  side: "debit" | "credit";
  kind: JournalKind;
  source: "proposal" | "chain";
  ref: string;
  status: JournalStatus;
  evidenceKey: string | null;
  citizenTokenId: string | null;
  at: string;
};

export type ChainTransferEvidence = {
  chainId: number;
  txHash: Hex;
  logIndex: number | null;
  status: "success" | "reverted" | "missing";
  asset: "MON" | "CHOG";
  amountRaw: bigint;
  direction: "in" | "out";
  treasury: Address;
  counterparty: Address;
  blockNumber: bigint;
};

const COUNTED = new Set<JournalStatus>(["observed", "realized"]);

/** A model sentence, including a claimed deposit or profit, is not a journal line. */
export function journalFromModelClaim(claim: unknown): null {
  void claim;
  return null;
}

export function evidenceKey(evidence: Pick<ChainTransferEvidence, "chainId" | "txHash" | "logIndex" | "asset" | "direction">): string {
  const log = evidence.logIndex === null ? "native" : String(evidence.logIndex);
  return `${evidence.chainId}:${evidence.txHash.toLowerCase()}:${log}:${evidence.asset}:${evidence.direction}`;
}

export function postingBalanced(lines: readonly JournalLine[]): boolean {
  if (lines.length < 2) {
    return false;
  }
  const postingId = lines[0]?.postingId;
  if (!postingId || lines.some((line) => line.postingId !== postingId || line.amountRaw <= 0n)) {
    return false;
  }
  const assets = new Set(lines.map((line) => line.asset));
  for (const asset of assets) {
    const debit = sum(lines.filter((line) => line.asset === asset && line.side === "debit").map((line) => line.amountRaw));
    const credit = sum(lines.filter((line) => line.asset === asset && line.side === "credit").map((line) => line.amountRaw));
    if (debit !== credit || debit === 0n) {
      return false;
    }
  }
  return true;
}

export function appendPosting(
  existing: readonly JournalLine[],
  lines: readonly JournalLine[],
): { ok: true; lines: JournalLine[]; duplicate: boolean } | { ok: false; reason: string } {
  if (!postingBalanced(lines)) {
    return { ok: false, reason: "A journal posting must be a balanced debit and credit." };
  }
  const key = lines.find((line) => line.evidenceKey)?.evidenceKey ?? null;
  if (key && existing.some((line) => line.evidenceKey === key)) {
    return { ok: true, lines: [...existing], duplicate: true };
  }
  const ref = `${lines[0]!.kind}:${lines[0]!.ref}:${lines[0]!.asset}`;
  if (existing.some((line) => `${line.kind}:${line.ref}:${line.asset}` === ref)) {
    return { ok: true, lines: [...existing], duplicate: true };
  }
  return { ok: true, lines: [...existing, ...lines], duplicate: false };
}

/**
 * Record a transfer only from chain evidence. Missing and reverted receipts do
 * not change the counted treasury position.
 */
export function reconcileChainTransfer(
  existing: readonly JournalLine[],
  evidence: ChainTransferEvidence,
  at: string,
): { ok: true; lines: JournalLine[]; duplicate: boolean; counted: boolean } | { ok: false; reason: string } {
  if (evidence.chainId !== 143) {
    return { ok: false, reason: "Only Monad mainnet chain 143 can be reconciled." };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash) || evidence.amountRaw <= 0n || evidence.blockNumber < 0n) {
    return { ok: false, reason: "The transfer evidence is malformed." };
  }
  const key = evidenceKey(evidence);
  if (evidence.status === "missing") {
    return { ok: true, lines: [...existing], duplicate: false, counted: false };
  }
  const status: JournalStatus = evidence.status === "success" ? "observed" : "reverted";
  const kind: JournalKind = evidence.direction === "in" ? "treasury_deposit" : "payment";
  const treasurySide = evidence.direction === "in" ? "debit" : "credit";
  const externalSide = evidence.direction === "in" ? "credit" : "debit";
  const lines: JournalLine[] = [
    line(key, "treasury", treasurySide, evidence, kind, status, at),
    line(key, "external", externalSide, evidence, kind, status, at),
  ];
  const posted = appendPosting(existing, lines);
  if (!posted.ok) {
    return posted;
  }
  return { ...posted, counted: status === "observed" && !posted.duplicate };
}

function line(
  key: string,
  account: JournalAccount,
  side: "debit" | "credit",
  evidence: ChainTransferEvidence,
  kind: JournalKind,
  status: JournalStatus,
  at: string,
): JournalLine {
  return {
    postingId: key,
    account,
    asset: evidence.asset,
    amountRaw: evidence.amountRaw,
    side,
    kind,
    source: "chain",
    ref: key,
    status,
    evidenceKey: key,
    citizenTokenId: null,
    at,
  };
}

/** Counted treasury movement. Proposed, submitted, and reverted lines are excluded. */
export function treasuryPosition(lines: readonly JournalLine[], asset: "MON" | "CHOG"): bigint {
  let net = 0n;
  for (const line of lines) {
    if (line.account !== "treasury" || line.asset !== asset || !COUNTED.has(line.status)) {
      continue;
    }
    net += line.side === "debit" ? line.amountRaw : -line.amountRaw;
  }
  return net;
}

export function realizedAmount(lines: readonly JournalLine[], kind: JournalKind, asset: "MON" | "CHOG"): bigint {
  const account: JournalAccount = kind === "loss_realized" || kind === "gas_spent" || kind === "deployment_spent" ? (kind === "loss_realized" ? "loss" : "spent") : "revenue";
  const side = account === "revenue" ? "credit" : "debit";
  return sum(
    lines
      .filter((line) => line.kind === kind && line.asset === asset && line.status === "realized" && line.account === account && line.side === side)
      .map((line) => line.amountRaw),
  );
}

/**
 * Earnings, returned revenue, and losses become realized only with chain evidence
 * already counted. A proposal text never reaches this function.
 */
export function realizeSupported(
  existing: readonly JournalLine[],
  input: {
    kind: "earnings" | "revenue_returned" | "loss_realized" | "capital_recovered";
    asset: "MON" | "CHOG";
    amountRaw: bigint;
    evidence: ChainTransferEvidence;
    at: string;
  },
): { ok: true; lines: JournalLine[]; duplicate: boolean } | { ok: false; reason: string } {
  if (input.evidence.status !== "success" || input.evidence.chainId !== 143) {
    return { ok: false, reason: "Realized results require a successful mainnet receipt." };
  }
  if (input.evidence.amountRaw !== input.amountRaw || input.evidence.asset !== input.asset) {
    return { ok: false, reason: "The realized amount does not match the chain evidence." };
  }
  const incoming = input.kind === "loss_realized" ? input.evidence.direction === "out" : input.evidence.direction === "in";
  if (!incoming) {
    return { ok: false, reason: "The transfer direction does not support that result." };
  }
  const moved = reconcileChainTransfer(existing, input.evidence, input.at);
  if (!moved.ok) {
    return moved;
  }
  const key = `${evidenceKey(input.evidence)}:${input.kind}`;
  const classified: JournalAccount = input.kind === "loss_realized" ? "loss" : "revenue";
  const classifiedSide = input.kind === "loss_realized" ? "debit" : "credit";
  const externalSide = classifiedSide === "debit" ? "credit" : "debit";
  const lines: JournalLine[] = [
    {
      postingId: key,
      account: classified,
      asset: input.asset,
      amountRaw: input.amountRaw,
      side: classifiedSide,
      kind: input.kind,
      source: "chain",
      ref: key,
      status: "realized",
      evidenceKey: key,
      citizenTokenId: null,
      at: input.at,
    },
    {
      postingId: key,
      account: "external",
      asset: input.asset,
      amountRaw: input.amountRaw,
      side: externalSide,
      kind: input.kind,
      source: "chain",
      ref: key,
      status: "realized",
      evidenceKey: key,
      citizenTokenId: null,
      at: input.at,
    },
  ];
  const posted = appendPosting(moved.lines, lines);
  return posted;
}

/**
 * A proposed entry is not an observed transfer. It cannot carry chain evidence
 * and it does not change the counted treasury position.
 */
export function proposeAccounting(
  existing: readonly JournalLine[],
  input: {
    postingId: string;
    kind: JournalKind;
    asset: "MON" | "CHOG";
    amountRaw: bigint;
    ref: string;
    at: string;
    citizenTokenId?: string | null;
  },
): { ok: true; lines: JournalLine[]; duplicate: boolean } | { ok: false; reason: string } {
  if (input.amountRaw <= 0n) {
    return { ok: false, reason: "A proposed amount must be a positive integer." };
  }
  const shared = {
    postingId: input.postingId,
    asset: input.asset,
    amountRaw: input.amountRaw,
    kind: input.kind,
    source: "proposal" as const,
    ref: input.ref,
    status: "proposed" as const,
    evidenceKey: null,
    citizenTokenId: input.citizenTokenId ?? null,
    at: input.at,
  };
  return appendPosting(existing, [
    { ...shared, account: "treasury", side: "debit" },
    { ...shared, account: "external", side: "credit" },
  ]);
}

/** Actual gas or deployment spend. A reservation is not passed to this function. */
export function spendSupported(
  existing: readonly JournalLine[],
  input: {
    kind: "gas_spent" | "deployment_spent";
    amountRaw: bigint;
    evidence: ChainTransferEvidence;
    at: string;
  },
): { ok: true; lines: JournalLine[]; duplicate: boolean } | { ok: false; reason: string } {
  if (input.evidence.status !== "success" || input.evidence.chainId !== 143 || input.evidence.direction !== "out") {
    return { ok: false, reason: "Spent gas requires a successful outgoing mainnet receipt." };
  }
  if (input.evidence.asset !== "MON" || input.evidence.amountRaw !== input.amountRaw) {
    return { ok: false, reason: "Spent gas must match the native MON receipt." };
  }
  const moved = reconcileChainTransfer(existing, input.evidence, input.at);
  if (!moved.ok) {
    return moved;
  }
  const key = `${evidenceKey(input.evidence)}:${input.kind}`;
  const shared = {
    postingId: key,
    asset: "MON" as const,
    amountRaw: input.amountRaw,
    kind: input.kind,
    source: "chain" as const,
    ref: key,
    status: "realized" as const,
    evidenceKey: key,
    citizenTokenId: null,
    at: input.at,
  };
  return appendPosting(moved.lines, [
    { ...shared, account: "spent", side: "debit" },
    { ...shared, account: "external", side: "credit" },
  ]);
}
