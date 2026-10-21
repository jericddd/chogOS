import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import { considerTreasuryAllocation, type TreasuryDecisionInsert } from "@/lib/ai/treasury-run";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";

const roster = [{ tokenId: "104", name: "CHOG #104", goal: "Finish the east road", citizenId: "citizen-104" }];

function completion(text: string): AiCompletion {
  return { provider: "gemini", model: "test", text, promptChars: 40, outputTokens: 8 };
}

describe("treasury consideration", () => {
  it("does not call the model when prior history cannot be read", async () => {
    let called = false;
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: null,
      monBalance: null,
      chogBalance: null,
      chogDecimals: null,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => {
        called = true;
        return completion("{}");
      },
      record: async () => true,
    });
    expect(called).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.promptChars).toBe(0);
  });

  it("records a proposal as not executed and refuses a second copy", async () => {
    const rows: TreasuryDecisionInsert[] = [];
    const text = JSON.stringify({
      tokenId: "104",
      asset: "MON",
      amountRaw: "1000000000000000",
      reason: "The east road still needs fare.",
      expectedOutcome: "One work trip can be paid.",
    });
    const first = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: null,
      chogBalance: null,
      chogDecimals: 18,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => completion(text),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(first.status).toBe("proposed");
    expect(rows[0]?.output.executed).toBe(false);
    expect(rows[0]?.output.onchain).toBe(false);
    expect(rows[0]?.output.txHash).toBeNull();
    expect(rows[0]?.citizenId).toBe("citizen-104");
    expect(rows[0]?.output.tokenId).toBe("104");
    expect(JSON.stringify(rows[0]?.output)).not.toContain("recipient");

    const second = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [
        {
          decisionId: rows[0]?.output.decisionId ?? "",
          tokenId: "104",
          asset: "MON",
          amountRaw: 1000000000000000n,
          windowId: rows[0]?.output.windowId ?? "",
        },
      ],
      monBalance: null,
      chogBalance: null,
      chogDecimals: 18,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => completion(text),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(second.status).toBe("rejected");
    expect(rows[1]?.output.executed).toBe(false);
  });

  it("halts on a provider quota error and still stores no payment", async () => {
    const rows: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: null,
      chogBalance: null,
      chogDecimals: null,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => {
        throw new AiProviderError("quota", "quota", true);
      },
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(result.status).toBe("halt");
    expect(result.halt?.reason).toBe("quota");
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.output.executed).toBe(false);
    expect(result.promptChars).toBe(0);
  });

  it("keeps the prompt characters when the database write fails", async () => {
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: null,
      chogBalance: null,
      chogDecimals: null,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () =>
        completion(JSON.stringify({ allocate: false, reason: "The storehouse can cover this week." })),
      record: async () => false,
    });
    expect(result.status).toBe("failed");
    expect(result.promptChars).toBe(40);
    expect(result.detail).toContain("database");
  });

  it("leaves signing and broadcasting out of the mind runner", () => {
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    expect(runner).toContain("considerTreasuryAllocation");
    expect(runner).not.toMatch(/sendTransaction|signTypedData|walletClient|eth_sendRawTransaction/);
    expect(readFileSync("src/lib/ai/context.ts", "utf8")).toContain("Do not return propose_economy or request_wallet_activation");
    expect(readFileSync("src/lib/economy/treasury-load.ts", "utf8")).not.toMatch(/sendTransaction|writeContract|signTypedData/);
    const signer = loadProtectedSigner({ CHOG_BANK_AUTHORIZER_PRIVATE_KEY: "0xabc" });
    expect(signer.kind).toBe("none");
    expect(JSON.stringify(signer)).not.toContain("0xabc");
  });
});
