import { describe, expect, it } from "vitest";
import { parseTreasuryProposal, settleTreasuryText, treasuryMessages, monPayoutRoom, TREASURY_UNREADABLE } from "@/lib/ai/treasury-decision";
import { CHAIN_CHOG_CAP, CHAIN_MON_AGGREGATE, CHAIN_MON_CITIZEN, CHAIN_MON_PER_TX } from "@/lib/chogbank/bank";

const roster = [{ tokenId: "104", name: "CHOG #104", goal: "Finish the east road" }];
const BALANCE = 30n * 10n ** 18n;
const facts = {
  monBalance: BALANCE,
  monPerTx: CHAIN_MON_PER_TX,
  monCitizen: CHAIN_MON_CITIZEN,
  monAggregate: CHAIN_MON_AGGREGATE,
  monSpentInWindow: 0n,
  chogCap: CHAIN_CHOG_CAP,
};

describe("treasury proposals from the mind", () => {
  it("asks for a token id and refuses address fields", () => {
    const messages = treasuryMessages(roster, facts);
    expect(messages.user).toContain("Finish the east road");
    expect(messages.user).toContain(BALANCE.toString(10));
    expect(messages.system).toContain("must be MON");
    expect(monPayoutRoom(facts)).toBe(CHAIN_MON_PER_TX);
    expect(messages.system).toContain("not a payment");
    expect(messages.user).toContain("citizen:104:goal");
    expect(messages.system).toContain("factIds");
    expect(messages.system).toContain("Do not name an address");
    expect(messages.user).toContain("104");
    expect(messages.user).not.toContain("0x");
    const rejected = parseTreasuryProposal(
      JSON.stringify({ tokenId: "104", asset: "MON", amountRaw: "1", reason: "fare", expectedOutcome: "one trip", recipient: "0x0000000000000000000000000000000000000001" }),
      new Set(["104"]),
    );
    expect(rejected.ok).toBe(false);
  });

  it("settles a valid proposal as not executed and ignores a second copy", () => {
    const text = JSON.stringify({
      tokenId: "104",
      asset: "MON",
      amountRaw: "1000000000000000",
      reason: "The east road still needs fare.",
      expectedOutcome: "One work trip can be paid.",
      factIds: ["citizen:104:goal"],
    });
    const first = settleTreasuryText({
      text,
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
    });
    expect(first.verdict.status).toBe("accepted_not_executed");
    expect(first.verdict.executed).toBe(false);
    expect(first.verdict.onchain).toBe(false);
    const second = settleTreasuryText({
      text,
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [
        {
          decisionId: first.verdict.decisionId ?? "",
          tokenId: "104",
          asset: "MON",
          amountRaw: 1000000000000000n,
          windowId: first.verdict.windowId ?? "",
        },
      ],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
    });
    expect(second.verdict.status).toBe("duplicate");
    expect(second.verdict.executed).toBe(false);
  });

  it("rejects an oversized MON proposal instead of storing a smaller payment", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "MON",
        amountRaw: "1000000000000000000",
        reason: "The east road still needs fare.",
        expectedOutcome: "One work trip can be paid.",
        factIds: ["citizen:104:goal"],
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
    });
    expect(settled.verdict.status).toBe("budget_exhausted");
    expect(settled.verdict.executed).toBe(false);
    expect(settled.verdict.onchain).toBe(false);
    expect(settled.draft?.amountRaw).toBe(1_000_000_000_000_000_000n);
  });

  it("rejects $CHOG while the deployed cap is 1 wei", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "CHOG",
        amountRaw: "1",
        reason: "A token gift.",
        expectedOutcome: "The citizen receives $CHOG.",
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: BALANCE,
      chogBalance: 10n ** 18n,
      chogDecimals: 18,
    });
    expect(settled.verdict.status).toBe("rejected");
    expect(settled.verdict.executed).toBe(false);
    expect(settled.verdict.reason).toContain("not available");
  });

  it("records a deliberate refusal without turning it into a payment", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({ allocate: false, reason: "The storehouse can cover this week." }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: 1n,
      chogBalance: null,
      chogDecimals: 18,
    });
    expect(settled.draft).toBeNull();
    expect(settled.verdict.executed).toBe(false);
    expect(settled.verdict.reason).toContain("storehouse");
  });

  it("rejects a proposal when the citizen wallet was not observed", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "MON",
        amountRaw: "1000000000000000",
        reason: "The east road still needs fare.",
        expectedOutcome: "One work trip can be paid.",
        factIds: ["citizen:104:goal"],
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
    });
    expect(settled.verdict.status).toBe("rejected");
    expect(settled.verdict.executed).toBe(false);
    expect(settled.verdict.onchain).toBe(false);
    expect(settled.verdict.decisionId).toBeNull();
    expect(settled.verdict.reason).toContain("deployed citizen wallet");
  });

  it("rejects a MON amount above the balance that was read", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "MON",
        amountRaw: "2",
        reason: "The east road still needs fare.",
        expectedOutcome: "One work trip can be paid.",
        factIds: ["citizen:104:goal"],
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: 1n,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
    });
    expect(settled.verdict.status).toBe("insufficient_funds");
    expect(settled.verdict.executed).toBe(false);
  });

  it("rejects a MON amount when the balance was not read", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "MON",
        amountRaw: "1",
        reason: "The east road still needs fare.",
        expectedOutcome: "One work trip can be paid.",
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: null,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
    });
    expect(settled.verdict.status).toBe("rejected");
    expect(settled.verdict.reason).toContain("not read");
    expect(settled.verdict.executed).toBe(false);
  });

  it("rejects a payout that does not cite a stored fact", () => {
    const settled = settleTreasuryText({
      text: JSON.stringify({
        tokenId: "104",
        asset: "MON",
        amountRaw: "1000000000000000",
        reason: "The east road still needs fare.",
        expectedOutcome: "One work trip can be paid.",
        factIds: ["project:made-up"],
      }),
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
    });
    expect(settled.verdict.status).toBe("rejected");
    expect(settled.verdict.reason).toMatch(/was not in this review/i);
    expect(settled.draft).toBeNull();
    expect(settled.verdict.executed).toBe(false);
    expect(settled.verdict.decisionId).toBeNull();
  });

  it("reads a fenced or comma-repaired proposal and refuses prose that is not an allocation", () => {
    const fields = {
      tokenId: "104",
      asset: "MON",
      amountRaw: "1000000000000000",
      reason: "The east road still needs fare.",
      expectedOutcome: "One work trip can be paid.",
      factIds: ["citizen:104:goal"],
    };
    const fenced = parseTreasuryProposal(`Here is the proposal:\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``, new Set(["104"]));
    expect(fenced.ok && fenced.draft?.tokenId).toBe("104");
    const comma = parseTreasuryProposal(`{ "tokenId": "104", "asset": "MON", "amountRaw": "1000000000000000", "reason": "The east road still needs fare.", "expectedOutcome": "One work trip can be paid.", }`, new Set(["104"]));
    expect(comma.ok && comma.draft?.amountRaw).toBe(1000000000000000n);
    const numeric = parseTreasuryProposal(
      JSON.stringify({ ...fields, amountRaw: 1000 }),
      new Set(["104"]),
    );
    expect(numeric.ok && numeric.draft?.amountRaw).toBe(1000n);
    const prose = parseTreasuryProposal("Send some MON to the next citizen.", new Set(["104"]));
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.reason).toBe(TREASURY_UNREADABLE);
    const quoted = parseTreasuryProposal("{'tokenId': '104', 'asset': 'MON'}", new Set(["104"]));
    expect(quoted.ok).toBe(false);
  });
});
