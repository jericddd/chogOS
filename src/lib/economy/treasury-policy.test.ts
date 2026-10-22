import { describe, expect, it } from "vitest";
import {
  APPLICATION_TREASURY_LIMITS,
  applyAllocations,
  citizenWalletPayoutGate,
  classifyPayout,
  evaluateProductionTreasuryAllocation,
  evaluateTreasuryAllocation,
  keepFirstDecision,
  productionTreasurySubmission,
  recoveryAction,
  type AllocationDraft,
  type PolicyLimits,
} from "@/lib/economy/treasury-policy";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const ELIGIBLE = new Set(["104", "109"]);

function draft(overrides: Partial<AllocationDraft> = {}): AllocationDraft {
  return {
    tokenId: "104",
    asset: "MON",
    amountRaw: 50_000_000_000_000_000n,
    reason: "The road crew is short of fare for one trip.",
    expectedOutcome: "The citizen can finish the surveyed stretch.",
    ...overrides,
  };
}

function limits(overrides: Partial<PolicyLimits> = {}): PolicyLimits {
  return { ...APPLICATION_TREASURY_LIMITS, ...overrides };
}

describe("ownerless treasury policy", () => {
  it("accepts a review without signing or paying", () => {
    const verdict = evaluateProductionTreasuryAllocation({
      draft: draft(),
      limits: limits(),
      nowMs: NOW,
      eligibleTokenIds: ELIGIBLE,
      spent: [],
      monBalance: 1_000_000_000_000_000_000n,
      chogBalance: null,
      chogDecimals: 18,
    });
    expect(verdict.status).toBe("accepted_not_executed");
    expect(verdict.executed).toBe(false);
    expect(verdict.onchain).toBe(false);
    expect(verdict.reason).toContain("Production signing is disabled");
    expect(verdict.reason).toContain("predicted address");
    expect(productionTreasurySubmission().broadcast).toBe(false);
  });

  it("rejects an arbitrary address, a bad chain, a closed token cap, and unknown decimals", () => {
    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ tokenId: "0xabc" }),
        limits: limits(),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: 1n,
        chogBalance: 1n,
        chogDecimals: 18,
      }).reason,
    ).toContain("token id");

    expect(
      evaluateTreasuryAllocation({
        draft: draft(),
        limits: limits({ chainId: 1 }),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: 1n,
        chogBalance: null,
        chogDecimals: 18,
        walletDeployed: true,
        executionEnabled: true,
      }).status,
    ).toBe("rejected");

    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ asset: "CHOG", amountRaw: 1n }),
        limits: limits(),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: null,
        chogBalance: 10n,
        chogDecimals: null,
      }).reason,
    ).toContain("decimals");

    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ asset: "CHOG", amountRaw: 1n }),
        limits: limits(),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: null,
        chogBalance: 10n,
        chogDecimals: 18,
      }).status,
    ).toBe("accepted_not_executed");
    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ asset: "CHOG", amountRaw: 2n }),
        limits: limits(),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: null,
        chogBalance: 10n,
        chogDecimals: 18,
      }).reason,
    ).toContain("per-transaction");
    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ asset: "CHOG", amountRaw: 1n }),
        limits: limits({ maxPerTxChog: 0n, maxCitizenWindowChog: 0n, maxAggregateWindowChog: 0n }),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: null,
        chogBalance: 10n,
        chogDecimals: 18,
      }).reason,
    ).toContain("closed");

    expect(
      evaluateProductionTreasuryAllocation({
        draft: draft({ asset: "CHOG", amountRaw: 1n }),
        limits: limits({ maxPerTxChog: 5n, maxCitizenWindowChog: 5n, maxAggregateWindowChog: 5n }),
        nowMs: NOW,
        eligibleTokenIds: ELIGIBLE,
        spent: [],
        monBalance: null,
        chogBalance: 10n,
        chogDecimals: 6,
      }).reason,
    ).toContain("18");
  });

  it("enforces per-transaction, per-citizen, aggregate, balance, and duplicate windows", () => {
    const base = {
      limits: limits(),
      nowMs: NOW,
      eligibleTokenIds: ELIGIBLE,
      spent: [],
      chogBalance: null,
      chogDecimals: 18,
      walletDeployed: false,
      executionEnabled: false,
    };
    expect(
      evaluateTreasuryAllocation({ ...base, draft: draft({ amountRaw: APPLICATION_TREASURY_LIMITS.maxPerTxMon + 1n }), monBalance: 10n ** 18n }).status,
    ).toBe("budget_exhausted");

    const first = evaluateTreasuryAllocation({
      ...base,
      draft: draft({ amountRaw: APPLICATION_TREASURY_LIMITS.maxPerTxMon }),
      monBalance: 10n ** 18n,
    });
    expect(first.status).toBe("accepted_not_executed");
    expect(
      evaluateTreasuryAllocation({
        ...base,
        draft: draft({ amountRaw: 5n }),
        limits: limits({ maxPerTxMon: 10n, maxCitizenWindowMon: 4n, maxAggregateWindowMon: 10n }),
        monBalance: 10n,
      }).reason,
    ).toContain("per-citizen");
    expect(
      evaluateTreasuryAllocation({
        ...base,
        draft: draft({ amountRaw: 1n }),
        monBalance: 10n ** 18n,
        spent: [
          {
            decisionId: first.decisionId ?? "0x",
            tokenId: "104",
            asset: "MON",
            amountRaw: APPLICATION_TREASURY_LIMITS.maxCitizenWindowMon,
            windowId: first.windowId ?? "",
          },
        ],
      }).status,
    ).toBe("duplicate");

    expect(
      evaluateTreasuryAllocation({
        ...base,
        draft: draft({ amountRaw: 1n }),
        monBalance: 0n,
      }).status,
    ).toBe("insufficient_funds");
  });

  it("does not pay the same proposal twice when two runs overlap", () => {
    const results = applyAllocations({
      drafts: [
        draft({ amountRaw: 1_500_000_000_000_000_000n }),
        draft({ amountRaw: 1_500_000_000_000_000_000n }),
        draft({ tokenId: "109", amountRaw: 1_000_000_000_000_000_000n }),
      ],
      limits: limits({
        maxPerTxMon: 2_000_000_000_000_000_000n,
        maxCitizenWindowMon: 2_000_000_000_000_000_000n,
        maxAggregateWindowMon: 2_000_000_000_000_000_000n,
      }),
      nowMs: NOW,
      eligibleTokenIds: ELIGIBLE,
      monBalance: 2_000_000_000_000_000_000n,
      chogBalance: null,
      chogDecimals: 18,
      walletDeployed: true,
      executionEnabled: true,
    });
    expect(results[0]?.status).toBe("ready_for_signature");
    expect(results[0]?.executed).toBe(false);
    expect(results[1]?.status).toBe("duplicate");
    expect(results[2]?.status).toBe("budget_exhausted");
  });

  it("keeps a reverted or eventless receipt from becoming a payout and reconciles a crash", () => {
    const decisionId = "0x" + "ab".repeat(32);
    expect(classifyPayout({ status: "reverted", chainId: 143, txHash: `0x${"11".repeat(32)}`, blockNumber: "1", distributedDecisionIds: [decisionId] }, decisionId).payout).toBe(false);
    expect(
      classifyPayout(
        { status: "success", chainId: 143, txHash: `0x${"11".repeat(32)}`, blockNumber: "9", distributedDecisionIds: [] },
        decisionId,
      ).reason,
    ).toContain("not a payout");
    const confirmed = classifyPayout(
      { status: "success", chainId: 143, txHash: `0x${"22".repeat(32)}`, blockNumber: "10", distributedDecisionIds: [decisionId] },
      decisionId,
    );
    expect(confirmed).toMatchObject({ status: "confirmed", payout: true, duplicate: false });
    const again = classifyPayout(
      { status: "success", chainId: 143, txHash: `0x${"22".repeat(32)}`, blockNumber: "10", distributedDecisionIds: [decisionId] },
      decisionId,
      true,
    );
    expect(again.duplicate).toBe(true);
    expect(again.payout).toBe(true);
    expect(classifyPayout({ status: "success", chainId: 1, txHash: `0x${"22".repeat(32)}`, blockNumber: "10", distributedDecisionIds: [decisionId] }, decisionId).status).toBe("failed");
    const recovered = classifyPayout(
      { status: "success", chainId: 143, txHash: `0x${"22".repeat(32)}`, blockNumber: "10", distributedDecisionIds: [decisionId] },
      decisionId,
      false,
    );
    expect(recoveryAction(recovered, "absent")).toBe("record_confirmation");
    expect(recoveryAction(recovered, "confirmed")).toBe("leave_recorded");
    expect(recoveryAction(classifyPayout({ status: "reverted", chainId: 143, txHash: `0x${"11".repeat(32)}`, blockNumber: "1", distributedDecisionIds: [] }, decisionId), "absent")).toBe(
      "do_not_record_as_payout",
    );
  });

  it("keeps one admission when two reviews race", () => {
    const input = {
      draft: draft(),
      limits: limits(),
      nowMs: NOW,
      eligibleTokenIds: ELIGIBLE,
      spent: [],
      monBalance: 10n ** 18n,
      chogBalance: null,
      chogDecimals: 18,
    };
    const first = evaluateProductionTreasuryAllocation(input);
    const second = evaluateProductionTreasuryAllocation(input);
    expect(first.status).toBe("accepted_not_executed");
    expect(second.status).toBe("accepted_not_executed");
    const [kept, dropped] = keepFirstDecision([first, second]);
    expect(kept?.status).toBe("accepted_not_executed");
    expect(dropped?.status).toBe("duplicate");
    expect(dropped?.executed).toBe(false);
  });

  it("refuses a missing or mismatched wallet even when execution flags are on", () => {
    const wallet = "0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502";
    expect(citizenWalletPayoutGate({ codeBytes: 0, wallet, identityMatches: false }).state).toBe("missing");
    expect(citizenWalletPayoutGate({ codeBytes: 100, wallet, identityMatches: false }).state).toBe("inconsistent");
    expect(citizenWalletPayoutGate({ codeBytes: null, wallet, identityMatches: null }).state).toBe("unread");
    expect(citizenWalletPayoutGate({ codeBytes: 100, wallet, identityMatches: true }).state).toBe("ready");

    const mismatched = evaluateTreasuryAllocation({
      draft: draft(),
      limits: limits(),
      nowMs: NOW,
      eligibleTokenIds: ELIGIBLE,
      spent: [],
      monBalance: 10n ** 18n,
      chogBalance: null,
      chogDecimals: 18,
      walletDeployed: true,
      executionEnabled: true,
      walletObservation: { codeBytes: 100, wallet, identityMatches: false },
    });
    expect(mismatched.status).toBe("rejected");
    expect(mismatched.executed).toBe(false);
    expect(mismatched.reason).toContain("not the wallet");
  });
});
