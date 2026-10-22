import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { considerWalletIssuance, parseWalletIssuance, type WalletIssuanceInsert } from "@/lib/ai/wallet-run";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";
import { issuanceDecisionId } from "@/lib/wallets/issuance";

const roster = [
  { tokenId: "104", name: "CHOG #104", goal: "Finish the east road", lifecycle: "citizen_active" as const, citizenId: "citizen-104" },
];

function completion(text: string): AiCompletion {
  return { provider: "gemini", model: "test", text, promptChars: 40, outputTokens: 8 };
}

describe("wallet issuance consideration", () => {
  it("does not call the model when earlier records cannot be read", async () => {
    let called = false;
    const result = await considerWalletIssuance({
      roster: null,
      admittedDecisionIds: null,
      deploymentPathReady: false,
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
  });

  it("records an issuance proposal as not executed and rejects a duplicate", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const text = JSON.stringify({
      choice: "issue",
      tokenId: "104",
      rationale: "The east road needs a purse before the next fare.",
    });
    const first = await considerWalletIssuance({
      roster,
      admittedDecisionIds: new Set(),
      deploymentPathReady: false,
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
    expect(rows[0]?.output.address).toBeNull();
    expect(rows[0]?.output.lifecycle).toBe("wallet_issuance_proposed");
    expect(rows[0]?.output.decisionId).toBe(issuanceDecisionId("104"));
    expect(rows[0]?.citizenId).toBe("citizen-104");

    const second = await considerWalletIssuance({
      roster,
      admittedDecisionIds: new Set([rows[0]!.output.decisionId!]),
      deploymentPathReady: false,
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
    expect(rows[1]?.output.duplicate).toBe(true);
    expect(rows[1]?.output.decisionId).toBe(rows[0]?.output.decisionId);
    expect(rows[1]?.output.executed).toBe(false);
  });

  it("issues a permanent wallet when the model asks to defer", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const result = await considerWalletIssuance({
      roster,
      admittedDecisionIds: new Set(),
      deploymentPathReady: false,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => completion(JSON.stringify({ choice: "defer", tokenId: "104", rationale: "The storehouse can wait." })),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(rows[0]?.output.choice).toBe("issue");
    expect(rows[0]?.output.decisionId).toBe(issuanceDecisionId("104"));
    expect(rows[0]?.output.executed).toBe(false);
    expect(rows[0]?.output.txHash).toBeNull();
    expect(rows[0]?.output.address).toBeNull();
  });

  it("queues at most five permanent wallets, lowest token id first", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const tokens = ["1911", "7", "52", "86", "89", "91", "97"];
    const result = await considerWalletIssuance({
      roster: tokens.map((tokenId) => ({ tokenId, name: `CHOG #${tokenId}`, goal: null, lifecycle: "citizen_active" as const })),
      admittedDecisionIds: new Set(),
      deploymentPathReady: false,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => completion(JSON.stringify({ choice: "defer", tokenId: null, rationale: "Wait." })),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(rows.map((row) => row.output.tokenId)).toEqual(["7", "52", "86", "89", "91"]);
    expect(rows.every((row) => row.output.choice === "issue" && row.output.executed === false)).toBe(true);
  });

  it("rejects unnecessary after an admitted issuance and does not execute it", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const decisionId = issuanceDecisionId("104");
    const result = await considerWalletIssuance({
      roster: [{ ...roster[0]!, lifecycle: "wallet_issuance_proposed" }],
      admittedDecisionIds: new Set([decisionId.toLowerCase()]),
      deploymentPathReady: false,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () =>
        completion(JSON.stringify({ choice: "unnecessary", tokenId: "104", rationale: "A purse is not needed." })),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(result.status).toBe("rejected");
    expect(rows[0]?.status).toBe("rejected");
    expect(rows[0]?.output.duplicate).toBe(true);
    expect(rows[0]?.output.decisionId).toBe(decisionId);
    expect(rows[0]?.output.lifecycle).toBe("wallet_issuance_proposed");
    expect(rows[0]?.output.executed).toBe(false);
    expect(rows[0]?.output.onchain).toBe(false);
    expect(rows[0]?.output.address).toBeNull();
    expect(rows[0]?.output.txHash).toBeNull();
  });

  it("rejects a model that names an address", () => {
    const parsed = parseWalletIssuance(JSON.stringify({ choice: "issue", tokenId: "104", address: "0x1", rationale: "Pay here." }));
    expect(parsed.ok).toBe(false);
  });

  it("halts on a provider quota error after recording the wallet decision", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const result = await considerWalletIssuance({
      roster,
      admittedDecisionIds: new Set(),
      deploymentPathReady: false,
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
    expect(rows[0]?.output.choice).toBe("issue");
    expect(rows[0]?.output.executed).toBe(false);
    expect(rows[0]?.output.onchain).toBe(false);
    expect(rows[0]?.output.address).toBeNull();
    expect(rows[0]?.output.decisionId).toBe(issuanceDecisionId("104"));
  });

  it("queues a permanent wallet when the model says the citizen does not need one", async () => {
    const rows: WalletIssuanceInsert[] = [];
    const result = await considerWalletIssuance({
      roster: [
        roster[0]!,
        { tokenId: "7", name: "CHOG #7", goal: null, lifecycle: "citizen_active", citizenId: "citizen-7" },
      ],
      admittedDecisionIds: new Set(),
      deploymentPathReady: false,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => completion(JSON.stringify({ choice: "unnecessary", tokenId: null, rationale: "No purse is needed." })),
      record: async (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(rows.map((row) => row.output.tokenId)).toEqual(["7", "104"]);
    expect(rows.every((row) => row.output.choice === "issue" && row.output.executed === false && row.output.txHash === null)).toBe(true);
  });

  it("keeps wallet issuance out of the growth prompt and out of the signer", () => {
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    expect(runner).toContain("considerWalletIssuance");
    expect(runner).toContain("deploymentPathReady: false");
    expect(runner).not.toMatch(/sendTransaction|signTypedData|walletClient|eth_sendRawTransaction/);
    expect(readFileSync("src/lib/ai/context.ts", "utf8")).toContain("Do not return propose_economy or request_wallet_activation");
    const prompt = readFileSync("src/lib/ai/wallet-run.ts", "utf8");
    expect(prompt).not.toMatch(/privateKey|signTypedData|sendTransaction/);
    expect(prompt).toContain("wallet_issuance_proposed");
    expect(prompt).toContain("An open proposal stays until a wallet is assigned.");
    const walletDb = readFileSync("src/lib/ai/wallet-db.ts", "utf8");
    expect(walletDb).toContain("enrollment_status");
    expect(walletDb).toContain("AI_ISSUED_SCHEME");
    expect(walletDb).not.toContain("loadTreasuryRoster");
    expect(runner).not.toContain("issue-wallet-decisions");
    expect(runner).not.toContain("WALLET_ISSUER_AGENT_KEY");
  });
});
