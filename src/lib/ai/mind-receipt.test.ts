import { describe, expect, it } from "vitest";
import { confirmedDecisionReceipt } from "@/lib/ai/mind-receipt";
import { treasuryReasonHash } from "@/lib/economy/treasury-policy";

const TX = `0x${"ab".repeat(32)}`;
const REASON = "Citizen aims to meet neighbours at the square and requires funds for social engagement.";

function output(overrides: Record<string, unknown> = {}) {
  return {
    reason: REASON,
    verified: true,
    onchain: true,
    chainId: 143,
    txHash: TX,
    reasonHash: treasuryReasonHash(REASON),
    ...overrides,
  };
}

describe("confirmed decision receipt", () => {
  it("returns the stored economic sentence only for a verified treasury receipt", () => {
    expect(confirmedDecisionReceipt("treasury_allocation", output())).toEqual({ reason: REASON, txHash: TX });
  });

  it("keeps a policy sentence off the receipt", () => {
    const policy = "Production signing is disabled. This record is not a signature and not a payment.";
    expect(confirmedDecisionReceipt("treasury_allocation", output({ reason: policy, reasonHash: treasuryReasonHash(policy) }))).toBeNull();
    expect(confirmedDecisionReceipt("treasury_allocation", output({ verified: false }))).toBeNull();
    expect(confirmedDecisionReceipt("treasury_allocation", output({ onchain: false }))).toBeNull();
    expect(confirmedDecisionReceipt("treasury_allocation", output({ reasonHash: `0x${"11".repeat(32)}` }))).toBeNull();
    expect(confirmedDecisionReceipt("citizen_turn", output())).toBeNull();
    expect(confirmedDecisionReceipt("treasury_allocation", null)).toBeNull();
  });
});
