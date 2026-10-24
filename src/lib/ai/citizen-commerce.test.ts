import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { considerCitizenCommerce } from "@/lib/ai/citizen-commerce";
import { assembleTransferWorld, type TransferCitizen } from "@/lib/ai/transfer-decision";

function citizen(tokenId: string, citizenId: string, balance: string | null): TransferCitizen {
  return {
    tokenId,
    citizenId,
    name: `Chog #${tokenId}`,
    wallet: "0x238797c75Ad0423516F84D917B7A9d765831bf02",
    role: "builder",
    activity: "working",
    workId: "road-east",
    goal: "Finish the east road",
    monBalanceRaw: balance,
  };
}

const world = assembleTransferWorld({
  citizens: [
    citizen("104", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", "2000000000000000"),
    citizen("7", "cccccccc-dddd-4eee-8fff-000000000000", "2000000000000000"),
  ],
  needs: [],
  projects: [
    {
      id: "11111111-2222-4333-8444-555555555555",
      name: "East road",
      status: "active",
      projectType: "territorial",
      justification: "The east road is still incomplete.",
    },
  ],
  events: [],
  priors: [],
});

describe("citizen commerce", () => {
  it("records one grounded proposal and does not invent a second trade", async () => {
    const rows: Array<{ purpose: string; publicState: string; fromModel: boolean; executable: boolean }> = [];
    const result = await considerCitizenCommerce({
      world,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => ({
        provider: "gemini",
        model: "test",
        text: JSON.stringify({
          direction: "citizen_to_chogbank",
          action: "fund_project",
          senderTokenId: "104",
          amountRaw: "1000000000000000",
          asset: "MON",
          explanation: "Fund the stored road project.",
          factIds: ["project:11111111-2222-4333-8444-555555555555"],
        }),
        promptChars: 20,
        outputTokens: 10,
      }),
      record: async (row) => {
        rows.push({ purpose: row.purpose, publicState: row.publicState, fromModel: row.fromModel, executable: row.executable });
        return true;
      },
    });
    expect(result.status).toBe("proposed");
    expect(result.detail).toMatch(/No transaction was broadcast/);
    expect(rows).toEqual([
      { purpose: "citizen_return", publicState: "proposed", fromModel: true, executable: false },
    ]);
  });

  it("defers when balances were not read and does not call the model", async () => {
    let called = false;
    const rows: string[] = [];
    const result = await considerCitizenCommerce({
      world: assembleTransferWorld({
        citizens: [citizen("104", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", null)],
        needs: [],
        projects: [],
        events: [],
        priors: [],
      }),
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => {
        called = true;
        return { provider: "gemini", model: "test", text: "{}", promptChars: 1, outputTokens: 1 };
      },
      record: async (row) => {
        rows.push(row.rationale);
        return true;
      },
    });
    expect(called).toBe(false);
    expect(result.status).toBe("deferred");
    expect(rows[0]).toMatch(/balances were not read/i);
  });

  it("does not invent a trade when the model is not called", async () => {
    let recorded = false;
    const result = await considerCitizenCommerce({
      world,
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

  it("stores a technical failure when the model call fails", async () => {
    const rows: string[] = [];
    const result = await considerCitizenCommerce({
      world,
      timeoutMs: 1000,
      maxOutputTokens: 200,
      provider: "gemini",
      model: "test",
      complete: async () => {
        throw new Error("model unavailable");
      },
      record: async (row) => {
        rows.push(`${row.publicState}:${row.rationale}`);
        return true;
      },
    });
    expect(result.status).toBe("failed");
    expect(rows[0]).toMatch(/technical_failure:model unavailable/);
    expect(rows[0]).not.toMatch(/should trade|should return/i);
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
    expect(readFileSync("src/lib/ai/citizen-commerce-db.ts", "utf8")).not.toMatch(/sendTransaction|signTypedData|privateKey|submitIntent/);
  });
});
