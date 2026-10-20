import { readFileSync, readdirSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as getActivity } from "@/app/api/economy/activity/route";
import { POST as postTransaction } from "@/app/api/transactions/route";
import { addresses } from "@/lib/blockchain/addresses";
import { CHOG_TRANSFER_TOPIC } from "@/lib/economy/decode-transfer";
import {
  activityCursorError,
  DISCOVERY_HARD_LIMITS,
  discoverChogActivity,
  resetDiscoveredActivityState,
  type DiscoveredActivityPage,
} from "@/lib/economy/discover-activity";
import { productionExecutionStatus } from "@/lib/economy/execution";
import { treasuryPosition, type JournalLine } from "@/lib/economy/journal";
import { jsonRpcCaller, type RpcCaller } from "@/lib/economy/verify-receipt";

const TX = `0x${"11".repeat(32)}` as Hex;
const OTHER_TX = `0x${"22".repeat(32)}` as Hex;
const SENDER = getAddress("0x2222222222222222222222222222222222222222");
const RECIPIENT = getAddress("0x3333333333333333333333333333333333333333");
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const OTHER_TOKEN = getAddress("0x4444444444444444444444444444444444444444");
const STALE = `0x${"ab".repeat(32)}` as Hex;
const CANONICAL = `0x${"cd".repeat(32)}` as Hex;

type LogSpec = {
  block: bigint;
  index?: number;
  tx?: Hex;
  from?: Address;
  to?: Address;
  amount?: bigint;
  token?: Address;
  topics?: string[];
  data?: string;
  blockHash?: Hex;
  removed?: boolean;
};

beforeEach(() => {
  resetDiscoveredActivityState();
});

