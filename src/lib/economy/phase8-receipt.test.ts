import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { addresses } from "@/lib/blockchain/addresses";
import { confirmEconomyReceipt, settleEconomyProposal } from "@/lib/economy/db";
import { reconcileChainTransfer, type ChainTransferEvidence } from "@/lib/economy/journal";
import { applyRpcVerification, interpretLedgerSnapshot } from "@/lib/economy/ledger";
import { assessTreasuryRead, readEconomicTreasury, type TreasuryReader, type TreasurySnapshot } from "@/lib/economy/observe";
import { holdFailureStatus, persistEconomyDecision, type EconomyGateway } from "@/lib/economy/persist";
import { decideEconomicProposal, type EconomicProposal, type EconomyLimits } from "@/lib/economy/proposal";
import { assessReceiptEvidence, settleRpcArgs } from "@/lib/economy/receipt";
import { holdSequentially, tryHold, type Hold } from "@/lib/economy/reserve";
import { isRpcVerifiedReceipt, jsonRpcCaller, verifyMainnetReceipt, type RpcCaller, type RpcVerifiedReceipt } from "@/lib/economy/verify-receipt";
import { noteReceipt, noteSubmission, openProposal, planConfirmation, planSettlement, settleProposal } from "@/lib/economy/workflow";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const TX = `0x${"ab".repeat(32)}` as Hex;
const OTHER_TX = `0x${"ef".repeat(32)}` as Hex;
const BLOCK = `0x${"cd".repeat(32)}` as Hex;
const OTHER_BLOCK = `0x${"12".repeat(32)}` as Hex;
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const TARGET = getAddress("0x3333333333333333333333333333333333333333");
const OTHER = getAddress("0x4444444444444444444444444444444444444444");
const SELECTOR = "0xa9059cbb" as Hex;
const CITIZEN = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";

const LIMITS: EconomyLimits = {
  maxCitizenCapitalWei: 1_000_000_000_000_000_000n,
  maxBusinessAllocationWei: 2_000_000_000_000_000_000n,
  maxTxWei: 100_000_000_000_000_000n,
  maxDailyGasWei: 1_000_000_000_000_000_000n,
  maxTreasuryExposureWei: 5_000_000_000_000_000_000n,
  maxChogPerTxRaw: 1_000_000n,
  maxCitizenChogRaw: 5_000_000n,
  maxBusinessChogRaw: 2_000_000n,
};

function mainnet(options: {
  chain?: unknown;
  receipt?: unknown;
  block?: unknown;
  throwOn?: string;
  hangOn?: string;
} = {}): { call: RpcCaller; methods: string[]; params: unknown[][] } {
  const methods: string[] = [];
  const params: unknown[][] = [];
  const call: RpcCaller = (method, next) => {
    methods.push(method);
    params.push(next);
    if (options.throwOn === method) {
      return Promise.reject(new Error("connect failed https://rpc.example/secret?token=abc"));
    }
    if (options.hangOn === method) {
      return new Promise(() => undefined);
    }
    if (method === "eth_chainId") {
      return Promise.resolve(options.chain === undefined ? "0x8f" : options.chain);
    }
    if (method === "eth_getTransactionReceipt") {
      return Promise.resolve(
        options.receipt === undefined
          ? { transactionHash: next[0], status: "0x1", blockNumber: "0xa", blockHash: BLOCK.toUpperCase() }
          : options.receipt,
      );
    }
    if (method === "eth_getBlockByNumber") {
      return Promise.resolve(options.block === undefined ? { number: "0xa", hash: BLOCK } : options.block);
    }
    return Promise.reject(new Error(method));
  };
  return { call, methods, params };
}

function evidence(txHash: Hex = TX): ChainTransferEvidence {
  return {
    chainId: 143,
    txHash,
    logIndex: null,
    status: "success",
    asset: "MON",
    amountRaw: 1_000n,
    direction: "in",
    treasury: TREASURY,
    counterparty: OTHER,
    blockNumber: 10n,
  };
}

