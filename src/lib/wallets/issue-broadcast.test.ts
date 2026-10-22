import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { issuanceDecisionId } from "@/lib/wallets/issuance";
import {
  FEE_PER_WALLET_WEI,
  issuanceEndpoint,
  issuePendingDecisions,
  missingIssuerExitCode,
  redactSecrets,
  type IssueIO,
  type PendingDecision,
} from "@/lib/wallets/issue-broadcast";
import { factoryAbi, MAINNET_WALLET_FACTORY, type AccountLog } from "@/lib/wallets/issuer";

const AGENT = getAddress("0x18229E45A24FB96f3c2d551adb406Db2F7d14358");
const GAS = getAddress("0x40C20bF79Eed165D8Ac4970ccE7e257B63D2A806");
const WALLET = getAddress("0x238797c75Ad0423516F84D917B7A9d765831bf02");
const TX = `0x${"ab".repeat(32)}` as Hex;

function decision(tokenId: string): PendingDecision {
  return { tokenId, decisionId: issuanceDecisionId(tokenId) };
}

function createdLog(tokenId: bigint, decisionId: Hex): AccountLog {
  return {
    address: MAINNET_WALLET_FACTORY,
    topics: encodeEventTopics({ abi: factoryAbi, eventName: "AccountCreated", args: { account: WALLET } }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [143n, addresses.chogGenesis, tokenId, decisionId],
    ),
  };
}

function harness(patch: Partial<IssueIO> = {}): { io: IssueIO; calls: string[]; confirms: Array<Record<string, unknown>> } {
  const calls: string[] = [];
  const confirms: Array<Record<string, unknown>> = [];
  const io: IssueIO = {
    factory: MAINNET_WALLET_FACTORY,
    agent: AGENT,
    gas: GAS,
    chainId: async () => {
      calls.push("chain");
      return 143;
    },
    factoryAgent: async () => {
      calls.push("agent");
      return AGENT;
    },
    predict: async () => {
      calls.push("predict");
      return WALLET;
    },
    bytecode: async () => {
      calls.push("code");
      return undefined;
    },
    baseFee: async () => 100_000_000_000n,
    balance: async () => FEE_PER_WALLET_WEI,
    now: async () => 1_700_000_000n,
    sign: async (_factory, _tokenId, _decisionId, deadline) => {
      calls.push(`sign:${deadline}`);
      return "0x11" as Hex;
    },
    sendCreate: async (input) => {
      calls.push(`create:${input.maxPriorityFeePerGas}`);
      return TX;
    },
    receipt: async () => ({ status: "success", logs: [] }),
    confirm: async (body) => {
      confirms.push(body);
      calls.push("confirm");
      return { ok: true };
    },
    log: () => undefined,
    ...patch,
  };
  return { io, calls, confirms };
}