describe("phase 10 mainnet activity discovery", () => {
  it("queries only the configured token and the canonical transfer topic", async () => {
    const chain = harness({ logs: [log({ block: 40n })] });
    const page = await discover(chain);
    expect(chain.filters).toHaveLength(1);
    expect(chain.filters[0]).toMatchObject({
      address: addresses.chogToken,
      topics: [CHOG_TRANSFER_TOPIC],
    });
    expect(CHOG_TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(page.items[0]).toMatchObject({
      status: "verified",
      fresh: true,
      cached: false,
      evidence: "fresh_canonical_receipt",
      token: addresses.chogToken,
      txHash: TX,
      logIndex: 0,
      from: SENDER,
      to: RECIPIENT,
      amountRaw: "1000000000000000000",
      countsInTreasury: false,
      direction: "unattributed",
      treasuryAttributed: false,
    });
    expect(page.items[0]?.verificationLabel).toMatch(/Fresh verification/);
    expect(page.items[0]?.explorerHref).toBe(`https://monadscan.com/tx/${TX}`);
    expect(page.state).toBe("verified_page");
    expect(chain.methods).not.toContain("eth_sendRawTransaction");
  });

  it("keeps the raw amount exact and does not use a rounded float", async () => {
    const amount = 10n ** 18n + 1n;
    const chain = harness({ logs: [log({ block: 40n, amount })] });
    const page = await discover(chain);
    expect(page.items[0]?.amountRaw).toBe("1000000000000000001");
    expect(page.items[0]?.amountText).toBe("1.000000000000000001 $CHOG");
    expect(page.items[0]?.amountRaw).not.toContain(".");
    expect(page.decimalsNote).toMatch(/did not read decimals/);
    expect(page.accountingNote).toMatch(/not proposals/);
  });

  it("names a configured treasury without counting the transfer", async () => {
    const lines: JournalLine[] = [];
    const before = treasuryPosition(lines, "CHOG");
    const chain = harness({ logs: [log({ block: 40n, to: TREASURY })] });
    const page = await discover(chain, { treasury: TREASURY });
    expect(page.items[0]).toMatchObject({
      direction: "treasury_in",
      treasuryAttributed: true,
      countsInTreasury: false,
      to: TREASURY,
    });
    expect(page.items[0]?.directionNote).toMatch(/did not post it to the ledger/);
    expect(treasuryPosition(lines, "CHOG")).toBe(before);
    expect(lines).toHaveLength(0);
  });

  it("rejects another contract, the wrong topic, and malformed logs", async () => {
    const chain = harness({
      logs: [
        log({ block: 40n, token: OTHER_TOKEN }),
        log({ block: 41n, topics: [`0x${"ab".repeat(32)}`, topicAddress(SENDER), topicAddress(RECIPIENT)] }),
        log({ block: 42n, data: "0x1234" }),
        log({ block: 43n, removed: true }),
        log({ block: 44n, amount: 0n }),
        log({ block: 45n, topics: [CHOG_TRANSFER_TOPIC, topicAddress(SENDER)] }),
      ],
    });
    const page = await discover(chain);
    expect(page.items).toHaveLength(0);
    expect(page.state).toBe("partial");
    expect(page.dropped).toMatchObject({ foreign: 1, wrongTopic: 1, malformed: 4 });
    expect(page.detail).toMatch(/another contract/);
    expect(page.detail).toMatch(/another topic/);
    expect(page.detail).toMatch(/malformed/);
    expect(page.detail).not.toMatch(/No \$CHOG Transfer logs were found/);
    expect(chain.methods).not.toContain("eth_getTransactionReceipt");
  });

  it("orders newest first, deduplicates, and continues without repeating a shown log", async () => {
    const chain = harness({
      tip: 100n,
      logs: [
        log({ block: 80n, index: 0, tx: TX }),
        log({ block: 80n, index: 0, tx: TX }),
        log({ block: 80n, index: 2, tx: TX }),
        log({ block: 70n, index: 5, tx: OTHER_TX }),
        log({ block: 90n, index: 1, tx: hashOf(3) }),
      ],
    });
    const page = await discover(chain, { limits: { maxBlocks: 100n, maxDisplay: 3, maxVerified: 3 } });
    expect(page.items.map((item) => [item.blockNumber, item.logIndex, item.txHash])).toEqual([
      ["90", 1, hashOf(3)],
      ["80", 2, TX],
      ["80", 0, TX],
    ]);
    expect(page.dropped.duplicate).toBe(1);
    expect(page.nextCursor).toBeTruthy();

    const older = await discover(chain, {
      cursor: page.nextCursor,
      limits: { maxBlocks: 100n, maxDisplay: 3, maxVerified: 3 },
    });
    expect(older.items.map((item) => item.txHash)).toEqual([OTHER_TX]);
    expect(older.items[0]?.blockNumber).toBe("70");
    expect(older.items.some((item) => item.txHash === TX || item.txHash === hashOf(3))).toBe(false);
  });

  it("splits a provider range limit and does not call an empty limit failure a completed scan", async () => {
    const limited = harness({ tip: 100n, limitAbove: 50n, logs: [log({ block: 80n })] });
    const page = await discover(limited, { limits: { maxBlocks: 100n, chunkBlocks: 100n, minChunkBlocks: 10n } });
    expect(limited.filters.length).toBeGreaterThan(1);
    expect(spans(limited.filters)[0]).toBeGreaterThan(50n);
    expect(spans(limited.filters).at(-1)).toBeLessThanOrEqual(50n);
    expect(page.items).toHaveLength(1);
    expect(page.state).toBe("verified_page");

    const blocked = harness({ tip: 100n, alwaysLimit: true, logs: [log({ block: 80n })] });
    const failed = await discover(blocked, { limits: { maxBlocks: 100n, chunkBlocks: 100n, minChunkBlocks: 10n } });
    expect(failed.items).toHaveLength(0);
    expect(failed.state).toBe("partial");
    expect(failed.detail).toMatch(/limited to a 100 range/);
    expect(failed.detail).not.toMatch(/No \$CHOG Transfer logs were found/);
    expect(failed.detail).toMatch(/not a claim that the token has no transfers/);
  });

  it("reports an empty window and a partial window separately", async () => {
    const empty = harness({ tip: 20n, logs: [] });
    const none = await discover(empty, { limits: { maxBlocks: 100n } });
    expect(none.state).toBe("empty_window");
    expect(none.items).toHaveLength(0);
    expect(none.scannedFrom).toBe("0");
    expect(none.detail).toMatch(/No \$CHOG Transfer logs were found in blocks 0–20/);
    expect(none.nextCursor).toBeNull();

    const older = harness({ tip: 250n, logs: [] });
    const window = await discover(older, { limits: { maxBlocks: 100n, chunkBlocks: 100n } });
    expect(window.state).toBe("empty_window");
    expect(window.scannedFrom).toBe("151");
    expect(window.scannedTo).toBe("250");
    expect(window.detail).toMatch(/Older blocks were not scanned/);
    expect(window.nextCursor).toBeTruthy();

    const next = await discover(older, { cursor: window.nextCursor, limits: { maxBlocks: 100n, chunkBlocks: 100n } });
    expect(next.scannedTo).toBe("150");
    expect(BigInt(next.scannedFrom ?? "0")).toBeLessThan(151n);
  });

  it("caps the scanned span, the displayed rows, and the RPC budget", async () => {
    const chain = harness({
      tip: 1_000n,
      logs: [log({ block: 990n, tx: TX }), log({ block: 10n, tx: OTHER_TX })],
    });
    const page = await discover(chain, { limits: { maxBlocks: 100_000n, maxDisplay: 9, maxVerified: 9, maxRpcCalls: 1_000 } });
    const width = BigInt(page.scannedTo ?? "0") - BigInt(page.scannedFrom ?? "0") + 1n;
    expect(width).toBeLessThanOrEqual(DISCOVERY_HARD_LIMITS.maxBlocks);
    expect(page.items.map((item) => item.txHash)).toEqual([TX]);
    expect(page.detail).toMatch(/Older blocks or logs were not included/);
    expect(DISCOVERY_HARD_LIMITS.maxDisplay).toBe(3);
    expect(DISCOVERY_HARD_LIMITS.maxVerified).toBe(3);
    expect(DISCOVERY_HARD_LIMITS.maxRpcCalls).toBe(24);

    const crowded = harness({
      tip: 100n,
      logs: [log({ block: 90n, tx: TX }), log({ block: 80n, tx: OTHER_TX }), log({ block: 70n, tx: hashOf(3) })],
    });
    const budgeted = await discover(crowded, { limits: { maxBlocks: 100n, maxVerified: 1, maxDisplay: 1, maxRpcCalls: 4 } });
    expect(budgeted.items).toHaveLength(0);
    expect(budgeted.state).toBe("budget");
    expect(budgeted.detail).toMatch(/read budget/);
    expect(budgeted.detail).toMatch(/not a claim that the token has no transfers/);
    expect(budgeted.rpcCalls).toBeLessThanOrEqual(4);
  });

  it("stops verifying once the receipt budget is spent and continues at the unverified log", async () => {
    const chain = harness({
      tip: 100n,
      logs: [log({ block: 90n, tx: TX }), log({ block: 80n, tx: OTHER_TX })],
    });
    const page = await discover(chain, { limits: { maxBlocks: 100n, maxVerified: 1, maxDisplay: 3 } });
    expect(page.state).toBe("budget");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.txHash).toBe(TX);
    expect(page.detail).toMatch(/receipt-verification budget/);
    const older = await discover(chain, { cursor: page.nextCursor, limits: { maxBlocks: 100n, maxVerified: 1, maxDisplay: 3 } });
    expect(older.items.map((item) => item.txHash)).toEqual([OTHER_TX]);
  });

  it("rejects a bad cursor before any RPC and binds a valid cursor to chain 143 and $CHOG", async () => {
    const chain = harness({ tip: 100n, logs: [log({ block: 40n })] });
    const rejected = await discover(chain, { cursor: "not a cursor" });
    expect(rejected.state).toBe("invalid_cursor");
    expect(chain.methods).toHaveLength(0);
    expect(activityCursorError(cursor({ token: OTHER_TOKEN }))).toMatch(/configured \$CHOG/);
    expect(activityCursorError(cursor({ chainId: 1 }))).toMatch(/Monad mainnet/);
    expect(activityCursorError(cursor({ v: 2 }))).toMatch(/Monad mainnet/);
    expect(activityCursorError(`${cursor({})}extra`)).toBeTruthy();
    expect(activityCursorError("a".repeat(513))).toMatch(/too long/);

    const ahead = await discover(chain, { cursor: cursor({ block: "100000" }) });
    expect(ahead.state).toBe("invalid_cursor");
    expect(ahead.detail).toMatch(/above the current chain tip/);
    expect(chain.methods).not.toContain("eth_getLogs");

    const done = await discover(chain, { cursor: cursor({ block: "0", log: 0 }) });
    expect(done.state).toBe("empty_window");
    expect(done.detail).toMatch(/start of Monad mainnet/);
    expect(chain.methods).not.toContain("eth_getTransactionReceipt");
  });
});

