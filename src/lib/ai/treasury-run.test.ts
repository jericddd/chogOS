import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { pendingPayoutFromOutput } from "@/lib/chogbank/payout";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import { considerTreasuryAllocation, type TreasuryDecisionInsert } from "@/lib/ai/treasury-run";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";

const roster = [{ tokenId: "104", name: "CHOG #104", goal: "Finish the east road", citizenId: "citizen-104" }];
const BALANCE = 30n * 10n ** 18n;

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
      factIds: ["citizen:104:goal"],
    });
    const first = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
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
    expect(rows[0]?.output.publicState).toBe("approved_awaiting_execution");
    expect(rows[0]?.output.direction).toBe("chogbank_to_citizen");
    expect(rows[0]?.output.factIds).toEqual(["citizen:104:goal"]);
    expect(rows[0]?.output.factSummaries.join(" ")).toContain("Finish the east road");
    expect(JSON.stringify(rows[0]?.output)).not.toContain("recipient");
    const payable = pendingPayoutFromOutput(rows[0]?.output ?? {});
    expect(payable?.tokenId).toBe("104");
    expect(payable?.asset).toBe("MON");
    expect(payable?.amountRaw).toBe("1000000000000000");

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
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
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
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
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

  it("defers a closed Flash slot without storing an allocation or halting other work", async () => {
    const rows: TreasuryDecisionInsert[] = [];
    let called = false;
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "gemini-3.8-flash",
      complete: async () => {
        called = true;
        throw new AiProviderError("The shared model slot is not open.", "rate_limit", false);
      },
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(called).toBe(true);
    expect(result.status).toBe("skipped");
    expect(result.halt).toBeNull();
    expect(rows).toHaveLength(0);
    expect(result.detail).toMatch(/slot is not open/);
  });

  it("keeps the prompt characters when the database write fails", async () => {
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
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
    expect(runner).toContain("responseSchema: request.responseSchema");
    expect(runner).toContain('accepted.reason === "model output was not JSON"');
    expect(runner.indexOf("await attachTreasury()")).toBeLessThan(runner.indexOf("while (!endRun && !liteClosed)"));
    expect(runner).toContain("Stopped before the host timeout. No treasury allocation was requested.");
    expect(runner).toContain("Citizen wallet code was not read (");
    expect(runner).toContain("No eligible citizen in this review window has a deployed wallet whose stored token id matches, so no allocation was requested.");
    expect(runner).toContain("Citizen MON spending was not read (");
    expect(runner).not.toMatch(/sendTransaction|signTypedData|walletClient|eth_sendRawTransaction/);
    expect(readFileSync("src/lib/ai/context.ts", "utf8")).toContain("Do not return propose_economy or request_wallet_activation");
    expect(readFileSync("src/lib/economy/treasury-load.ts", "utf8")).not.toMatch(/sendTransaction|writeContract|signTypedData/);
    const signer = loadProtectedSigner({ CHOG_BANK_AUTHORIZER_PRIVATE_KEY: "0xabc" });
    expect(signer.kind).toBe("none");
    expect(JSON.stringify(signer)).not.toContain("0xabc");
  });

  it("does not call the model when balances were not read", async () => {
    const complete = vi.fn();
    const recorded: TreasuryDecisionInsert[] = [];
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
      complete,
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(recorded[0]?.status).toBe("failed");
    expect(recorded[0]?.output.executed).toBe(false);
    expect(recorded[0]?.output.txHash).toBeNull();
  });

  it("does not call the model when the MON balance cannot cover a payout", async () => {
    const complete = vi.fn();
    const recorded: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: 0n,
      chogBalance: 1n,
      chogDecimals: 18,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete,
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    expect(recorded[0]?.output.amountRaw).toBeNull();
    expect(recorded[0]?.output.executed).toBe(false);
  });

  it("records a $CHOG proposal as unavailable and does not mark it paid", async () => {
    const recorded: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 10n ** 18n,
      chogDecimals: 18,
      walletDeployed: true,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () =>
        completion(
          JSON.stringify({
            tokenId: "104",
            asset: "CHOG",
            amountRaw: "1",
            reason: "A token gift.",
            expectedOutcome: "The citizen receives $CHOG.",
          }),
        ),
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.detail).toContain("not available");
    expect(recorded[0]?.output.executed).toBe(false);
    expect(recorded[0]?.output.onchain).toBe(false);
    expect(recorded[0]?.output.txHash).toBeNull();
  });

  it("repairs one fenced proposal without a second model call", async () => {
    const complete = vi.fn(async () =>
      completion(
        "```json\n" +
          JSON.stringify({
            tokenId: "104",
            asset: "MON",
            amountRaw: "1000000000000000",
            reason: "The east road still needs fare.",
            expectedOutcome: "One work trip can be paid.",
            factIds: ["citizen:104:goal"],
          }) +
          "\n```",
      ),
    );
    const recorded: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete,
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const firstCall = (complete.mock.calls as unknown[][])[0]?.[0] as { responseSchema?: { type?: string } };
    expect(firstCall.responseSchema).toMatchObject({ type: "object" });
    expect(result.status).toBe("proposed");
    expect(recorded[0]?.output.tokenId).toBe("104");
    expect(recorded[0]?.output.executed).toBe(false);
    expect(recorded[0]?.output.txHash).toBeNull();
    expect(pendingPayoutFromOutput(recorded[0]?.output ?? {})?.amountRaw).toBe("1000000000000000");
  });

  it("retries one unreadable proposal and does not pay when the retry is also unreadable", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion("I think Chog 104 should get some money."))
      .mockResolvedValueOnce(completion("Still not an object."));
    const recorded: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
      timeoutMs: 5_000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete,
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("rejected");
    expect(result.detail).toBe("The treasury proposal was not JSON.");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: "rejected",
      citizenId: null,
      output: { tokenId: null, amountRaw: null, executed: false, onchain: false, txHash: null },
    });
    expect(recorded[0]?.output.replyShape).toContain("prefix=prose");
    expect(pendingPayoutFromOutput(recorded[0]?.output ?? {})).toBeNull();
    expect(result.modelCalls).toBe(2);
  });

  it("does not spend a second model call when the slot cannot hold a retry", async () => {
    const complete = vi.fn(async () => completion("not json"));
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
      timeoutMs: 1_000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete,
      record: async () => true,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.modelCalls).toBe(1);
    expect(result.status).toBe("rejected");
    expect(result.detail).toBe("The treasury proposal was not JSON.");
  });

  it("accepts the bounded retry when the second reply is a real proposal", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion("not json"))
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            tokenId: "104",
            asset: "MON",
            amountRaw: "1000000000000000",
            reason: "The east road still needs fare.",
            expectedOutcome: "One work trip can be paid.",
            factIds: ["citizen:104:goal"],
          }),
        ),
      );
    const recorded: TreasuryDecisionInsert[] = [];
    const result = await considerTreasuryAllocation({
      nowMs: Date.UTC(2026, 9, 21),
      roster,
      prior: [],
      monBalance: BALANCE,
      chogBalance: 1n,
      chogDecimals: 18,
      walletDeployed: true,
      timeoutMs: 5_000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete,
      record: async (row) => {
        recorded.push(row);
        return true;
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("proposed");
    expect(recorded[0]?.citizenId).toBe("citizen-104");
    expect(recorded[0]?.output.replyShape).toBeNull();
    expect(recorded[0]?.output.executed).toBe(false);
  });
});
