import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, getAddress, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import {
  CHAIN_AUTHORIZATION_TTL,
  CHAIN_CHOG_CAP,
  CHAIN_MON_AGGREGATE,
  CHAIN_MON_CITIZEN,
  CHAIN_MON_PER_TX,
  CHAIN_WINDOW_SECONDS,
  MAINNET_CHOG_BANK,
  MAINNET_CHOG_BANK_AUTHORIZER,
  MAINNET_PAYOUT_GAS,
  PAYOUT_GAS_RESERVE_WEI,
} from "@/lib/chogbank/bank";
import {
  ALLOCATION_TYPES,
  acceptedPayout,
  allocationDigest,
  bankAbi,
  broadcastPendingPayouts,
  chogBankDomain,
  matchDistributed,
  parsePayoutList,
  payableAmount,
  payoutEndpoint,
  viemAllocationDigest,
  type AllocationMessage,
  type BankSnapshot,
  type ChainLog,
  type PayoutIO,
  type PendingPayout,
} from "@/lib/chogbank/payout";
import { treasuryDecisionId, treasuryReasonHash } from "@/lib/economy/treasury-policy";

const WALLET = getAddress("0xd1E6DC7d7498f964AC2466D88D7edB0B0E87557c");
const TX = `0x${"ab".repeat(32)}` as Hex;
const NOW = 1_700_000_000n;
const WINDOW = (NOW / CHAIN_WINDOW_SECONDS).toString();
const REASON = "The east road still needs fare.";

function pending(asset: "MON" | "CHOG", amountRaw = "1000000000000000", tokenId = "91"): PendingPayout {
  return {
    decisionId: treasuryDecisionId(tokenId, asset, WINDOW),
    tokenId,
    asset,
    amountRaw,
    reason: REASON,
    windowId: WINDOW,
  };
}

function snapshot(patch: Partial<BankSnapshot> = {}): BankSnapshot {
  return {
    authorizer: MAINNET_CHOG_BANK_AUTHORIZER,
    chainId: 143n,
    genesis: addresses.chogGenesis,
    chogToken: addresses.chogToken,
    windowSeconds: CHAIN_WINDOW_SECONDS,
    maxAuthorizationTtl: CHAIN_AUTHORIZATION_TTL,
    maxPerTxMon: CHAIN_MON_PER_TX,
    maxCitizenWindowMon: CHAIN_MON_CITIZEN,
    maxAggregateWindowMon: CHAIN_MON_AGGREGATE,
    maxPerTxChog: CHAIN_CHOG_CAP,
    maxCitizenWindowChog: CHAIN_CHOG_CAP,
    maxAggregateWindowChog: CHAIN_CHOG_CAP,
    monBalance: 30n * 10n ** 18n,
    chogBalance: 369n * 10n ** 18n,
    ...patch,
  };
}

function paymentLog(message: AllocationMessage, recipient: Address): ChainLog {
  return {
    address: MAINNET_CHOG_BANK,
    topics: encodeEventTopics({
      abi: bankAbi,
      eventName: "Distributed",
      args: { decisionId: message.decisionId, tokenId: message.tokenId, recipient },
    }),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [message.asset, message.amount, message.deadline, message.reasonHash],
    ),
  };
}

function harness(patch: Partial<PayoutIO> = {}): {
  io: PayoutIO;
  calls: string[];
  confirms: Array<Record<string, unknown>>;
  signed: AllocationMessage[];
} {
  const calls: string[] = [];
  const confirms: Array<Record<string, unknown>> = [];
  const signed: AllocationMessage[] = [];
  const io: PayoutIO = {
    bank: MAINNET_CHOG_BANK,
    authorizer: MAINNET_CHOG_BANK_AUTHORIZER,
    gas: MAINNET_PAYOUT_GAS,
    monDistributed: false,
    chainId: async () => 143,
    snapshot: async () => snapshot(),
    now: async () => NOW,
    baseFee: async () => 100_000_000_000n,
    usedDecision: async () => false,
    spent: async () => ({ citizen: 0n, window: 0n }),
    recipient: async () => WALLET,
    existing: async () => null,
    gasBalance: async () => PAYOUT_GAS_RESERVE_WEI,
    sign: async (message) => {
      signed.push(message);
      calls.push(`sign:${message.amount}`);
      return "0x11" as Hex;
    },
    send: async (input) => {
      calls.push(`distribute:${input.amount}:${input.maxPriorityFeePerGas}`);
      return TX;
    },
    receipt: async () => {
      const message = signed.at(-1);
      return { status: "success" as const, logs: message ? [paymentLog(message, WALLET)] : [] };
    },
    confirm: async (body) => {
      confirms.push(body);
      calls.push("confirm");
      return { ok: true };
    },
    log: () => undefined,
    ...patch,
  };
  return { io, calls, confirms, signed };
}