function fresh(): TreasurySnapshot {
  return assessTreasuryRead({
    address: TREASURY,
    read: {
      chainId: 143,
      blockNumber: 10n,
      observedAt: new Date(NOW).toISOString(),
      nativeRaw: 10_000n,
      tokenRaw: 0n,
      tokenDecimals: 6,
    },
    nowMs: NOW,
    maxAgeMs: 60_000,
  });
}

function proposal(overrides: Partial<EconomicProposal> = {}): EconomicProposal {
  return {
    id: "proposal-1",
    idempotencyKey: "proposal-1",
    citizenId: CITIZEN,
    tokenId: "104",
    nftContract: addresses.chogGenesis,
    objective: "Buy timber for the workshop",
    rationale: "The listed goal needs a payment for timber.",
    operation: "payment",
    target: TARGET,
    selector: SELECTOR,
    asset: "MON",
    amountRaw: 11n,
    estimatedGasWei: 0n,
    fundingRequestRaw: 11n,
    expectedOutcome: "Timber is delivered if a later receipt succeeds.",
    quotePriceRaw: null,
    slippageBps: null,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

function reader(partial: Partial<TreasuryReader> & Pick<TreasuryReader, "getChainId">): TreasuryReader {
  return {
    getBlockNumber: async () => 10n,
    getNativeBalance: async () => 0n,
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 18,
    ...partial,
  };
}

function fakeClient(onRpc: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const promise = Promise.resolve({ data: onRpc(fn, args), error: null });
      return Object.assign(promise, { abortSignal: () => promise });
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

async function verifiedReceipt(tx: Hex = TX, status: "0x1" | "0x0" = "0x1"): Promise<RpcVerifiedReceipt> {
  const result = await verifyMainnetReceipt({
    txHash: tx,
    call: mainnet({
      receipt: { transactionHash: tx, status, blockNumber: "0xa", blockHash: BLOCK },
    }).call,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.receipt;
}

describe("mainnet receipt verification", () => {
  it("accepts a receipt only when chain 143, the hash, the status, and the block all match", async () => {
    const script = mainnet();
    const result = await verifyMainnetReceipt({ txHash: TX.toUpperCase(), call: script.call });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(isRpcVerifiedReceipt(result.receipt)).toBe(true);
    expect(result.receipt.source).toBe("monad-mainnet-rpc");
    expect(result.receipt.chainId).toBe(143);
    expect(result.receipt.txHash).toBe(TX);
    expect(result.receipt.status).toBe("success");
    expect(result.receipt.blockNumber).toBe(10n);
    expect(result.receipt.blockHash).toBe(BLOCK);
    expect(script.methods).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
    expect(script.params[2]).toEqual(["0xa", false]);
    expect(JSON.parse(JSON.stringify({ status: result.receipt.status }))).toEqual({ status: "success" });
    expect(isRpcVerifiedReceipt(JSON.parse(JSON.stringify({ chainId: 143, txHash: TX })))).toBe(false);
  });

  it("rejects fabricated receipts, typed casts, wrong chains, and mismatched blocks", async () => {
    const shaped = assessReceiptEvidence({
      chainId: 143,
      observedChainId: 143,
      txHash: TX,
      status: "success",
      blockNumber: 10n,
      blockHash: BLOCK,
    });
    expect(shaped.ok).toBe(true);
    const forged = {
      source: "monad-mainnet-rpc",
      chainId: 143,
      txHash: TX,
      status: "success",
      blockNumber: 10n,
      blockHash: BLOCK,
    } as RpcVerifiedReceipt;
    expect(isRpcVerifiedReceipt(shaped.ok ? shaped.evidence : null)).toBe(false);
    expect(isRpcVerifiedReceipt(forged)).toBe(false);
    expect(settleRpcArgs("proposal-1", forged).ok).toBe(false);
    expect(settleRpcArgs("proposal-1", shaped.ok ? shaped.evidence : null).ok).toBe(false);

    const wrongChain = mainnet({ chain: "0x27a7" });
    const wrong = await verifyMainnetReceipt({ txHash: TX, call: wrongChain.call });
    expect(wrong).toMatchObject({ ok: false, outcome: "wrong_chain" });
    expect(wrongChain.methods).toEqual(["eth_chainId"]);

    const numericChain = mainnet({ chain: 143 });
    const numeric = await verifyMainnetReceipt({ txHash: TX, call: numericChain.call });
    expect(numeric).toMatchObject({ ok: false, outcome: "malformed" });
    expect(numericChain.methods).toEqual(["eth_chainId"]);

    const worded = mainnet({
      receipt: { transactionHash: TX, status: "success", blockNumber: "0xa", blockHash: BLOCK },
    });
    expect(await verifyMainnetReceipt({ txHash: TX, call: worded.call })).toMatchObject({ ok: false, outcome: "malformed" });

    const hashMismatch = mainnet({
      receipt: { transactionHash: OTHER_TX, status: "0x1", blockNumber: "0xa", blockHash: BLOCK },
    });
    expect(await verifyMainnetReceipt({ txHash: TX, call: hashMismatch.call })).toMatchObject({ ok: false, outcome: "mismatch" });
    expect(hashMismatch.methods).not.toContain("eth_getBlockByNumber");

    const blockMismatch = mainnet({ block: { number: "0xa", hash: OTHER_BLOCK } });
    const mismatched = await verifyMainnetReceipt({ txHash: TX, call: blockMismatch.call });
    expect(mismatched).toMatchObject({ ok: false, outcome: "mismatch" });
    expect(isRpcVerifiedReceipt(mismatched.ok ? mismatched.receipt : null)).toBe(false);

    const numberMismatch = mainnet({ block: { number: "0xb", hash: BLOCK } });
    expect(await verifyMainnetReceipt({ txHash: TX, call: numberMismatch.call })).toMatchObject({ ok: false, outcome: "mismatch" });

    let calls = 0;
    const malformedHash = await verifyMainnetReceipt({
      txHash: "0x123",
      call: async () => {
        calls += 1;
        return "0x8f";
      },
    });
    expect(malformedHash).toMatchObject({ ok: false, outcome: "malformed" });
    expect(calls).toBe(0);
  });

  it("treats a reverted receipt as reverted and refuses to settle it", async () => {
    const script = mainnet({
      receipt: { transactionHash: TX, status: "0x0", blockNumber: "0xa", blockHash: BLOCK },
    });
    const result = await verifyMainnetReceipt({ txHash: TX, call: script.call });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.receipt.status).toBe("reverted");
    expect(settleRpcArgs("proposal-1", result.receipt).ok).toBe(false);
    const opened = openProposal([], { id: "1", idempotencyKey: "tools-104", tokenId: "104", expiresAtMs: NOW + 1_000, at: "t0" });
    const submitted = noteSubmission([{ ...opened.record, status: "approved", reason: "reserved" }], "tools-104", "t1");
    const noted = noteReceipt(submitted, "tools-104", result.receipt, "t2");
    expect(noted[0]?.status).toBe("reverted");
    expect(noted[0]?.executed).toBe(false);
    const posted = reconcileChainTransfer([], { ...evidence(), status: "reverted" }, "t2");
    expect(posted.ok).toBe(true);
    const settled = settleProposal(noted, "tools-104", result.receipt, posted.ok ? posted.lines : [], "t3");
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.outcome).toBe("refused");
    }
    expect(settled.records[0]?.status).toBe("reverted");
    expect(planSettlement(noted[0], result.receipt, []).action).toBe("refuse");
  });

  it("fails closed on a missing receipt, a malformed response, and an RPC outage", async () => {
    const missing = mainnet({ receipt: null });
    expect(await verifyMainnetReceipt({ txHash: TX, call: missing.call })).toMatchObject({ ok: false, outcome: "missing" });

    const broken = mainnet({ receipt: ["not", "a", "receipt"] });
    expect(await verifyMainnetReceipt({ txHash: TX, call: broken.call })).toMatchObject({ ok: false, outcome: "malformed" });

    const outage = mainnet({ throwOn: "eth_chainId" });
    const failed = await verifyMainnetReceipt({ txHash: TX, call: outage.call });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.outcome).toBe("rpc_failure");
      expect(failed.reason).toContain("[redacted-url]");
      expect(failed.reason).not.toContain("secret");
      expect(failed.reason).not.toContain("https://");
    }

    const hung = mainnet({ hangOn: "eth_getTransactionReceipt" });
    const timed = await verifyMainnetReceipt({ txHash: TX, call: hung.call, timeoutMs: 20 });
    expect(timed).toMatchObject({ ok: false, outcome: "rpc_failure" });
    if (!timed.ok) {
      expect(timed.reason).toMatch(/did not respond/);
    }

    const unconfigured = await verifyMainnetReceipt({ txHash: TX, call: jsonRpcCaller(undefined) });
    expect(unconfigured).toMatchObject({ ok: false, outcome: "rpc_failure" });
    if (!unconfigured.ok) {
      expect(unconfigured.reason).toMatch(/not configured/i);
    }

    const original = globalThis.fetch;
    let posted = "";
    globalThis.fetch = async (_input, init) => {
      posted = String(init?.body);
      throw new Error("connect https://rpc.example/secret failed");
    };
    try {
      const fetched = await verifyMainnetReceipt({ txHash: TX, call: jsonRpcCaller("https://rpc.example/secret") });
      expect(fetched.ok).toBe(false);
      if (!fetched.ok) {
        expect(fetched.outcome).toBe("rpc_failure");
        expect(fetched.reason).toContain("[redacted-url]");
        expect(fetched.reason).not.toContain("secret");
      }
      expect(posted).toContain('"method":"eth_chainId"');
      expect(posted).not.toContain("eth_sendRawTransaction");
      await expect(jsonRpcCaller("https://rpc.example/secret")("eth_sendRawTransaction", ["0x00"])).rejects.toThrow(/read-only/);
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = async () => ({ ok: true, json: async () => "not-json" }) as Response;
    try {
      const malformed = await verifyMainnetReceipt({ txHash: TX, call: jsonRpcCaller("https://rpc.example/node") });
      expect(malformed).toMatchObject({ ok: false, outcome: "rpc_failure" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("confirmation and settlement", () => {
  it("does not append history for a duplicate settlement and refuses a conflicting transaction", async () => {
    const receipt = await verifiedReceipt();
    const opened = openProposal([], { id: "1", idempotencyKey: "tools-104", tokenId: "104", expiresAtMs: NOW + 1_000, at: "t0" });
    const submitted = noteSubmission([{ ...opened.record, status: "approved", reason: "reserved" }], "tools-104", "t1");
    expect(noteReceipt(submitted, "tools-104", { ...receipt }, "t1b")[0]?.status).toBe("submitted");
    const confirmed = noteReceipt(submitted, "tools-104", receipt, "t2");
    expect(confirmed[0]?.status).toBe("confirmed");
    const historyAfterConfirm = confirmed[0]?.history.length ?? 0;
    const repeated = noteReceipt(confirmed, "tools-104", receipt, "t2b");
    expect(planConfirmation(confirmed[0], receipt).action).toBe("duplicate");
    expect(repeated[0]?.history).toHaveLength(historyAfterConfirm);
    expect(repeated[0]?.status).toBe("confirmed");

    const posted = reconcileChainTransfer([], evidence(), "t3");
    expect(posted.ok).toBe(true);
    const lines = posted.ok ? posted.lines : [];
    const settled = settleProposal(confirmed, "tools-104", receipt, lines, "t4");
    expect(settled.ok).toBe(true);
    if (!settled.ok) {
      return;
    }
    expect(settled.duplicate).toBe(false);
    expect(settled.records[0]?.status).toBe("settled");
    const historyAfterSettle = settled.records[0]?.history.length ?? 0;
    const again = settleProposal(settled.records, "tools-104", receipt, lines, "t5");
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.records[0]?.history).toHaveLength(historyAfterSettle);
    expect(again.records[0]?.status).toBe("settled");

    const other = await verifiedReceipt(OTHER_TX);
    const conflict = settleProposal(confirmed, "tools-104", other, lines, "t6");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.outcome).toBe("conflict");
    }
    expect(conflict.records[0]?.status).toBe("confirmed");
    expect(conflict.records[0]?.txHash).toBe(TX);
    expect(conflict.records[0]?.history).toHaveLength(historyAfterConfirm);
  });

  it("writes SQL only with fields taken from the RPC verifier", async () => {
    const script = mainnet();
    const saved = fakeClient(() => ({ ok: true, status: "confirmed", duplicate: false }));
    const confirmed = await confirmEconomyReceipt(saved.client, "proposal-1", TX.toUpperCase(), script.call);
    expect(confirmed).toEqual({ ok: true, status: "confirmed", duplicate: false, verified: true });
    expect(saved.calls).toHaveLength(1);
    expect(saved.calls[0]).toEqual({
      fn: "economy_note_receipt",
      args: {
        p_key: "proposal-1",
        p_reason: "The mainnet receipt succeeded. Settlement still requires a counted journal posting.",
        p_tx: TX,
        p_chain: 143,
        p_block: "10",
        p_block_hash: BLOCK,
        p_receipt_status: "success",
      },
    });

    const mismatched = mainnet({ block: { number: "0xa", hash: OTHER_BLOCK } });
    const refused = fakeClient(() => {
      throw new Error("SQL must not run");
    });
    const unverified = await confirmEconomyReceipt(refused.client, "proposal-1", TX, mismatched.call);
    expect(unverified).toMatchObject({ ok: false, verified: false });
    expect(refused.calls).toEqual([]);

    const reverted = mainnet({
      receipt: { transactionHash: TX, status: "0x0", blockNumber: "0xa", blockHash: BLOCK },
    });
    const notSettled = fakeClient(() => {
      throw new Error("SQL must not run");
    });
    const revertedSettle = await settleEconomyProposal(notSettled.client, "proposal-1", TX, reverted.call);
    expect(revertedSettle).toMatchObject({ ok: false, verified: true });
    expect(notSettled.calls).toEqual([]);

    const duplicate = fakeClient(() => ({ ok: true, status: "settled", duplicate: true }));
    const settled = await settleEconomyProposal(duplicate.client, "proposal-1", TX, mainnet().call);
    expect(settled).toEqual({ ok: true, status: "settled", duplicate: true, verified: true });
    expect(duplicate.calls[0]?.fn).toBe("economy_settle_proposal");
    expect(duplicate.calls[0]?.args).toEqual({ p_key: "proposal-1", p_tx: TX });

    const conflicted = fakeClient(() => ({
      ok: false,
      outcome: "conflict",
      reason: "This proposal is already tied to a different transaction.",
    }));
    const conflict = await settleEconomyProposal(conflicted.client, "proposal-1", TX, mainnet().call);
    expect(conflict).toMatchObject({
      ok: false,
      verified: true,
      reason: "This proposal is already tied to a different transaction.",
    });
  });
});

describe("reservation idempotency", () => {
  it("fails closed when an idempotency key is reused with different terms and leaves the original hold", () => {
    const request = {
      id: "hold-1",
      key: "key-1",
      proposalId: "citizen:104:proposal-1",
      tokenId: "104",
      asset: "MON" as const,
      bucket: "business_capital" as const,
      amountRaw: 40n,
      observedRaw: 100n,
    };
    const first = tryHold([], request);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const conflict = tryHold(first.holds, { ...request, id: "hold-2", amountRaw: 41n });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.outcome).toBe("conflict");
      expect(conflict.holds).toEqual(first.holds);
    }
    expect(first.holds[0]?.state).toBe("held");
    expect(first.holds[0]?.amountRaw).toBe(40n);
    const otherAsset = tryHold(first.holds, { ...request, asset: "CHOG" });
    expect(otherAsset.ok).toBe(false);
    const otherProposal = tryHold(first.holds, { ...request, proposalId: "citizen:104:proposal-2" });
    expect(otherProposal.ok).toBe(false);
    const replay = tryHold(first.holds, request);
    expect(replay.ok && replay.created).toBe(false);
    if (replay.ok) {
      expect(replay.hold.amountRaw).toBe(40n);
    }

    const existing = tryHold([], {
      id: "old",
      key: proposal().idempotencyKey,
      proposalId: `${CITIZEN}:104:proposal-1`,
      tokenId: "104",
      asset: "MON",
      bucket: "business_capital",
      amountRaw: 10n,
      observedRaw: 10_000n,
    });
    expect(existing.ok).toBe(true);
    const decided = decideEconomicProposal({
      proposal: proposal(),
      observation: fresh(),
      holds: existing.ok ? existing.holds : [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: [{ chainId: 143, target: TARGET, selectors: [SELECTOR], assets: ["MON"], label: "fixture" }],
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: false,
    });
    expect(decided.decision.outcome).toBe("rejected");
    expect(decided.decision.reserved).toBe(false);
    expect(decided.holds[0]?.amountRaw).toBe(10n);
    expect(decided.holds[0]?.state).toBe("held");
    expect(holdFailureStatus("conflict")).toBe("rejected");
    expect(holdFailureStatus("insufficient_funds")).toBe("insufficient_funds");
    expect(holdFailureStatus("malformed")).toBe("deferred");
  });

  it("shows the unlocked race and lets a serialized pair keep one hold", async () => {
    const requests = [0, 1].map((index) => ({
      id: `hold-${index}`,
      key: `key-${index}`,
      proposalId: `citizen:104:proposal-${index}`,
      tokenId: "104",
      asset: "MON" as const,
      bucket: "business_capital" as const,
      amountRaw: 60n,
      observedRaw: 100n,
    }));
    const raced = [tryHold([], requests[0]!), tryHold([], requests[1]!)];
    expect(raced.every((result) => result.ok)).toBe(true);

    const serial = holdSequentially([], requests);
    expect(serial.results[0]?.ok).toBe(true);
    expect(serial.results[1]?.ok).toBe(false);
    expect(serial.holds).toHaveLength(1);

    let current: Hold[] = [];
    let chain = Promise.resolve();
    const locked = requests.map((request) => {
      const run = chain.then(() => {
        const result = tryHold(current, request);
        current = result.holds;
        return result;
      });
      chain = run.then(() => undefined);
      return run;
    });
    const results = await Promise.all(locked);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(current).toHaveLength(1);
  });

  it("records a conflicting hold as rejected and does not release it", async () => {
    const calls: string[] = [];
    const gateway: EconomyGateway = {
      async openProposal() {
        calls.push("open");
        return { ok: true, id: PROPOSAL_ID, created: true };
      },
      async applyStatus(input) {
        calls.push(`status:${input.status}`);
        return { ok: true, status: input.status, duplicate: false };
      },
      async tryHolds() {
        calls.push("holds");
        return { ok: false, outcome: "conflict", reason: "This idempotency key is already used for a different reservation." };
      },
      async release(proposalId) {
        calls.push(`release:${proposalId}`);
        return { ok: true };
      },
    };
    const decided = decideEconomicProposal({
      proposal: proposal({ fundingRequestRaw: 20n, amountRaw: 20n }),
      observation: fresh(),
      holds: [],
      limits: LIMITS,
      dailyGasWei: 0n,
      dailyGasKnown: true,
      allowlist: [{ chainId: 143, target: TARGET, selectors: [SELECTOR], assets: ["MON"], label: "fixture" }],
      factoryDeployed: false,
      nowMs: NOW,
      executionEnabled: false,
    });
    const saved = await persistEconomyDecision(gateway, {
      proposal: proposal({ fundingRequestRaw: 20n, amountRaw: 20n }),
      decision: decided.decision,
      holds: decided.holds,
      observation: fresh(),
    });
    expect(saved).toMatchObject({ ok: true, status: "rejected", reserved: false });
    expect(calls).toEqual(["open", "holds", "status:rejected"]);
  });
});

describe("read-only treasury observer", () => {
  it("keeps native MON and canonical $CHOG explicit when the read is missing, stale, or on the wrong chain", async () => {
    const unset = await readEconomicTreasury({ address: null, nowMs: NOW, maxAgeMs: 60_000 });
    expect(unset.status).toBe("not_configured");
    expect(unset.mon.raw).toBeNull();
    expect(unset.chog.raw).toBeNull();
    expect(unset.unallocatedMon).toBeNull();

    const stale = assessTreasuryRead({
      address: TREASURY,
      read: {
        chainId: 143,
        blockNumber: 4n,
        observedAt: new Date(NOW - 120_000).toISOString(),
        nativeRaw: 5n,
        tokenRaw: 6n,
        tokenDecimals: 6,
      },
      nowMs: NOW,
      maxAgeMs: 1_000,
    });
    expect(stale.status).toBe("stale");
    expect(stale.mon).toEqual({ symbol: "MON", raw: 5n, decimals: 18 });
    expect(stale.chog).toEqual({ symbol: "CHOG", raw: 6n, decimals: 6 });
    expect(stale.unallocatedMon).toBeNull();
    expect(stale.unallocatedChog).toBeNull();

    let balances = 0;
    const wrong = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({
        getChainId: async () => 10143,
        getNativeBalance: async () => {
          balances += 1;
          return 9n;
        },
        getTokenBalance: async () => {
          balances += 1;
          return 9n;
        },
      }),
    });
    expect(wrong.status).toBe("wrong_chain");
    expect(wrong.observedChainId).toBe(10143);
    expect(wrong.chainId).toBe(143);
    expect(wrong.mon.raw).toBeNull();
    expect(wrong.chog.raw).toBeNull();
    expect(wrong.unallocatedMon).toBeNull();
    expect(balances).toBe(0);

    const unavailable = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({ getChainId: async () => Promise.reject(new Error("failed https://rpc.example/secret")) }),
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toContain("[redacted-url]");
    expect(unavailable.reason).not.toContain("https://");
    expect(unavailable.mon.raw).toBeNull();
    expect(unavailable.chog.raw).toBeNull();

    const noRpc = await readEconomicTreasury({ address: TREASURY, nowMs: NOW, maxAgeMs: 60_000 });
    expect(noRpc.status).toBe("unavailable");

    const wrongToken = await readEconomicTreasury({
      address: TREASURY,
      token: addresses.wrappedMon,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({ getChainId: async () => 143 }),
    });
    expect(wrongToken.status).toBe("malformed");
    expect(wrongToken.reason).toMatch(/canonical/);

    const observed = await readEconomicTreasury({
      address: TREASURY,
      nowMs: NOW,
      maxAgeMs: 60_000,
      reader: reader({
        getChainId: async () => 143,
        getNativeBalance: async () => 10n ** 18n + 1n,
        getTokenBalance: async () => 1_500_000n,
        getTokenDecimals: async () => 6,
      }),
    });
    expect(observed.status).toBe("observed");
    expect(observed.mon.decimals).toBe(18);
    expect(observed.chog.decimals).toBe(6);
    expect(observed.chog.raw).toBe(1_500_000n);
    expect(observed.mon.raw).not.toBe(observed.chog.raw);
  });
});

describe("phase 8 safety scans", () => {
  it("keeps stored ledger rows unverified until this call checked the receipt", async () => {
    const ledger = interpretLedgerSnapshot({
      ok: true,
      complete: true,
      reservedGas: "0",
      reservedDeployment: "0",
      allocatedMon: "0",
      allocatedChog: "0",
      dailyGas: "0",
      holds: [],
      proposals: [
        {
          id: "stored",
          status: "confirmed",
          objective: "Pay timber",
          txHash: TX,
          receiptChainId: 143,
          receiptStatus: "success",
          receiptBlockNumber: "10",
          receiptBlockHash: BLOCK,
        },
      ],
      transfers: [{ id: "seen", asset: "MON", amountRaw: "1000", side: "debit", status: "observed", evidenceKey: `143:${TX}:native:MON:in` }],
    });
    expect(ledger.activities[0]?.chainVerified).toBe(false);
    expect(ledger.transfers[0]?.chainVerified).toBe(false);
    const forged = assessReceiptEvidence({
      chainId: 143,
      observedChainId: 143,
      txHash: TX,
      status: "success",
      blockNumber: 10n,
      blockHash: BLOCK,
    });
    expect(applyRpcVerification(ledger, forged.ok ? (forged.evidence as unknown as RpcVerifiedReceipt) : null).activities[0]?.chainVerified).toBe(false);
    const receipt = await verifiedReceipt();
    const linked = applyRpcVerification(ledger, receipt);
    expect(linked.activities[0]?.chainVerified).toBe(true);
    expect(linked.transfers[0]?.chainVerified).toBe(true);
    expect(linked.activities[0]?.simulated).toBe(false);
  });

  it("reviews the new migration and leaves execution disabled", () => {
    const sql = readFileSync("supabase/migrations/20261020050000_phase8_receipt_verification.sql", "utf8").toLowerCase();
    expect(sql).toContain("for update");
    expect(sql).toContain("this idempotency key is already used for a different reservation.");
    expect(sql).toContain("this idempotency key is already used for a different proposal.");
    expect(sql).toContain("existing.proposal_id is distinct from p_proposal");
    expect(sql).toContain("existing.asset is distinct from p_asset");
    expect(sql).toContain("existing.amount_raw is distinct from p_amount");
    expect(sql).toContain("existing.amount_raw is distinct from (p_row->>'amountraw')::numeric(78, 0)");
    const holds = sql.slice(sql.indexOf("function economy_try_holds"), sql.indexOf("function economy_note_receipt"));
    expect(holds.indexOf("different reservation")).toBeGreaterThan(0);
    expect(holds.indexOf("different reservation")).toBeLessThan(holds.indexOf("set state = 'released'"));
    const note = sql.slice(sql.indexOf("function economy_note_receipt"), sql.indexOf("function economy_settle_proposal"));
    expect(note.indexOf("'duplicate', true")).toBeLessThan(note.indexOf("update economy_proposals"));
    expect(note.indexOf("different transaction")).toBeLessThan(note.indexOf("update economy_proposals"));
    const settle = sql.slice(sql.indexOf("function economy_settle_proposal"), sql.indexOf("revoke all on function economy_try_hold"));
    expect(settle.indexOf("'duplicate', true")).toBeLessThan(settle.indexOf("update economy_proposals"));
    expect(settle.indexOf("different transaction")).toBeLessThan(settle.indexOf("update economy_proposals"));
    expect(settle).toContain("settlement requires a counted journal posting");
    expect(sql).toContain("revoke all");
    expect(sql).toContain("service_role");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("execution_enabled");
    expect(sql).not.toContain("watcher_");
    expect(sql).not.toMatch(/0x[0-9a-f]{64}/);

    const db = readFileSync("src/lib/economy/db.ts", "utf8");
    expect(db).toContain("verifyMainnetReceipt");
    expect(db).not.toContain("VerifiedReceipt");
    expect(db).toContain('reported === "conflict"');
    const confirm = db.slice(db.indexOf("function confirmEconomyReceipt"), db.indexOf("function settleEconomyProposal"));
    expect(confirm.indexOf("verifyMainnetReceipt")).toBeGreaterThanOrEqual(0);
    expect(confirm.indexOf("verifyMainnetReceipt")).toBeLessThan(confirm.indexOf("economy_note_receipt"));
    const settleFn = db.slice(db.indexOf("function settleEconomyProposal"), db.indexOf("function economyRpc"));
    expect(settleFn.indexOf("verifyMainnetReceipt")).toBeLessThan(settleFn.indexOf("economy_settle_proposal"));
    expect(readFileSync("src/lib/economy/verify-receipt.ts", "utf8")).not.toMatch(/sendTransaction|writeContract|signTransaction|walletClient|eth_sendRawTransaction/);
    expect(readFileSync("src/lib/economy/observe.ts", "utf8")).not.toMatch(/sendTransaction|writeContract|deployContract|signTransaction|walletClient/);
    expect(readFileSync("src/lib/economy/observe.ts", "utf8")).toContain("addresses.chogToken");
    expect(readFileSync("src/lib/economy/production.ts", "utf8")).toContain("executionEnabled: false");
    expect(readFileSync("src/lib/economy/production.ts", "utf8")).toContain("factoryDeployed: false");
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).toContain("assertExecutionDisabled");
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).not.toContain("economy_try_hold");
    expect(readFileSync("src/components/shell/nav.tsx", "utf8")).not.toContain('href: "/economy"');
    expect(readFileSync("supabase/migrations/20261019230000_phase7_economy.sql", "utf8")).toContain("economy_try_hold");
  });
});
