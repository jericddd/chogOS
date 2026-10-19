import { readFileSync } from "node:fs";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { sponsorSessionCall, type SessionGuard } from "@/lib/chogbank/engine";
import { MemoryChogBankStore } from "@/lib/chogbank/memory-store";
import { chogBankOpsStatus } from "@/lib/chogbank/ops-status";
import { preflightExecuteSession } from "@/lib/chogbank/preflight";
import { reconcileReceipt } from "@/lib/chogbank/receipts";
import { gateRelayerOp } from "@/lib/chogbank/relayer-gate";
import { createDisabledRelayer } from "@/lib/chogbank/relayer";
import { DEFAULT_BANK_LIMITS, UNSET_TREASURY } from "@/lib/chogbank/runtime";
import { loadProtectedSigner } from "@/lib/chogbank/signer";
import type { ActivationRequest, Reservation, SessionPolicy, SponsoredJob } from "@/lib/chogbank/types";
import { readAppConfig } from "@/lib/config/env";
import { assessWatcher } from "@/lib/watcher/health";
import { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import { scanTransfers } from "@/lib/watcher/scan";
import type { BlockHeader, LogSource, RawTransfer, WatcherHealth } from "@/lib/watcher/types";
import { initialize, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

const genesis = addresses.chogGenesis;
const ownerA = getAddress("0x2222222222222222222222222222222222222222");
const ownerB = getAddress("0x3333333333333333333333333333333333333333");
const executor = getAddress("0x4444444444444444444444444444444444444444");
const account = getAddress("0x7777777777777777777777777777777777777777");
const otherNft = getAddress("0x9999999999999999999999999999999999999999");
const ping = toFunctionSelector("ping(uint256)");

function word(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

class FakeChain implements LogSource {
  blocks: BlockHeader[] = [];
  logs: RawTransfer[] = [];
  tip = 0n;
  fail: "latest" | "header" | "logs" | null = null;

  latest() {
    if (this.fail === "latest") {
      return Promise.resolve({ error: "rpc latest failed" });
    }
    const header = this.blocks.find((block) => block.number === this.tip);
    return Promise.resolve(header ?? { error: "missing tip" });
  }

  header(blockNumber: bigint) {
    if (this.fail === "header") {
      return Promise.resolve({ error: "rpc header failed" });
    }
    const header = this.blocks.find((block) => block.number === blockNumber);
    return Promise.resolve(header ?? { error: "missing block" });
  }

  transfers(fromBlock: bigint, toBlock: bigint) {
    if (this.fail === "logs") {
      return Promise.resolve({ error: "rpc logs failed" });
    }
    return Promise.resolve(
      this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
    );
  }
}

function header(number: number, parent: number): BlockHeader {
  return { number: BigInt(number), hash: word(number), parentHash: word(parent) };
}

function transfer(input: {
  block: number;
  logIndex: number;
  tokenId: bigint;
  from: Address;
  to: Address;
  tx?: number;
}): RawTransfer {
  return {
    blockNumber: BigInt(input.block),
    blockHash: word(input.block),
    transactionHash: word(1_000 + (input.tx ?? input.block)),
    transactionIndex: 0,
    logIndex: input.logIndex,
    address: genesis,
    from: input.from,
    to: input.to,
    tokenId: input.tokenId,
  };
}

function session(patch: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    executor,
    ownerAtOpen: ownerA,
    target: getAddress("0x5555555555555555555555555555555555555555"),
    selector: ping,
    maxValuePerCall: 0n,
    maxCumulativeValue: 0n,
    spent: 0n,
    expiresAt: 2_000,
    openedBlock: 10n,
    nonce: 0n,
    dead: false,
    paused: false,
    ...patch,
  };
}

function healthOf(store: MemoryWatcherStore, tip: bigint, nowMs = Date.parse("2026-10-19T00:00:00.000Z")): WatcherHealth {
  return assessWatcher({ store, tipBlock: tip, nowMs, maxLagBlocks: 2n, maxStaleMs: 60_000 });
}

function guardFor(store: MemoryWatcherStore, health: WatcherHealth): SessionGuard {
  return {
    ready() {
      return health.executionAllowed ? { ok: true } : { ok: false, reason: `watcher is ${health.status}` };
    },
    transfersAfter(tokenId, openedBlock) {
      return store.transfersAfter(tokenId, openedBlock).map((log) => ({
        blockNumber: log.blockNumber,
        from: log.from,
        to: log.to,
      }));
    },
  };
}

async function activeBank() {
  const store = new MemoryChogBankStore();
  const request: ActivationRequest = {
    id: "req-1",
    citizenId: "citizen-1",
    tokenId: "7",
    chainId: 143,
    nftContract: genesis,
    motive: "payment",
    goal: "Receive an onchain payment for a completed tool order",
    proposedActions: "call the market contract through the open session",
    revenueHypothesis: "a payment may arrive; it is not treasury revenue yet",
    estimatedDeploymentWei: 1n,
    estimatedGasWei: 1n,
    decisionId: null,
    state: "active",
    predictedAddress: account,
    accountAddress: account,
    reservationId: null,
    rejectReason: null,
    createdAt: "2026-10-19T00:00:00.000Z",
  };
  await store.saveRequest(request);
  await store.saveSession(request.id, session());
  return { store, request };
}

describe("transfer watcher", () => {
  it("revokes on A→B and on A→B→A even when the owner returns", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11)];
    chain.tip = 12n;
    chain.logs = [
      transfer({ block: 11, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB }),
      transfer({ block: 12, logIndex: 1, tokenId: 7n, from: ownerB, to: ownerA }),
    ];
    const store = new MemoryWatcherStore(genesis, 10n);
    store.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    const report = await scanTransfers(store, chain, "2026-10-19T00:00:00.000Z");
    expect(report.ok).toBe(true);
    expect(store.invalidations).toHaveLength(1);
    expect(store.invalidations[0]?.state).toBe("queued");
    expect(store.logs.map((log) => log.blockNumber)).toEqual([11n, 12n]);
    const health = healthOf(store, 12n);
    expect(health.status).toBe("healthy");
    expect(health.executionAllowed).toBe(true);
    const roundTrip = preflightExecuteSession({
      health,
      chainId: 143,
      nftContract: genesis,
      account,
      tokenId: "7",
      expectedTokenId: "7",
      expectedAccount: account,
      currentOwner: ownerA,
      session: session(),
      transfersAfterOpen: store.transfersAfter("7", 10n),
    });
    expect(roundTrip).toMatchObject({ ok: false, invalidate: true });
  });

  it("backfills after a restart, ignores duplicate logs, and survives a missed interval", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11), header(13, 12)];
    chain.tip = 11n;
    chain.logs = [transfer({ block: 11, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB })];
    const store = new MemoryWatcherStore(genesis, 10n);
    store.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await scanTransfers(store, chain, "2026-10-19T00:00:00.000Z");
    const restarted = MemoryWatcherStore.fromSnapshot(store.snapshot());
    chain.tip = 13n;
    chain.logs.push(transfer({ block: 13, logIndex: 4, tokenId: 7n, from: ownerB, to: ownerA, tx: 13 }));
    const second = await scanTransfers(restarted, chain, "2026-10-19T00:00:01.000Z");
    expect(second.ok).toBe(true);
    expect(restarted.logs).toHaveLength(2);
    expect(restarted.invalidations).toHaveLength(1);
    restarted.cursor.lastScannedBlock = 10n;
    restarted.cursor.lastScannedHash = word(10);
    const duplicate = await scanTransfers(restarted, chain, "2026-10-19T00:00:02.000Z");
    expect(duplicate.ok).toBe(true);
    expect(restarted.logs).toHaveLength(2);
    expect(restarted.invalidations).toHaveLength(1);
  });

  it("keeps the cursor when RPC fails and does not look healthy before the first scan", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9)];
    chain.tip = 10n;
    chain.fail = "logs";
    const store = new MemoryWatcherStore(genesis, 10n);
    const failed = await scanTransfers(store, chain, "2026-10-19T00:00:00.000Z");
    expect(failed.ok).toBe(false);
    expect(store.getCursor().lastScannedBlock).toBeNull();
    expect(healthOf(store, 10n).status).toBe("error");
    expect(healthOf(store, 10n).executionAllowed).toBe(false);
    const fresh = new MemoryWatcherStore(genesis, 10n);
    expect(healthOf(fresh, 10n).status).toBe("uninitialized");
    expect(healthOf(fresh, 10n).executionAllowed).toBe(false);
  });

  it("rewinds a reorg and replays the canonical log once", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11)];
    chain.tip = 12n;
    chain.logs = [transfer({ block: 12, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB, tx: 12 })];
    const store = new MemoryWatcherStore(genesis, 10n);
    store.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await scanTransfers(store, chain, "2026-10-19T00:00:00.000Z");
    chain.blocks[2] = { number: 12n, hash: word(99), parentHash: word(11) };
    chain.logs = [transfer({ block: 12, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB, tx: 99 })];
    chain.logs[0]!.blockHash = word(99);
    const replay = await scanTransfers(store, chain, "2026-10-19T00:00:03.000Z");
    expect(replay.ok).toBe(true);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]?.transactionHash).toBe(word(1_099));
    expect(store.invalidations).toHaveLength(1);
    expect(store.invalidations[0]?.state).toBe("queued");
    const again = await scanTransfers(store, chain, "2026-10-19T00:00:04.000Z");
    expect(again.ok).toBe(true);
    expect(store.logs).toHaveLength(1);
  });

  it("marks a stalled watcher unhealthy even when the cursor matches an old tip", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9)];
    chain.tip = 10n;
    const store = new MemoryWatcherStore(genesis, 10n);
    await scanTransfers(store, chain, "2026-10-19T00:00:00.000Z");
    const stalled = assessWatcher({
      store,
      tipBlock: 10n,
      nowMs: Date.parse("2026-10-19T00:02:00.000Z"),
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(stalled.status).toBe("stalled");
    expect(stalled.executionAllowed).toBe(false);
    const lagging = assessWatcher({
      store,
      tipBlock: 12n,
      nowMs: Date.parse("2026-10-19T00:00:00.000Z"),
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(lagging.status).toBe("lagging");
    expect(lagging.lagBlocks).toBe(2n);
    expect(lagging.executionAllowed).toBe(false);
  });
});