describe("ChogBank payout broadcaster", () => {
  it("uses the same digest the contract recovers", async () => {
    const message: AllocationMessage = {
      decisionId: treasuryDecisionId("91", "MON", WINDOW),
      tokenId: 91n,
      asset: zeroAddress,
      amount: CHAIN_MON_PER_TX,
      deadline: NOW + 900n,
      reasonHash: treasuryReasonHash(REASON),
    };
    expect(allocationDigest(MAINNET_CHOG_BANK, message)).toBe(viemAllocationDigest(MAINNET_CHOG_BANK, message));
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signature = await account.signTypedData({
      domain: chogBankDomain(MAINNET_CHOG_BANK),
      types: ALLOCATION_TYPES,
      primaryType: "Allocation",
      message,
    });
    expect(signature.length).toBe(132);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    expect(s).toBeLessThanOrEqual(0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n);
    await expect(
      recoverTypedDataAddress({
        domain: chogBankDomain(MAINNET_CHOG_BANK),
        types: ALLOCATION_TYPES,
        primaryType: "Allocation",
        message,
        signature,
      }),
    ).resolves.toBe(account.address);
  });

  it("signs distribute for a fitting MON allocation and stores the transaction", async () => {
    const row = pending("MON");
    const { io, calls, confirms, signed } = harness();
    const result = await broadcastPendingPayouts([row], io);
    expect(result).toEqual({ paid: 1, observed: 0, skipped: 0, failed: 0 });
    expect(signed[0]?.amount).toBe(1_000_000_000_000_000n);
    expect(signed[0]?.asset).toBe(zeroAddress);
    expect(calls).toContain("distribute:1000000000000000:1");
    expect(confirms).toEqual([{ decisionId: row.decisionId, txHash: TX }]);
    const log = matchDistributed([paymentLog(signed[0]!, WALLET)], { bank: MAINNET_CHOG_BANK, decisionId: row.decisionId });
    expect(log?.recipient).toBe(WALLET);
  });

  it("pays the on-chain cap when the stored MON amount is larger", async () => {
    const { io, signed } = harness();
    const result = await broadcastPendingPayouts([pending("MON", CHAIN_MON_PER_TX.toString(10) + "00")], io);
    expect(result.paid).toBe(1);
    expect(signed[0]?.amount).toBe(CHAIN_MON_PER_TX);
    expect(payableAmount({
      requested: 10n ** 18n,
      perTx: CHAIN_MON_PER_TX,
      citizenSpent: 0n,
      citizenCap: CHAIN_MON_CITIZEN,
      windowSpent: 0n,
      windowCap: CHAIN_MON_AGGREGATE,
      balance: 30n * 10n ** 18n,
    })).toBe(CHAIN_MON_PER_TX);
  });

  it("holds $CHOG until a MON distribution is confirmed, then pays 1 wei", async () => {
    const held = harness();
    const waiting = await broadcastPendingPayouts([pending("CHOG", "1")], held.io);
    expect(waiting).toEqual({ paid: 0, observed: 0, skipped: 1, failed: 0 });
    expect(held.calls.some((call) => call.startsWith("sign:"))).toBe(false);

    const open = harness({ monDistributed: true });
    const paid = await broadcastPendingPayouts([pending("CHOG", "1")], open.io);
    expect(paid.paid).toBe(1);
    expect(open.signed[0]?.amount).toBe(1n);
    expect(open.signed[0]?.asset).toBe(addresses.chogToken);
  });

  it("links an existing distribution without signing again", async () => {
    const row = pending("MON");
    const message: AllocationMessage = {
      decisionId: row.decisionId,
      tokenId: 91n,
      asset: zeroAddress,
      amount: 1_000_000_000_000_000n,
      deadline: NOW + 900n,
      reasonHash: treasuryReasonHash(REASON),
    };
    const { io, calls, confirms } = harness({
      usedDecision: async () => true,
      existing: async () => ({ txHash: TX, log: { ...message, recipient: WALLET } }),
    });
    const result = await broadcastPendingPayouts([row], io);
    expect(result).toEqual({ paid: 0, observed: 1, skipped: 0, failed: 0 });
    expect(calls.some((call) => call.startsWith("sign:"))).toBe(false);
    expect(confirms).toEqual([{ decisionId: row.decisionId, txHash: TX }]);
  });

  it("does not sign when the wallet, window, gas, authorizer, or chain is wrong", async () => {
    const missing = harness({
      recipient: async () => {
        throw new Error("no code");
      },
    });
    expect((await broadcastPendingPayouts([pending("MON")], missing.io)).skipped).toBe(1);
    expect(missing.calls).toEqual([]);

    const stale = harness();
    expect((await broadcastPendingPayouts([{ ...pending("MON"), windowId: "1", decisionId: treasuryDecisionId("91", "MON", "1") }], stale.io)).skipped).toBe(1);
    expect(stale.calls.some((call) => call.startsWith("sign:"))).toBe(false);

    const short = harness({ gasBalance: async () => 1n });
    expect((await broadcastPendingPayouts([pending("MON")], short.io)).failed).toBe(1);
    expect(short.calls.some((call) => call.startsWith("sign:"))).toBe(false);

    const wrongAuthorizer = harness();
    wrongAuthorizer.io.authorizer = MAINNET_PAYOUT_GAS;
    await expect(broadcastPendingPayouts([pending("MON")], wrongAuthorizer.io)).rejects.toThrow(/authorizer/);
    expect(wrongAuthorizer.calls).toEqual([]);

    const wrongChain = harness({ chainId: async () => 1 });
    await expect(broadcastPendingPayouts([pending("MON")], wrongChain.io)).rejects.toThrow(/chain is 1/);
    expect(wrongChain.calls).toEqual([]);

    const wrongCaps = harness({ snapshot: async () => snapshot({ maxPerTxMon: 1n }) });
    await expect(broadcastPendingPayouts([pending("MON")], wrongCaps.io)).rejects.toThrow(/caps/);
    expect(wrongCaps.calls).toEqual([]);
  });

  it("stops the batch after a distribution fails", async () => {
    const { io, calls } = harness({
      send: async () => {
        throw new Error("fee too low");
      },
    });
    const result = await broadcastPendingPayouts([pending("MON", "1", "91"), pending("MON", "1", "52")], io);
    expect(result).toEqual({ paid: 0, observed: 0, skipped: 0, failed: 1 });
    expect(calls.filter((call) => call.startsWith("sign:")).length).toBe(1);
  });

  it("refuses a listed payout whose decision id does not belong to the token", () => {
    expect(() =>
      parsePayoutList({
        ok: true,
        bank: MAINNET_CHOG_BANK,
        monDistributed: false,
        decisions: [{ ...pending("MON"), decisionId: `0x${"ab".repeat(32)}` }],
      }),
    ).toThrow(/Refusing/);
    expect(payoutEndpoint(undefined)).toBe("https://chogos.vercel.app/api/economy/payouts");
    expect(payoutEndpoint("https://chogos.vercel.app/api/ai/run")).toBe("https://chogos.vercel.app/api/economy/payouts");
    expect(payoutEndpoint("http://localhost:3000/api/ai/run")).toBe("http://localhost:3000/api/economy/payouts");
    expect(payoutEndpoint("http://example.test/api/ai/run")).toBe("https://chogos.vercel.app/api/economy/payouts");
  });

  it("accepts a receipt only when the log matches the stored decision and the citizen wallet", () => {
    const row = pending("MON");
    const message: AllocationMessage = {
      decisionId: row.decisionId,
      tokenId: 91n,
      asset: zeroAddress,
      amount: 1_000_000_000_000_000n,
      deadline: NOW,
      reasonHash: treasuryReasonHash(REASON),
    };
    const log = {
      ...message,
      recipient: WALLET,
    };
    expect(acceptedPayout({ stored: { ...row, amountRaw: 1_000_000_000_000_000n }, log, recipient: WALLET }).ok).toBe(true);
    expect(acceptedPayout({ stored: { ...row, amountRaw: 1n }, log, recipient: WALLET }).ok).toBe(false);
    expect(acceptedPayout({ stored: { ...row, amountRaw: message.amount }, log, recipient: MAINNET_PAYOUT_GAS }).ok).toBe(false);
  });

  it("keeps the website from signing and keeps the agent key out of payouts", () => {
    const script = readFileSync("scripts/broadcast-chogbank-payouts.ts", "utf8");
    const route = readFileSync("src/app/api/economy/payouts/route.ts", "utf8");
    const workflow = readFileSync(".github/workflows/ai-mind.yml", "utf8");
    const app = readFileSync("src/lib/config/env.ts", "utf8");
    expect(script).toContain('functionName: "distribute"');
    expect(script).toContain("CHOG_BANK_AUTHORIZER_KEY");
    expect(script).toContain("WALLET_ISSUER_GAS_KEY");
    expect(script).not.toContain("WALLET_ISSUER_AGENT_KEY");
    expect(script).not.toContain("distributeWithIssuance");
    expect(script.toLowerCase()).not.toContain("execute");
    expect(route).not.toMatch(/signTypedData|privateKeyToAccount|CHOG_BANK_AUTHORIZER_KEY|WALLET_ISSUER_AGENT_KEY/);
    expect(workflow).toContain("CHOG_BANK_AUTHORIZER_KEY");
    expect(workflow).toContain("cursor/phase-1-genesis-world-155c");
    expect(workflow).not.toContain("distributeWithIssuance");
    expect(app).not.toContain("CHOG_BANK_AUTHORIZER_KEY");
    expect(app).not.toContain("WALLET_ISSUER_");
    expect(readFileSync("src/lib/economy/production.ts", "utf8")).toContain("executionEnabled: false");
    expect(readFileSync("src/lib/ai/runner.ts", "utf8")).not.toMatch(/broadcastPendingPayouts|signTypedData|privateKeyToAccount/);
    const signer = loadProtectedSigner({ CHOG_BANK_AUTHORIZER_KEY: `0x${"ab".repeat(32)}` });
    expect(signer.kind).toBe("none");
    expect(JSON.stringify(signer)).not.toContain("ab".repeat(32));
  });
});