describe("phase 10 receipt matching", () => {
  it("does not display a log whose receipt is missing, reverted, mismatched, or reorganized", async () => {
    const missing = harness({ logs: [log({ block: 40n })], receipts: { [TX]: null } });
    const missingPage = await discover(missing);
    expect(missingPage.items).toHaveLength(0);
    expect(missingPage.dropped.unavailable).toBe(1);
    expect(missingPage.state).toBe("partial");

    resetDiscoveredActivityState();
    const reverted = harness({
      logs: [log({ block: 40n })],
      receipts: { [TX]: receiptOf(log({ block: 40n }), { status: "0x0" }) },
    });
    const revertedPage = await discover(reverted);
    expect(revertedPage.items).toHaveLength(0);
    expect(revertedPage.dropped.reverted).toBe(1);
    expect(revertedPage.detail).toMatch(/reverted/);
    expect(revertedPage.headline).not.toMatch(/Fresh verification: each listed/);

    resetDiscoveredActivityState();
    const mismatched = harness({
      logs: [log({ block: 40n })],
      receipts: { [TX]: receiptOf(log({ block: 40n }), { transactionHash: OTHER_TX }) },
    });
    const mismatchPage = await discover(mismatched);
    expect(mismatchPage.items).toHaveLength(0);
    expect(mismatchPage.dropped.inconsistent).toBe(1);

    resetDiscoveredActivityState();
    const otherIndex = receiptOf(log({ block: 40n, index: 7 }));
    const unmatched = harness({ logs: [log({ block: 40n, index: 0 })], receipts: { [TX]: otherIndex } });
    const unmatchedPage = await discover(unmatched);
    expect(unmatchedPage.items).toHaveLength(0);
    expect(unmatchedPage.dropped.unmatched).toBe(1);

    resetDiscoveredActivityState();
    const staleLog = log({ block: 40n, blockHash: STALE });
    const reorg = harness({
      logs: [staleLog],
      canonical: { 40: CANONICAL },
      receipts: { [TX]: receiptOf(log({ block: 40n, blockHash: CANONICAL })) },
    });
    const reorgPage = await discover(reorg);
    expect(reorgPage.items).toHaveLength(0);
    expect(reorgPage.dropped.inconsistent).toBe(1);

    resetDiscoveredActivityState();
    const moved = harness({ logs: [log({ block: 40n })], reorg: { block: 40n, hash: CANONICAL } });
    const movedPage = await discover(moved);
    expect(movedPage.items).toHaveLength(0);
    expect(movedPage.dropped.inconsistent).toBe(1);
    expect(movedPage.headline).not.toMatch(/Fresh verification: each listed/);
  });

  it("rejects the wrong chain, a hung receipt, and a credential-bearing RPC error", async () => {
    const wrong = harness({ chain: "0x1", logs: [log({ block: 40n })] });
    const wrongPage = await discover(wrong);
    expect(wrongPage.state).toBe("unsupported");
    expect(wrongPage.items).toHaveLength(0);
    expect(wrong.methods).toEqual(["eth_chainId"]);

    resetDiscoveredActivityState();
    const changed = harness({ chainSequence: ["0x8f", "0x1"], logs: [log({ block: 40n })] });
    const changedPage = await discover(changed);
    expect(changedPage.items).toHaveLength(0);
    expect(changedPage.dropped.inconsistent).toBe(1);

    resetDiscoveredActivityState();
    const hung = harness({ hangOn: "eth_getTransactionReceipt", logs: [log({ block: 40n })] });
    const timed = await discover(hung, { timeoutMs: 20 });
    expect(timed.items).toHaveLength(0);
    expect(timed.state).toBe("partial");
    expect(timed.detail).toMatch(/did not respond in time/);

    resetDiscoveredActivityState();
    const leaked = harness({ throwOn: "eth_getLogs", logs: [log({ block: 40n })] });
    const hidden = await discover(leaked);
    expect(hidden.state).toBe("unavailable");
    expect(hidden.detail).toContain("[redacted-url]");
    expect(hidden.detail).not.toContain("secret-token");
    expect(hidden.detail).not.toMatch(/https:\/\//);
    expect(hidden.detail).toMatch(/not a claim that the token has no transfers/);
  });

  it("labels a second read as cached and shares one in-flight verification", async () => {
    const chain = harness({ logs: [log({ block: 40n })] });
    const first = await discover(chain, { nowMs: 1_000 });
    const receiptReads = chain.receiptReads;
    const second = await discover(chain, { nowMs: 2_000 });
    expect(first.items[0]).toMatchObject({ fresh: true, cached: false });
    expect(second.items[0]).toMatchObject({
      fresh: false,
      cached: true,
      evidence: "cached_canonical_receipt",
      checkedAt: first.items[0]?.checkedAt,
      amountRaw: first.items[0]?.amountRaw,
    });
    expect(second.items[0]?.verificationLabel).toMatch(/not a fresh verification/);
    expect(second.headline).toMatch(/not a fresh verification/);
    expect(chain.receiptReads).toBe(receiptReads);

    resetDiscoveredActivityState();
    const parallel = harness({ logs: [log({ block: 40n })], receiptDelayMs: 40 });
    const [left, right] = await Promise.all([discover(parallel, { nowMs: 5_000 }), discover(parallel, { nowMs: 5_000 })]);
    expect(parallel.receiptReads).toBe(1);
    expect(left.items[0]?.fresh).toBe(true);
    expect(right.items[0]?.fresh).toBe(true);
    expect(left.items[0]?.cached).toBe(false);
    expect(right.items[0]?.cached).toBe(false);
  });
});

describe("phase 10 safety boundaries", () => {
  it("refuses caller-chosen contracts, topics, and unbounded ranges at the RPC client", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      const body = String(init?.body);
      if (body.includes("eth_getLogs")) {
        expect(body).toContain(addresses.chogToken);
        expect(body).toContain(CHOG_TRANSFER_TOPIC);
      }
      expect(body).not.toContain("secret-token");
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }) } as Response;
    };
    try {
      const caller = jsonRpcCaller("https://rpc.example/secret-token");
      await expect(
        caller("eth_getLogs", [
          {
            address: OTHER_TOKEN,
            fromBlock: "0x1",
            toBlock: "0x2",
            topics: [CHOG_TRANSFER_TOPIC],
          },
        ]),
      ).rejects.toThrow(/rejected/);
      await expect(
        caller("eth_getLogs", [
          {
            address: addresses.chogToken,
            fromBlock: "0x0",
            toBlock: "0x64",
            topics: [CHOG_TRANSFER_TOPIC],
          },
        ]),
      ).rejects.toThrow(/rejected/);
      await expect(caller("eth_getLogs", [{ address: addresses.chogToken, fromBlock: "0x2", toBlock: "0x1", topics: [CHOG_TRANSFER_TOPIC] }])).rejects.toThrow(/rejected/);
      await expect(caller("eth_sendRawTransaction", ["0x00"])).rejects.toThrow(/read-only/);
      expect(calls).toBe(0);
      const logs = await caller("eth_getLogs", [
        { address: addresses.chogToken, fromBlock: "0x1", toBlock: "0x2", topics: [CHOG_TRANSFER_TOPIC] },
      ]);
      expect(logs).toEqual([]);
      expect(calls).toBe(1);
      const tip = await caller("eth_blockNumber", []);
      expect(tip).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rate limits the public route and rejects token, topic, and range parameters", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("https://rpc.example/secret-token");
    };
    try {
      const blocked = await getActivity(
        new Request("https://chogos.vercel.app/api/economy/activity?token=0x4444444444444444444444444444444444444444", {
          headers: { "x-forwarded-for": "203.0.113.77" },
        }),
      );
      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toMatchObject({ ok: false, state: "invalid_request" });
      expect(blocked.headers.get("cache-control")).toBe("no-store");

      const ranged = await getActivity(new Request("https://chogos.vercel.app/api/economy/activity?fromBlock=0x0&toBlock=0xfffffff", { headers: { "x-forwarded-for": "203.0.113.78" } }));
      expect(ranged.status).toBe(400);
      const topic = await getActivity(new Request("https://chogos.vercel.app/api/economy/activity?topic=0x1234", { headers: { "x-forwarded-for": "203.0.113.79" } }));
      expect(topic.status).toBe(400);
      const limit = await getActivity(new Request("https://chogos.vercel.app/api/economy/activity?limit=9", { headers: { "x-forwarded-for": "203.0.113.80" } }));
      expect(limit.status).toBe(400);
      const ambiguous = await getActivity(new Request("https://chogos.vercel.app/api/economy/activity?cursor=a&cursor=b", { headers: { "x-forwarded-for": "203.0.113.81" } }));
      expect(ambiguous.status).toBe(400);
      const badCursor = await getActivity(new Request("https://chogos.vercel.app/api/economy/activity?cursor=not-a-cursor", { headers: { "x-forwarded-for": "203.0.113.82" } }));
      expect(badCursor.status).toBe(400);
      expect(await badCursor.json()).toMatchObject({ state: "invalid_cursor" });
      expect(calls).toBe(0);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await getActivity(
          new Request("https://chogos.vercel.app/api/economy/activity?contract=0x1", { headers: { "x-forwarded-for": "203.0.113.83" } }),
        );
        expect(response.status).toBe(400);
      }
      const limited = await getActivity(
        new Request("https://chogos.vercel.app/api/economy/activity?contract=0x1", { headers: { "x-forwarded-for": "203.0.113.83" } }),
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ ok: false, reason: "Too many requests." });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not write accounting data, enable execution, or add a migration", async () => {
    const execution = await postTransaction();
    expect(execution.status).toBe(403);
    expect(await execution.json()).toMatchObject({ ok: false });
    const status = productionExecutionStatus({});
    expect(status.enabled).toBe(false);
    expect(status.signerKind).toBe("none");
    expect(status.relayerEnabled).toBe(false);
    expect(status.transactionsRoute).toBe("closed");

    expect(readdirSync("supabase/migrations").some((name) => name.includes("phase10"))).toBe(false);
    const files = [
      "src/lib/economy/discover-activity.ts",
      "src/lib/economy/discover-load.ts",
      "src/app/api/economy/activity/route.ts",
      "src/app/economy/page.tsx",
      "src/components/economy/discovered-activity.tsx",
      "src/lib/economy/verify-receipt.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("economy_note_receipt");
      expect(source, file).not.toContain("economy_append_journal");
      expect(source, file).not.toContain("economy_settle_proposal");
      expect(source, file).not.toContain("createEconomyVerifierClient");
      expect(source, file).not.toContain("SUPABASE_ECONOMY_VERIFIER_KEY");
      expect(source, file).not.toContain("eth_sendRawTransaction");
      expect(source, file).not.toContain("signTransaction");
      expect(source, file).not.toContain("walletClient");
    }
    const discovery = readFileSync("src/lib/economy/discover-activity.ts", "utf8");
    expect(discovery).not.toContain("scanTransfers");
    expect(discovery).not.toContain("chogWatcherEnabled");
    expect(discovery).toContain("verifyMainnetReceipt");
    expect(discovery).toContain("addresses.chogToken");
    expect(readFileSync("src/lib/economy/discover-load.ts", "utf8").startsWith('import "server-only"')).toBe(true);
    expect(readFileSync("src/lib/economy/discover-load.ts", "utf8")).not.toContain("openEconomyClient");
    expect(readFileSync("src/app/api/economy/activity/route.ts", "utf8")).toContain("rateLimit");
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).toContain("assertExecutionDisabled");
    expect(readFileSync("src/app/economy/page.tsx", "utf8")).toContain("DiscoveredActivityPanel");
    expect(readFileSync("src/components/economy/discovered-activity.tsx", "utf8")).toContain("Discovered Mainnet Activity");
  });
});