describe("wallet issuance broadcaster", () => {
  it("links a wallet that already has code and does not sign", async () => {
    const { io, calls, confirms } = harness({
      bytecode: async () => "0x6001",
    });
    const result = await issuePendingDecisions([decision("104")], io);
    expect(result).toEqual({ issued: 0, observed: 1, failed: 0 });
    expect(calls).not.toContain("sign:1700003600");
    expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    expect(confirms).toEqual([{ decisionId: issuanceDecisionId("104"), observed: true }]);
  });

  it("signs factory create for a missing wallet and stores the transaction", async () => {
    const row = decision("7");
    const { io, calls, confirms } = harness({
      receipt: async () => ({ status: "success", logs: [createdLog(7n, row.decisionId)] }),
    });
    const result = await issuePendingDecisions([row], io);
    expect(result).toEqual({ issued: 1, observed: 0, failed: 0 });
    expect(calls).toContain("sign:1700003600");
    expect(calls).toContain("create:1");
    expect(confirms).toEqual([{ decisionId: row.decisionId, txHash: TX }]);
  });

  it("does not treat a creation-less receipt as the wallet transaction", async () => {
    let reads = 0;
    const { io, confirms } = harness({
      bytecode: async () => {
        reads += 1;
        return reads === 1 ? undefined : "0x6001";
      },
      receipt: async () => ({ status: "success", logs: [] }),
    });
    const result = await issuePendingDecisions([decision("7")], io);
    expect(result.observed).toBe(1);
    expect(result.issued).toBe(0);
    expect(confirms[0]).toEqual({ decisionId: issuanceDecisionId("7"), observed: true });
  });

  it("stops before a signature when the chain, agent, or gas wallet is wrong", async () => {
    const wrongChain = harness({ chainId: async () => 1 });
    await expect(issuePendingDecisions([decision("7")], wrongChain.io)).rejects.toThrow(/chain is 1/);
    expect(wrongChain.calls.some((call) => call.startsWith("sign:"))).toBe(false);

    const wrongAgent = harness({ factoryAgent: async () => GAS });
    await expect(issuePendingDecisions([decision("7")], wrongAgent.io)).rejects.toThrow(/does not match/);
    expect(wrongAgent.calls.some((call) => call.startsWith("sign:"))).toBe(false);

    const same = harness();
    same.io.gas = AGENT;
    await expect(issuePendingDecisions([decision("7")], same.io)).rejects.toThrow(/same/i);
    expect(same.calls).toEqual([]);
  });

  it("stops the batch after a create fails", async () => {
    const { io, calls } = harness({
      sendCreate: async () => {
        throw new Error("fee too low");
      },
    });
    const result = await issuePendingDecisions([decision("7"), decision("52")], io);
    expect(result).toEqual({ issued: 0, observed: 0, failed: 1 });
    expect(calls.filter((call) => call.startsWith("sign:")).length).toBe(1);
  });

  it("refuses to sign when the gas wallet is short", async () => {
    const { io, calls } = harness({ balance: async () => 1n });
    const result = await issuePendingDecisions([decision("7")], io);
    expect(result.failed).toBe(1);
    expect(calls.some((call) => call.startsWith("sign:"))).toBe(false);
  });

  it("redacts keys and keeps the issuance URL on the runner host", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(redactSecrets(`failed ${key} and ${"ab".repeat(32)}`, [key])).toBe("failed [redacted] and [redacted]");
    expect(missingIssuerExitCode("schedule")).toBe(0);
    expect(missingIssuerExitCode("workflow_dispatch")).toBe(1);
    expect(missingIssuerExitCode(undefined)).toBe(1);
    expect(issuanceEndpoint(undefined)).toBe("https://chogos.vercel.app/api/wallets/issuance");
    expect(issuanceEndpoint("https://chogos.vercel.app/api/ai/run")).toBe("https://chogos.vercel.app/api/wallets/issuance");
    expect(issuanceEndpoint("http://localhost:3000/api/ai/run")).toBe("http://localhost:3000/api/wallets/issuance");
    expect(issuanceEndpoint("http://example.test/api/ai/run")).toBe("https://chogos.vercel.app/api/wallets/issuance");
  });

  it("keeps the broadcaster outside the website and away from wallet spending", () => {
    const script = readFileSync("scripts/issue-wallet-decisions.ts", "utf8");
    const workflow = readFileSync(".github/workflows/ai-mind.yml", "utf8");
    const app = readFileSync("src/lib/config/env.ts", "utf8");
    expect(script).toContain('functionName: "create"');
    expect(script).toContain("WALLET_ISSUER_AGENT_KEY");
    expect(script).toContain("WALLET_ISSUER_GAS_KEY");
    expect(script.toLowerCase()).not.toContain("execute");
    expect(script).not.toContain("CHOG_WALLET_AGENT_KEY");
    expect(script).not.toContain("server-only");
    expect(workflow).toContain("WALLET_ISSUER_AGENT_KEY");
    expect(workflow).toContain("WALLET_ISSUER_GAS_KEY");
    expect(workflow).toContain("cursor/phase-1-genesis-world-155c");
    expect(workflow).not.toContain("CHOG_WALLET_AGENT_KEY");
    expect(app).not.toContain("WALLET_ISSUER_");
    expect(readFileSync("src/app/api/wallets/issuance/route.ts", "utf8")).not.toContain("WALLET_ISSUER_");
    expect(readFileSync("src/lib/economy/treasury-load.ts", "utf8")).toContain('eq("purpose", "wallet_issuance")');
  });
});