describe("sponsored execution guard", () => {
  it("refuses executeSession when a transfer is observed immediately before the attempt", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10)];
    chain.tip = 11n;
    chain.logs = [transfer({ block: 11, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB })];
    const watcher = new MemoryWatcherStore(genesis, 10n);
    watcher.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await scanTransfers(watcher, chain, "2026-10-19T00:00:00.000Z");
    const { store } = await activeBank();
    const limits = { ...DEFAULT_BANK_LIMITS };
    const result = await sponsorSessionCall(
      {
        store,
        runtime: {
          treasury: UNSET_TREASURY,
          limits,
          factoryAddress: null,
          factoryDeployed: false,
          relayerEnabled: false,
        },
        relayer: createDisabledRelayer(),
        guard: guardFor(watcher, healthOf(watcher, 11n)),
        now: () => "2026-10-19T00:00:00.000Z",
      },
      {
        requestId: "req-1",
        target: session().target,
        selector: ping,
        valueWei: 0n,
        estimatedGasWei: 1n,
        expectedNonce: 0n,
        executor,
        currentOwner: ownerB,
        now: 1_000,
        transfersAfterOpen: [],
      },
    );
    expect("skipped" in result).toBe(false);
    if (!("skipped" in result)) {
      expect(result.op).toBe("account.invalidateSession");
      expect(result.state).not.toBe("confirmed");
    }
    expect(watcher.invalidations[0]?.state).toBe("queued");
    expect(limits).toEqual(DEFAULT_BANK_LIMITS);
    const ledger = await store.ledger();
    expect(ledger).toHaveLength(0);
  });

  it("fails closed when the watcher has not caught up", async () => {
    const watcher = new MemoryWatcherStore(genesis, 10n);
    const { store } = await activeBank();
    const result = await sponsorSessionCall(
      {
        store,
        runtime: {
          treasury: UNSET_TREASURY,
          limits: DEFAULT_BANK_LIMITS,
          factoryAddress: null,
          factoryDeployed: false,
          relayerEnabled: true,
        },
        relayer: createDisabledRelayer(),
        guard: guardFor(watcher, healthOf(watcher, 10n)),
        now: () => "2026-10-19T00:00:00.000Z",
      },
      {
        requestId: "req-1",
        target: session().target,
        selector: ping,
        valueWei: 0n,
        estimatedGasWei: 1n,
        expectedNonce: 0n,
        executor,
        currentOwner: ownerA,
        now: 1_000,
        transfersAfterOpen: [],
      },
    );
    expect(result).toMatchObject({ skipped: true });
    expect(store.jobs).toHaveLength(0);
  });

  it("rejects the wrong nft, chain, account, token, and disallowed relayer ops", () => {
    const health = {
      status: "healthy" as const,
      executionAllowed: true,
      sponsorshipAllowed: true,
      cursorBlock: 11n,
      tipBlock: 11n,
      lagBlocks: 0n,
      lastError: null,
      lastSuccessAt: "2026-10-19T00:00:00.000Z",
      pendingInvalidations: 0,
      failedInvalidations: 0,
      confirmedInvalidations: 0,
    };
    const base = {
      health,
      chainId: 143,
      nftContract: genesis,
      account,
      tokenId: "7",
      expectedTokenId: "7",
      expectedAccount: account,
      currentOwner: ownerA,
      session: session(),
      transfersAfterOpen: [],
    };
    expect(preflightExecuteSession({ ...base, chainId: 10143 })).toMatchObject({ reason: "wrong chain" });
    expect(preflightExecuteSession({ ...base, nftContract: otherNft })).toMatchObject({ reason: "wrong nft" });
    expect(preflightExecuteSession({ ...base, account: otherNft })).toMatchObject({ reason: "wrong account" });
    expect(preflightExecuteSession({ ...base, tokenId: "8" })).toMatchObject({ reason: "wrong token" });
    const signer = loadProtectedSigner();
    expect(
      gateRelayerOp({
        op: "account.execute",
        chainId: 143,
        signer,
        mode: "simulated",
        reservationHeld: true,
        treasuryConfigured: true,
        preflightOk: true,
      }),
    ).toMatchObject({ accepted: false, reason: "relayer op is not allowed" });
    expect(
      gateRelayerOp({
        op: "account.executeSession",
        chainId: 143,
        signer,
        mode: "production",
        reservationHeld: true,
        treasuryConfigured: true,
        preflightOk: true,
      }).accepted,
    ).toBe(false);
    expect(readAppConfig({} as NodeJS.ProcessEnv).chogWatcherEnabled).toBe(false);
    expect(readAppConfig({} as NodeJS.ProcessEnv).chogBankRelayerEnabled).toBe(false);
  });
});