function discover(
  chain: ReturnType<typeof harness>,
  input: { treasury?: Address | null; cursor?: string | null; nowMs?: number; timeoutMs?: number; limits?: Parameters<typeof discoverChogActivity>[0]["limits"] } = {},
): Promise<DiscoveredActivityPage> {
  return discoverChogActivity({
    call: chain.call,
    treasury: input.treasury ?? null,
    cursor: input.cursor,
    nowMs: input.nowMs ?? 1_000,
    timeoutMs: input.timeoutMs,
    limits: { maxBlocks: 100n, chunkBlocks: 100n, ...input.limits },
  });
}

function cursor(input: { v?: number; chainId?: number; token?: string; block?: string; log?: number | null; extra?: boolean }): string {
  const payload: Record<string, unknown> = {
    v: input.v ?? 1,
    chainId: input.chainId ?? 143,
    token: (input.token ?? addresses.chogToken).toLowerCase(),
    block: input.block ?? "10",
    log: input.log === undefined ? null : input.log,
  };
  if (input.extra) {
    payload.extra = true;
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function harness(options: {
  tip?: bigint;
  chain?: unknown;
  chainSequence?: unknown[];
  logs?: LogSpec[];
  receipts?: Record<string, unknown>;
  canonical?: Record<number, Hex>;
  reorg?: { block: bigint; hash: Hex };
  throwOn?: string;
  hangOn?: string;
  limitAbove?: bigint;
  alwaysLimit?: boolean;
  receiptDelayMs?: number;
} = {}): { call: RpcCaller; methods: string[]; filters: Array<{ address?: string; fromBlock?: string; toBlock?: string; topics?: string[] }>; receiptReads: number } {
  const methods: string[] = [];
  const filters: Array<{ address?: string; fromBlock?: string; toBlock?: string; topics?: string[] }> = [];
  let receiptReads = 0;
  let chainReads = 0;
  const call: RpcCaller = (method, params) => {
    methods.push(method);
    if (options.hangOn === method) {
      return new Promise(() => undefined);
    }
    if (options.throwOn === method) {
      return Promise.reject(new Error("connect failed https://rpc.example/secret-token"));
    }
    if (method === "eth_chainId") {
      chainReads += 1;
      const sequenced = options.chainSequence?.[chainReads - 1];
      return Promise.resolve(sequenced ?? (options.chain === undefined ? "0x8f" : options.chain));
    }
    if (method === "eth_blockNumber") {
      return Promise.resolve(hex(options.tip ?? 100n));
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as { address?: string; fromBlock?: string; toBlock?: string; topics?: string[] };
      filters.push(filter);
      const from = BigInt(filter.fromBlock ?? "0x0");
      const to = BigInt(filter.toBlock ?? "0x0");
      if (options.alwaysLimit || (options.limitAbove != null && to - from + 1n > options.limitAbove)) {
        return Promise.reject(new Error("eth_getLogs is limited to a 100 range"));
      }
      const rows = (options.logs ?? []).filter((item) => item.block >= from && item.block <= to).map((item) => rawLog(item));
      return Promise.resolve(rows);
    }
    if (method === "eth_getTransactionReceipt") {
      receiptReads += 1;
      const tx = String(params[0]);
      const produce = () => {
        if (options.receipts && tx in options.receipts) {
          return options.receipts[tx];
        }
        const rows = (options.logs ?? []).filter((item) => (item.tx ?? TX) === tx);
        const unique: LogSpec[] = [];
        const seen = new Set<number>();
        for (const item of rows) {
          const index = item.index ?? 0;
          if (seen.has(index)) {
            continue;
          }
          seen.add(index);
          unique.push(item);
        }
        const first = unique[0];
        if (!first) {
          return null;
        }
        return receiptOf(first, { logs: unique.map((item) => rawLog(item)) });
      };
      if (options.receiptDelayMs) {
        return new Promise((resolve) => setTimeout(() => resolve(produce()), options.receiptDelayMs));
      }
      return Promise.resolve(produce());
    }
    if (method === "eth_getBlockByNumber") {
      const number = BigInt(String(params[0]));
      if (options.reorg && options.reorg.block === number) {
        return Promise.resolve({ number: params[0], hash: options.reorg.hash });
      }
      const override = options.canonical?.[Number(number)];
      if (override) {
        return Promise.resolve({ number: params[0], hash: override });
      }
      const found = (options.logs ?? []).find((item) => item.block === number);
      return Promise.resolve({ number: params[0], hash: found?.blockHash ?? defaultBlockHash(number) });
    }
    return Promise.reject(new Error(method));
  };
  return {
    call,
    methods,
    filters,
    get receiptReads() {
      return receiptReads;
    },
  };
}

function spans(filters: Array<{ fromBlock?: string; toBlock?: string }>): bigint[] {
  return filters.map((filter) => BigInt(filter.toBlock ?? "0x0") - BigInt(filter.fromBlock ?? "0x0") + 1n);
}

function log(input: LogSpec): LogSpec {
  return input;
}

function rawLog(input: LogSpec) {
  const index = input.index ?? 0;
  const amount = input.amount ?? 10n ** 18n;
  return {
    address: input.token ?? addresses.chogToken,
    topics: input.topics ?? [CHOG_TRANSFER_TOPIC, topicAddress(input.from ?? SENDER), topicAddress(input.to ?? RECIPIENT)],
    data: input.data ?? word(amount),
    blockNumber: hex(input.block),
    blockHash: input.blockHash ?? defaultBlockHash(input.block),
    transactionHash: input.tx ?? TX,
    logIndex: hex(BigInt(index)),
    removed: input.removed,
  };
}

function receiptOf(input: LogSpec, override: { status?: string; transactionHash?: string; logs?: unknown[] } = {}) {
  return {
    transactionHash: override.transactionHash ?? input.tx ?? TX,
    status: override.status ?? "0x1",
    blockNumber: hex(input.block),
    blockHash: input.blockHash ?? defaultBlockHash(input.block),
    logs: override.logs ?? [rawLog(input)],
  };
}

function topicAddress(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}` as Hex;
}

function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function hashOf(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
}

function defaultBlockHash(block: bigint): Hex {
  return `0x${block.toString(16).padStart(64, "f")}` as Hex;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
