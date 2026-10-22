import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { considerCitizenCommerce, settleCommerceText, type CommerceCitizen } from "@/lib/ai/citizen-commerce";

const citizens: CommerceCitizen[] = [
  {
    tokenId: "104",
    name: "Chog #104",
    citizenId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    wallet: "0x238797c75Ad0423516F84D917B7A9d765831bf02",
    missing: ["trade", "return"],
  },
  {
    tokenId: "7",
    name: "Chog #7",
    citizenId: "cccccccc-dddd-4eee-8fff-000000000000",
    wallet: "0x238797c75Ad0423516F84D917B7A9d765831bf02",
    missing: ["trade"],
  },
];

describe("citizen commerce", () => {
  it("keeps the model's reason only when it names that citizen and has no URL", () => {
    const text = JSON.stringify({
      citizens: [
        { tokenId: "104", tradeRationale: "The east market still has open stalls.", returnRationale: "Surplus MON should go back to ChogBank." },
        { tokenId: "7", tradeRationale: "See https://evil.test", returnRationale: "" },
      ],
    });
    const settled = settleCommerceText(text, citizens);
    expect(settled.get("104")).toEqual({
      trade: { text: "The east market still has open stalls.", fromModel: true },
      returnToBank: { text: "Surplus MON should go back to ChogBank.", fromModel: true },
    });
    expect(settled.get("7")?.trade.fromModel).toBe(false);
    expect(settled.get("7")?.trade.text).toMatch(/does not broadcast/i);
    expect(settled.get("7")?.returnToBank.text).toMatch(/does not broadcast/i);
  });

  it("records a trade and a return with reasons and does not broadcast", async () => {
    const rows: Array<{ purpose: string; rationale: string; fromModel: boolean }> = [];
    const result = await considerCitizenCommerce({
      citizens,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => ({
        provider: "gemini",
        model: "test",
        text: JSON.stringify({
          citizens: [{ tokenId: "104", tradeRationale: "Trade the spare tools.", returnRationale: "Return the spare MON." }],
        }),
        promptChars: 20,
        outputTokens: 10,
      }),
      record: async (row) => {
        rows.push({ purpose: row.purpose, rationale: row.rationale, fromModel: row.fromModel });
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(result.detail).toMatch(/No transaction was broadcast/);
    expect(rows).toEqual([
      { purpose: "citizen_trade", rationale: "Trade the spare tools.", fromModel: true },
      { purpose: "citizen_return", rationale: "Return the spare MON.", fromModel: true },
      { purpose: "citizen_trade", rationale: expect.stringMatching(/Chog #7/), fromModel: false },
    ]);
  });

  it("does not invent a trade when the model is not called", async () => {
    let recorded = false;
    const result = await considerCitizenCommerce({
      citizens: citizens.slice(0, 1),
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: null,
      record: async () => {
        recorded = true;
        return true;
      },
    });
    expect(result.status).toBe("skipped");
    expect(recorded).toBe(false);
  });

  it("stores a policy reason when the model call fails", async () => {
    const rows: string[] = [];
    const result = await considerCitizenCommerce({
      citizens: citizens.slice(0, 1),
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => {
        throw new Error("model unavailable");
      },
      record: async (row) => {
        rows.push(row.rationale);
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(rows[0]).toMatch(/does not broadcast/i);
    expect(rows[1]).toMatch(/does not broadcast/i);
  });

  it("leaves the growth prompt unchanged and keeps signing out of the runner", () => {
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    expect(runner).toContain("storeCitizenCommerce");
    expect(runner).toContain("publishStoredAiActivity");
    expect(runner).toContain("deploymentPathReady: false");
    expect(runner).not.toMatch(/sendTransaction|signTypedData|walletClient|eth_sendRawTransaction/);
    expect(readFileSync("src/lib/ai/context.ts", "utf8")).toContain(
      "Do not return propose_economy or request_wallet_activation. This decision cannot move money, approve funding, or deploy a wallet.",
    );
    expect(readFileSync("src/lib/ai/citizen-commerce-db.ts", "utf8")).not.toMatch(/sendTransaction|signTypedData|privateKey/);
  });
});