describe("receipt reconciliation", () => {
  it("spends reserved gas once, releases a revert, and holds an unknown receipt", () => {
    const reservation: Reservation = {
      id: "hold-1",
      requestId: "req-1",
      bucket: "gas",
      amountWei: 100n,
      state: "held",
    };
    const job: SponsoredJob = {
      id: "job-1",
      requestId: "req-1",
      idempotencyKey: "session:req-1:0:0x12345678",
      op: "account.executeSession",
      target: account,
      selector: ping,
      valueWei: 0n,
      estimatedGasWei: 100n,
      state: "submitted",
      txHash: word(5),
      gasUsedWei: null,
      failureReason: null,
    };
    const first = reconcileReceipt({
      job,
      reservation,
      receipt: { state: "success", txHash: word(5), gasUsedWei: 40n },
    });
    expect(first.spendWei).toBe(40n);
    expect(first.reservation?.state).toBe("reconciled");
    const second = reconcileReceipt({
      job: first.job,
      reservation: first.reservation,
      receipt: { state: "success", txHash: word(5), gasUsedWei: 40n },
    });
    expect(second.duplicate).toBe(true);
    expect(second.spendWei).toBe(0n);
    const reverted = reconcileReceipt({
      job,
      reservation,
      receipt: { state: "reverted", txHash: word(5), gasUsedWei: 10n },
    });
    expect(reverted.spendWei).toBe(0n);
    expect(reverted.reservation?.state).toBe("released");
    const unknown = reconcileReceipt({
      job,
      reservation,
      receipt: { state: "unknown", txHash: word(5) },
    });
    expect(unknown.reservation?.state).toBe("held");
    expect(unknown.spendWei).toBe(0n);
    const ambiguous = reconcileReceipt({
      job: first.job,
      reservation: first.reservation,
      receipt: { state: "success", txHash: word(6), gasUsedWei: 1n },
    });
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.spendWei).toBe(0n);
    const ops = chogBankOpsStatus({
      watcher: null,
      jobs: [first.job],
      pendingInvalidations: 1,
      confirmedInvalidations: 0,
    });
    expect(ops.relayer).toBe("disabled");
    expect(ops.signer).toBe("none");
    expect(ops.stages.confirmed).toBe(1);
    expect(ops.pendingInvalidations).toBe(1);
    expect(ops.confirmedInvalidations).toBe(0);
    expect(ops.note).toMatch(/queued invalidation/i);
  });
});

