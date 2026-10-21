import { readFileSync } from "node:fs";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { AI_ISSUED_SCHEME, walletControlFollowsNftOwner } from "@/lib/wallets/authority";
import { presentCitizenWallet } from "@/lib/wallets/present";
import {
  ISSUANCE_DECISION_LABEL,
  evaluateIssuanceDecision,
  issuanceDecisionId,
  lifecycleFromWalletStatus,
} from "@/lib/wallets/issuance";

const eligible = new Set(["104", "129"]);

function decide(
  patch: Partial<Parameters<typeof evaluateIssuanceDecision>[0]> = {},
): ReturnType<typeof evaluateIssuanceDecision> {
  return evaluateIssuanceDecision({
    choice: "issue",
    tokenId: "104",
    rationale: "This citizen needs a purse for the east road.",
    eligibleTokenIds: eligible,
    lifecycleByToken: new Map(),
    admittedDecisionIds: new Set(),
    deploymentPathReady: false,
    ...patch,
  });
}

describe("permanent citizen identity", () => {
  it("treats a citizen with no wallet row as active", () => {
    expect(lifecycleFromWalletStatus(null)).toBe("citizen_active");
    expect(lifecycleFromWalletStatus("not_configured")).toBe("citizen_active");
    const view = presentCitizenWallet({
      citizenId: "citizen-104",
      assignment: null,
      persistence: "ready",
      issuance: null,
    });
    expect(view.address).toBeNull();
    expect(view.note).toMatch(/active without one/i);
    const configured = presentCitizenWallet({
      citizenId: "citizen-104",
      persistence: "ready",
      assignment: {
        citizenId: "citizen-104",
        chainId: 143,
        scheme: "unassigned",
        status: "not_configured",
        predictedAddress: null,
        accountAddress: null,
      },
      issuance: null,
    });
    expect(configured.address).toBeNull();
    expect(configured.note).toMatch(/active without a wallet/i);
    expect(view.issuanceText).toMatch(/no wallet-issuance decision is recorded/i);
    expect(view.authority).toMatch(/not by the NFT holder/i);
  });

  it("does not let the NFT holder control the AI-issued scheme", () => {
    expect(walletControlFollowsNftOwner(AI_ISSUED_SCHEME)).toBe(false);
    expect(walletControlFollowsNftOwner("unassigned")).toBe(false);
    expect(walletControlFollowsNftOwner("nft_bound_v1")).toBe(true);
  });

  it("keeps one decision id per token and does not publish an address", () => {
    const first = issuanceDecisionId("104");
    const again = issuanceDecisionId("104");
    const other = issuanceDecisionId("129");
    const independent = keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
        [ISSUANCE_DECISION_LABEL, 143n, addresses.chogGenesis, 104n],
      ),
    );
    expect(first).toBe(again);
    expect(first).toBe(independent);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("AI wallet issuance policy", () => {
  it("can defer and can call a wallet unnecessary without assigning an address", () => {
    const deferred = decide({ choice: "defer" });
    expect(deferred.status).toBe("proposed");
    expect(deferred.lifecycle).toBe("citizen_active");
    expect(deferred.decisionId).toBeNull();
    expect(deferred.executed).toBe(false);
    const unnecessary = decide({ choice: "unnecessary", tokenId: null, rationale: "Nobody needs a purse this week." });
    expect(unnecessary.status).toBe("proposed");
    expect(unnecessary.decisionId).toBeNull();
    expect(unnecessary.lifecycle).toBe("citizen_active");
  });

  it("proposes one issuance and rejects a second without creating another wallet", () => {
    const first = decide();
    expect(first.status).toBe("proposed");
    expect(first.lifecycle).toBe("wallet_issuance_proposed");
    expect(first.executed).toBe(false);
    expect(first.onchain).toBe(false);
    expect(first.reason).toMatch(/no address was assigned/i);
    const second = decide({ admittedDecisionIds: new Set([first.decisionId!.toLowerCase()]) });
    expect(second.status).toBe("rejected");
    expect(second.duplicate).toBe(true);
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.executed).toBe(false);
    const concurrent = decide();
    expect(concurrent.decisionId).toBe(first.decisionId);
  });

  it("does not reassign a wallet that is already assigned, deployed, ready, or blocked", () => {
    for (const lifecycle of ["wallet_assigned", "wallet_deployed", "wallet_ready"] as const) {
      const verdict = decide({ lifecycleByToken: new Map([["104", lifecycle]]) });
      expect(verdict.status).toBe("rejected");
      expect(verdict.lifecycle).toBe(lifecycle);
      expect(verdict.decisionId).toBeNull();
    }
    const blocked = decide({ lifecycleByToken: new Map([["104", "wallet_blocked"]]) });
    expect(blocked.lifecycle).toBe("wallet_blocked");
    expect(blocked.status).toBe("rejected");
  });

  it("does not mark a wallet deployed when the factory path is not ready", () => {
    const ready = decide({ deploymentPathReady: true });
    expect(ready.lifecycle).toBe("wallet_issuance_proposed");
    expect(ready.reason).toMatch(/does not sign or create/i);
    expect(ready.executed).toBe(false);
    const view = presentCitizenWallet({
      citizenId: "citizen-104",
      persistence: "ready",
      assignment: {
        citizenId: "citizen-104",
        chainId: 143,
        scheme: "ai_issued_v3",
        status: "address_predicted",
        predictedAddress: "0x1111111111111111111111111111111111111111",
        accountAddress: null,
      },
      issuance: {
        choice: "issue",
        lifecycle: "wallet_assigned",
        rationale: "Predicted only.",
        decisionId: issuanceDecisionId("104"),
      },
    });
    expect(view.addressLabel).toBe("Predicted address");
    expect(view.note).toMatch(/not a deployed account/i);
    expect(view.issuanceText).toMatch(/not a deployed account/i);
  });

  it("rejects a token that is not enrolled and a rationale that contains a URL", () => {
    expect(decide({ tokenId: "999" }).status).toBe("rejected");
    expect(decide({ rationale: "See https://example.test" }).reason).toMatch(/URL/i);
  });

  it("adds the scheme without inserting a wallet", () => {
    const sql = readFileSync("supabase/migrations/20261021160000_ai_issued_wallet.sql", "utf8");
    expect(sql).toContain("ai_issued_v3");
    expect(sql).toContain("nft_bound_v1");
    expect(sql).not.toMatch(/insert\s+into/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
  });
});
