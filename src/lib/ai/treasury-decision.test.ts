import { describe, expect, it } from "vitest";
import { parseTreasuryProposal, settleTreasuryText, treasuryMessages } from "@/lib/ai/treasury-decision";

const roster = [{ tokenId: "104", name: "CHOG #104", goal: "Finish the east road" }];

describe("treasury proposals from the mind", () => {
  it("asks for a token id and refuses address fields", () => {
    const messages = treasuryMessages(roster);
    expect(messages.system).toContain("not a payment");
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
    });
    const first = settleTreasuryText({
      text,
      roster,
      nowMs: Date.UTC(2026, 9, 21),
      spent: [],
      monBalance: null,
      chogBalance: null,
      chogDecimals: 18,
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
      monBalance: null,
      chogBalance: null,
      chogDecimals: 18,
    });
    expect(second.verdict.status).toBe("duplicate");
    expect(second.verdict.executed).toBe(false);
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
});
