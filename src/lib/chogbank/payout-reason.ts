import type { Hex } from "viem";
import { treasuryReasonHash } from "@/lib/economy/treasury-policy";

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * Policy text is a security status. It is not the sentence hashed into a ChogBank allocation.
 * A match here means the stored words cannot be shown or signed as the payout reason.
 */
const POLICY_REASON = /production signing is disabled|not a signature|not a payment|nothing was signed|no transaction was broadcast/i;

export function economicPayoutReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason || reason.length > 320 || /https?:\/\//i.test(reason)) return null;
  if (POLICY_REASON.test(reason)) return null;
  return reason;
}

/**
 * The citizen-page reason for one confirmed payout.
 * Returns the stored economic sentence only when this row is a verified chain-143 receipt
 * and, when a Distributed reason hash is known, that hash matches the sentence.
 * A policy sentence, a missing sentence, or an unverified transaction returns null.
 */
export function confirmedPayoutReason(input: {
  kind: string;
  chainStatus: string | null;
  chainId: number | null;
  txHash: string | null;
  output: Record<string, unknown> | null;
  reasonHash?: string | null;
}): string | null {
  if (input.kind !== "treasury.paid") return null;
  if (input.chainStatus !== "confirmed" || input.chainId !== 143) return null;
  const shown = input.txHash?.toLowerCase() ?? "";
  if (!HASH.test(shown)) return null;
  const output = input.output;
  if (!output || output.verified !== true || output.onchain !== true || output.chainId !== 143) return null;
  const storedTx = typeof output.txHash === "string" ? output.txHash.toLowerCase() : "";
  if (storedTx !== shown) return null;
  const reason = economicPayoutReason(output.reason);
  if (!reason) return null;
  const hashedRaw = input.reasonHash ?? (typeof output.reasonHash === "string" ? output.reasonHash : null);
  if (hashedRaw) {
    const hashed = hashedRaw.toLowerCase();
    if (!HASH.test(hashed) || hashed !== treasuryReasonHash(reason).toLowerCase()) return null;
  }
  return reason;
}

export function readManualDecisionId(
  raw: string | undefined,
): { decisionId: Hex } | { idle: string } | { error: string } {
  if (raw == null || raw.trim() === "") {
    return { idle: "Unattended ChogBank payouts are off. Nothing was signed." };
  }
  const decisionId = raw.trim().toLowerCase();
  if (!HASH.test(decisionId)) {
    return { error: "Enter one stored decision id, 0x and 64 hex characters. Nothing was signed." };
  }
  return { decisionId: decisionId as Hex };
}
