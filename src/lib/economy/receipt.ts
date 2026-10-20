import type { Hex } from "viem";
import type { JournalLine } from "@/lib/economy/journal";
import { isRpcVerifiedReceipt } from "@/lib/economy/verify-receipt";

const HASH = /^0x[0-9a-fA-F]{64}$/;

export type ReceiptObservation = {
  chainId: number;
  observedChainId: number | null;
  txHash: string;
  status: "success" | "reverted" | "missing";
  blockNumber: bigint | null;
  blockHash: string | null;
};

/**
 * A parsed shape. It is not a mainnet proof.
 * Confirmation and settlement accept only a receipt branded by verifyMainnetReceipt.
 */
export type ReceiptShape = {
  kind: "receipt-shape";
  chainId: 143;
  txHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
};

/** Shape check only. A passing result cannot confirm or settle a proposal. */
export function assessReceiptEvidence(
  observation: ReceiptObservation,
): { ok: true; evidence: ReceiptShape } | { ok: false; reason: string } {
  if (observation.chainId !== 143 || observation.observedChainId !== 143) {
    return { ok: false, reason: "Receipt evidence must be observed on Monad mainnet 143." };
  }
  if (observation.status === "missing") {
    return { ok: false, reason: "A missing receipt is not evidence." };
  }
  if (observation.status !== "success" && observation.status !== "reverted") {
    return { ok: false, reason: "Receipt evidence must say success or reverted." };
  }
  if (
    !HASH.test(observation.txHash) ||
    observation.blockNumber === null ||
    observation.blockNumber < 0n ||
    !observation.blockHash ||
    !HASH.test(observation.blockHash)
  ) {
    return { ok: false, reason: "Receipt evidence is missing a transaction hash, block number, or block hash." };
  }
  return {
    ok: true,
    evidence: {
      kind: "receipt-shape",
      chainId: 143,
      txHash: observation.txHash.toLowerCase() as Hex,
      status: observation.status,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash.toLowerCase() as Hex,
    },
  };
}

/** A counted chain posting whose evidence key starts with the mainnet transaction. */
export function journalSupportsReceipt(lines: readonly JournalLine[], txHash: string): boolean {
  if (!HASH.test(txHash)) {
    return false;
  }
  const prefix = `143:${txHash.toLowerCase()}:`;
  return lines.some(
    (line) =>
      line.source === "chain" &&
      (line.status === "observed" || line.status === "realized") &&
      line.evidenceKey !== null &&
      line.evidenceKey.toLowerCase().startsWith(prefix),
  );
}

export function receiptRpcArgs(
  key: string,
  evidence: unknown,
  reason: string,
): { ok: true; args: Record<string, string | number> } | { ok: false; reason: string } {
  if (!key || !isRpcVerifiedReceipt(evidence)) {
    return { ok: false, reason: "Receipt evidence must be observed on Monad mainnet 143." };
  }
  return {
    ok: true,
    args: {
      p_key: key,
      p_reason: reason.slice(0, 500),
      p_tx: evidence.txHash,
      p_chain: evidence.chainId,
      p_block: evidence.blockNumber.toString(10),
      p_block_hash: evidence.blockHash,
      p_receipt_status: evidence.status,
    },
  };
}

export function settleRpcArgs(
  key: string,
  evidence: unknown,
): { ok: true; args: { p_key: string; p_tx: string } } | { ok: false; reason: string } {
  if (!key || !isRpcVerifiedReceipt(evidence) || evidence.status !== "success") {
    return { ok: false, reason: "Settlement requires a successful mainnet receipt." };
  }
  return { ok: true, args: { p_key: key, p_tx: evidence.txHash } };
}

/**
 * Link a verified receipt to settlement.
 * A receipt has no transfer amount. The amount is a linkage unit, the kind is
 * receipt_observed, and both accounts are external, so counted treasury totals
 * do not change. The evidence key is 143:<tx>:receipt.
 */
export function receiptJournalArgs(
  evidence: unknown,
): { ok: true; args: { p_lines: Array<Record<string, string>> } } | { ok: false; reason: string } {
  if (!isRpcVerifiedReceipt(evidence) || evidence.status !== "success") {
    return { ok: false, reason: "Settlement requires a successful mainnet receipt." };
  }
  const key = `143:${evidence.txHash}:receipt`;
  const line = (side: "debit" | "credit"): Record<string, string> => ({
    postingId: key,
    account: "external",
    asset: "MON",
    amountRaw: "1",
    side,
    kind: "receipt_observed",
    source: "chain",
    ref: key,
    status: "observed",
    evidenceKey: key,
  });
  return { ok: true, args: { p_lines: [line("debit"), line("credit")] } };
}

/** Whether the stored proposal may receive a journal line for this verified transaction. */
export function settlementReadiness(
  row: { status: string; txHash: string | null } | null,
  txHash: string,
): { ok: true } | { ok: false; reason: string } {
  if (!row) {
    return { ok: false, reason: "No proposal exists for that key." };
  }
  const stored = row.txHash?.toLowerCase() ?? "";
  const requested = txHash.toLowerCase();
  if (stored && stored !== requested) {
    return { ok: false, reason: "This proposal is already tied to a different transaction." };
  }
  if ((row.status === "confirmed" || row.status === "settled") && stored === requested) {
    return { ok: true };
  }
  return { ok: false, reason: "Settlement requires a successful mainnet receipt." };
}