describe("phase 6c compatibility", () => {
  it("keeps world tick, the AI runner, and transaction execution unchanged", async () => {
    const tick = readFileSync("src/app/api/world/tick/route.ts", "utf8");
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    const transactions = readFileSync("src/app/api/transactions/route.ts", "utf8");
    const sql = readFileSync("supabase/migrations/20261019120000_phase6c_transfer_watcher.sql", "utf8");
    expect(tick).not.toContain("scanTransfers");
    expect(tick).not.toContain("watcher");
    expect(runner).not.toContain("getLogs");
    expect(runner).not.toContain("scanTransfers");
    expect(transactions).toContain("assertExecutionDisabled");
    expect(sql.toLowerCase()).toContain("not applied to hosted supabase");
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/insert\s+into\s+citizens/i);
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 1);
      },
    });
    const started = await initialize(db);
    expect(started.status).toBe("initialized");
    const eventsBefore = await rows<{ count: number }>(db, "select count(*)::int as count from civilization_events");
    const transfers = await rows<{ count: number }>(db, "select count(*)::int as count from nft_transfer_logs");
    const invalidations = await rows<{ count: number }>(db, "select count(*)::int as count from nft_session_invalidations");
    expect(transfers[0]?.count).toBe(0);
    expect(invalidations[0]?.count).toBe(0);
    expect(eventsBefore[0]?.count).toBeGreaterThan(0);
    await db.close();
  }, 60_000);
});
