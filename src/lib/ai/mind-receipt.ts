import { confirmedPayoutReason } from "@/lib/chogbank/payout-reason";

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * The stored economic sentence for one treasury decision, only when that
 * decision's own output is a verified chain-143 receipt. Policy text stays
 * on the decision when this returns null.
 */
export function confirmedDecisionReceipt(
  purpose: string,
  output: Record<string, unknown> | null,
): { reason: string; txHash: string } | null {
  if (purpose !== "treasury_allocation" || !output) return null;
  const txHash = typeof output.txHash === "string" ? output.txHash.toLowerCase() : "";
  if (!HASH.test(txHash)) return null;
  const chainId = typeof output.chainId === "number" ? output.chainId : null;
  const reason = confirmedPayoutReason({
    kind: "treasury.paid",
    chainStatus: "confirmed",
    chainId,
    txHash,
    output,
  });
  if (!reason) return null;
  return { reason, txHash };
}
