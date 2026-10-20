import type { Hex } from "viem";
import type { JournalLine } from "@/lib/economy/journal";

const HASH = /^0x[0-9a-fA-F]{64}$/;

export type ReceiptObservation = {
  chainId: number;
  observedChainId: number | null;
  txHash: string;
  status: "success" | "reverted" | "missing";
  blockNumber: bigint | null;
  blockHash: string | null;
};

/** Returned only by assessReceiptEvidence. Callers still re-check the fields. */
export type VerifiedReceipt = {
  kind: "verified-mainnet-receipt";
  chainId: 143;
  txHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
};

export function assessReceiptEvidence(
  observation: ReceiptObservation,
): { ok: true; evidence: VerifiedReceipt } | { ok: false; reason: string } {
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
      kind: "verified-mainnet-receipt",
      chainId: 143,
      txHash: observation.txHash.toLowerCase() as Hex,
      status: observation.status,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash.toLowerCase() as Hex,
    },
  };
}

export function verifiedReceiptOk(evidence: VerifiedReceipt | null | undefined): evidence is VerifiedReceipt {
  return Boolean(
    evidence &&
      evidence.kind === "verified-mainnet-receipt" &&
      evidence.chainId === 143 &&
      (evidence.status === "success" || evidence.status === "reverted") &&
      HASH.test(evidence.txHash) &&
      HASH.test(evidence.blockHash) &&
      evidence.blockNumber >= 0n,
  );
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
  evidence: VerifiedReceipt,
  reason: string,
): { ok: true; args: Record<string, string | number> } | { ok: false; reason: string } {
  if (!key || !verifiedReceiptOk(evidence)) {
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
  evidence: VerifiedReceipt,
): { ok: true; args: { p_key: string; p_tx: string } } | { ok: false; reason: string } {
  if (!key || !verifiedReceiptOk(evidence) || evidence.status !== "success") {
    return { ok: false, reason: "Settlement requires a successful mainnet receipt." };
  }
  return { ok: true, args: { p_key: key, p_tx: evidence.txHash } };
}
