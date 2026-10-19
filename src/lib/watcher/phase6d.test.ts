import { readFileSync } from "node:fs";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { sponsorSessionCall, type BankEngine } from "@/lib/chogbank/engine";
import { MemoryChogBankStore } from "@/lib/chogbank/memory-store";
import { assessObservedGas, fundsFromModel, readNativeBalance, sponsorshipDecision } from "@/lib/chogbank/observation";
import { gateRelayerOp } from "@/lib/chogbank/relayer-gate";
import { createDisabledRelayer, loadProductionRelayer } from "@/lib/chogbank/relayer";
import { DEFAULT_BANK_LIMITS, injectedTreasury } from "@/lib/chogbank/runtime";
import { sessionTransferRace } from "@/lib/chogbank/session-race";
import { APPROVED_SIGNER_OPS, loadGasSigner, loadProtectedSigner, MISSING_SIGNER_DEPENDENCIES } from "@/lib/chogbank/signer";
import { predictedFactoryAddress, V11_FACTORY_PREDICTED } from "@/lib/chogbank/factory";
import type { ActivationRequest, SessionPolicy } from "@/lib/chogbank/types";
import { readAppConfig } from "@/lib/config/env";
import { loadWatcherStore, runDurableScan, saveWatcherStore, supabaseRpcSql, type Sql } from "@/lib/watcher/durable";
import { assessWatcher, canSponsorExecution } from "@/lib/watcher/health";
import { logIdentity } from "@/lib/watcher/identity";
import { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import { executeWatcher, startWatcher } from "@/lib/watcher/run";
import { createTransferSource, decodeTransfer, ERC721_TRANSFER_TOPIC } from "@/lib/watcher/source";
import type { BlockHeader, LogSource, RawTransfer } from "@/lib/watcher/types";
import { initialize, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

const genesis = addresses.chogGenesis;
const ownerA = getAddress("0x2222222222222222222222222222222222222222");
const ownerB = getAddress("0x3333333333333333333333333333333333333333");
const executor = getAddress("0x4444444444444444444444444444444444444444");
const account = getAddress("0x7777777777777777777777777777777777777777");
const gas = getAddress("0x6666666666666666666666666666666666666666");
const asset = getAddress("0x8888888888888888888888888888888888888888");
const sink = getAddress("0x5555555555555555555555555555555555555555");
const ping = toFunctionSelector("ping(uint256)");
const now = "2026-10-19T00:00:00.000Z";
const nowMs = Date.parse(now);

function word(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

class FakeChain implements LogSource {
  blocks: BlockHeader[] = [];
  logs: RawTransfer[] = [];
  tip = 0n;
  fail: "latest" | "header" | "logs" | null = null;
  calls = 0;

  latest() {
    this.calls += 1;
    if (this.fail === "latest") {
      return Promise.resolve({ error: "rpc latest failed" });
    }
    const header = this.blocks.find((block) => block.number === this.tip);
    return Promise.resolve(header ?? { error: "missing tip" });
  }

  header(blockNumber: bigint) {
    this.calls += 1;
    if (this.fail === "header") {
      return Promise.resolve({ error: "rpc header failed" });
    }
    const header = this.blocks.find((block) => block.number === blockNumber);
    return Promise.resolve(header ?? { error: "missing block" });
  }

  transfers(fromBlock: bigint, toBlock: bigint) {
    this.calls += 1;
    if (this.fail === "logs") {
      return Promise.resolve({ error: "rpc logs failed" });
    }
    return Promise.resolve(this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
  }
}

function header(number: number, parent: number, hash = number): BlockHeader {
  return { number: BigInt(number), hash: word(hash), parentHash: word(parent) };
}

function transfer(input: {
  block: number;
  logIndex: number;
  tokenId: bigint;
  from: Address;
  to: Address;
  tx?: number;
  hash?: number;
}): RawTransfer {
  const blockHash = word(input.hash ?? input.block);
  return {
    blockNumber: BigInt(input.block),
    blockHash,
    transactionHash: word(1_000 + (input.tx ?? input.block)),
    transactionIndex: 0,
    logIndex: input.logIndex,
    address: genesis,
    from: input.from,
    to: input.to,
    tokenId: input.tokenId,
  };
}

function pgliteSql(db: { query: Sql["query"] }): Sql {
  return { query: (text, params) => db.query(text, params) };
}

function session(): SessionPolicy {
  return {
    executor,
    ownerAtOpen: ownerA,
    target: sink,
    selector: ping,
    maxValuePerCall: 0n,
    maxCumulativeValue: 0n,
    spent: 0n,
    expiresAt: 2_000,
    openedBlock: 10n,
    nonce: 0n,
    dead: false,
    paused: false,
  };
}

function request(id: string): ActivationRequest {
  return {
    id,
    citizenId: `citizen-${id}`,
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
    createdAt: now,
  };
}

async function watch(chain: FakeChain, backfill = 10n) {
  const db = await openWorldDb();
  const sql = pgliteSql(db);
  const first = await runDurableScan({
    sql,
    nftContract: genesis,
    source: chain,
    now,
    backfillFrom: backfill,
    maxLagBlocks: 2n,
    maxStaleMs: 60_000,
  });
  return { db, sql, first };
}

describe("durable watcher", () => {
  it("recovers the cursor after a restart, backfills, and replays without duplicating logs", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11)];
    chain.tip = 11n;
    chain.logs = [transfer({ block: 11, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB })];
    const db = await openWorldDb();
    const sql = pgliteSql(db);
    const primed = new MemoryWatcherStore(genesis, 10n);
    primed.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await saveWatcherStore(sql, primed);
    const first = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(first.report.ok).toBe(true);
    expect(first.store.logs).toHaveLength(1);
    expect(first.store.invalidations).toHaveLength(1);

    const restarted = await loadWatcherStore(sql, genesis);
    expect(restarted.getCursor().lastScannedBlock).toBe(11n);
    expect(restarted.sessions).toHaveLength(1);
    chain.tip = 12n;
    chain.logs.push(transfer({ block: 12, logIndex: 1, tokenId: 7n, from: ownerB, to: ownerA, tx: 12 }));
    const filled = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now: "2026-10-19T00:00:01.000Z",
      backfillFrom: null,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(filled.report.ok).toBe(true);
    expect(filled.store.logs).toHaveLength(2);
    expect(filled.store.invalidations).toHaveLength(1);
    expect(filled.health.executionAllowed).toBe(true);
    expect(filled.health.sponsorshipAllowed).toBe(false);
    expect(canSponsorExecution(filled.health).allowed).toBe(false);

    await db.query("update nft_transfer_cursors set last_scanned_block = 10, last_scanned_hash = $1 where chain_id = 143", [
      word(10),
    ]);
    const replay = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now: "2026-10-19T00:00:02.000Z",
      backfillFrom: null,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(replay.store.logs).toHaveLength(2);
    expect(replay.store.invalidations).toHaveLength(1);
    const identity = logIdentity({
      chainId: 143,
      blockHash: word(11),
      transactionHash: word(1_011),
      logIndex: 0,
    });
    expect(replay.store.logs.map((log) => log.id)).toContain(identity);
    const stored = await rows<{ id: string }>(db, "select id::text as id from nft_transfer_logs");
    expect(stored.every((row) => row.id !== identity)).toBe(true);
    await db.close();
  }, 60_000);

  it("rewinds a reorg and keeps the canonical log", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11)];
    chain.tip = 12n;
    chain.logs = [transfer({ block: 12, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB, tx: 12 })];
    const db = await openWorldDb();
    const sql = pgliteSql(db);
    const primed = new MemoryWatcherStore(genesis, 10n);
    primed.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await saveWatcherStore(sql, primed);
    const first = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(first.report.ok).toBe(true);
    expect(first.store.logs).toHaveLength(1);
    chain.blocks[2] = header(12, 11, 99);
    chain.logs = [transfer({ block: 12, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB, tx: 99, hash: 99 })];
    const replay = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now: "2026-10-19T00:00:03.000Z",
      backfillFrom: null,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(replay.report.ok).toBe(true);
    expect(replay.store.logs).toHaveLength(1);
    expect(replay.store.logs[0]?.transactionHash).toBe(word(1_099));
    const again = await loadWatcherStore(sql, genesis);
    expect(again.logs).toHaveLength(1);
    expect(again.invalidations).toHaveLength(1);
    await db.close();
  }, 60_000);

  it("persists an RPC failure and does not scan when the migration is missing", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9)];
    chain.tip = 10n;
    chain.fail = "logs";
    const { db, sql, first } = await watch(chain);
    expect(first.scanned).toBe(true);
    expect(first.report.ok).toBe(false);
    expect(first.health.status).toBe("error");
    expect(first.health.sponsorshipAllowed).toBe(false);
    const restored = await loadWatcherStore(sql, genesis);
    expect(restored.getCursor().lastScannedBlock).toBeNull();
    expect(restored.getCursor().lastError).toMatch(/rpc logs failed/);
    await db.close();

    let reads = 0;
    const missing = await runDurableScan({
      sql: {
        async query() {
          throw new Error("function load_nft_watcher_snapshot(text) does not exist");
        },
      },
      nftContract: genesis,
      source: {
        latest: () => {
          reads += 1;
          return Promise.resolve({ error: "should not read" });
        },
        header: () => Promise.resolve({ error: "should not read" }),
        transfers: () => Promise.resolve({ error: "should not read" }),
      },
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(missing.scanned).toBe(false);
    expect(missing.report).toMatchObject({ ok: false, reason: "Phase 6d watcher migration has not been applied" });
    expect(reads).toBe(0);
  }, 60_000);

  it("keeps A→B→A as one queued invalidation and blocks sponsorship", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10), header(12, 11)];
    chain.tip = 12n;
    chain.logs = [
      transfer({ block: 11, logIndex: 0, tokenId: 7n, from: ownerA, to: ownerB }),
      transfer({ block: 12, logIndex: 1, tokenId: 7n, from: ownerB, to: ownerA }),
    ];
    const db = await openWorldDb();
    const sql = pgliteSql(db);
    const primed = new MemoryWatcherStore(genesis, 10n);
    primed.watch({ requestId: "req-1", tokenId: "7", openedBlock: 10n, ownerAtOpen: ownerA, account });
    await saveWatcherStore(sql, primed);
    const scanned = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(scanned.store.invalidations).toHaveLength(1);
    expect(scanned.store.invalidations[0]?.state).toBe("queued");
    expect(scanned.health.executionAllowed).toBe(true);
    expect(scanned.health.sponsorshipAllowed).toBe(false);
    expect(canSponsorExecution(scanned.health, "queued")).toEqual({
      allowed: false,
      reason: "unresolved invalidation blocks sponsorship",
    });
    scanned.store.setInvalidationState(scanned.store.invalidations[0]!.id, "confirmed");
    const confirmed = assessWatcher({ store: scanned.store, tipBlock: 12n, nowMs, maxLagBlocks: 2n, maxStaleMs: 60_000 });
    expect(confirmed.sponsorshipAllowed).toBe(true);
    const confirmedGate = canSponsorExecution(confirmed, "confirmed");
    expect(confirmedGate.allowed).toBe(false);
    if (!confirmedGate.allowed) {
      expect(confirmedGate.reason).toMatch(/session was invalidated/);
    }
    await db.close();
  }, 60_000);
});

describe("watcher process", () => {
  it("does not open the chain when disabled, misconfigured, or on the wrong network", async () => {
    let opened = 0;
    const open = async () => {
      opened += 1;
      throw new Error("should not open");
    };
    const disabled = await executeWatcher({
      config: readAppConfig({} as NodeJS.ProcessEnv),
      open,
    });
    expect(disabled).toMatchObject({ exitCode: 0, scanned: false });
    expect(opened).toBe(0);

    const wrongChain = await executeWatcher({
      config: readAppConfig({
        CHOG_WATCHER_ENABLED: "true",
        MONAD_CHAIN_ID: "10143",
        MONAD_RPC_URL: "https://rpc.example.test",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "service",
      } as unknown as NodeJS.ProcessEnv),
      open,
    });
    expect(wrongChain.exitCode).toBe(1);
    expect(wrongChain.message).toMatch(/143/);
    expect(opened).toBe(0);

    const noRpc = await executeWatcher({
      config: readAppConfig({
        CHOG_WATCHER_ENABLED: "true",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "service",
      } as unknown as NodeJS.ProcessEnv),
      open,
    });
    expect(noRpc.message).toMatch(/MONAD_RPC_URL/);
    expect(opened).toBe(0);

    const quiet = await startWatcher({
      config: readAppConfig({} as NodeJS.ProcessEnv),
      loop: true,
      run: async () => {
        opened += 1;
        return { exitCode: 0, message: "ran", scanned: true };
      },
    });
    expect(quiet).toEqual({ exitCode: 0, runs: 0 });
    expect(opened).toBe(0);
  });

  it("refuses a chain id other than 143 before reading logs", async () => {
    let logs = 0;
    const source = createTransferSource(
      {
        getChainId: async () => 10143,
        getBlock: async () => {
          throw new Error("block read");
        },
        getLogs: async () => {
          logs += 1;
          return [];
        },
      },
      genesis,
    );
    expect(await source.latest()).toMatchObject({ error: "wrong chain 10143" });
    expect(logs).toBe(0);
    const decoded = decodeTransfer(
      {
        address: genesis,
        blockNumber: 11n,
        blockHash: word(11),
        transactionHash: word(1011),
        transactionIndex: 0,
        logIndex: 0,
        topics: [ERC721_TRANSFER_TOPIC, word(0), word(1), word(7)],
      },
      genesis,
    );
    expect(decoded?.tokenId).toBe(7n);
    expect(decoded?.from).toBe(getAddress(`0x${"0".repeat(40)}`));
  });

  it("rejects an unexpected supabase statement and classifies a missing function", async () => {
    const sql = supabaseRpcSql({
      rpc: async (fn) => ({ data: null, error: { code: "PGRST202", message: `Could not find ${fn}` } }),
    });
    await expect(sql.query("select load_nft_watcher_snapshot($1) as snapshot", [genesis])).rejects.toThrow(/PGRST202/);
    await expect(sql.query("drop table citizens")).rejects.toThrow(/unexpected statement/);
  });
});

describe("gas observation and signer", () => {
  const limits = DEFAULT_BANK_LIMITS;
  const fresh = {
    ok: true as const,
    chainId: 143,
    address: gas,
    balanceWei: 1_000n,
    blockNumber: 20n,
    observedAt: now,
  };

  it("separates observed, reserved, available, and business capital", () => {
    const observed = assessObservedGas({
      configuredAddress: gas,
      read: fresh,
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 100n,
      reservedDeploymentWei: 50n,
      businessCapitalWei: 5_000n,
      revenueHypothesisWei: 10n ** 18n,
      limits,
    });
    expect(observed.status).toBe("observed");
    expect(observed.observedBalanceWei).toBe(1_000n);
    expect(observed.availableWei).toBe(850n);
    expect(observed.businessCapitalWei).toBe(5_000n);
    expect(observed.fundsAvailable).toBe(true);
    expect(observed.limits).toEqual(limits);
    const richerStory = assessObservedGas({
      configuredAddress: gas,
      read: fresh,
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 100n,
      reservedDeploymentWei: 50n,
      businessCapitalWei: 9_000n,
      revenueHypothesisWei: 1n,
      limits,
    });
    expect(richerStory.availableWei).toBe(observed.availableWei);
    expect(fundsFromModel({ balance: "1000", received: true })).toBeNull();
  });

  it("fails closed on a stale read, a failed RPC, the wrong chain, and a missing address", async () => {
    const stale = assessObservedGas({
      configuredAddress: gas,
      read: { ...fresh, observedAt: "2026-10-18T00:00:00.000Z" },
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 0n,
      limits,
    });
    expect(stale.status).toBe("stale");
    expect(stale.availableWei).toBeNull();
    expect(stale.observedBalanceWei).toBe(1_000n);
    const failed = assessObservedGas({
      configuredAddress: gas,
      read: { ok: false, error: "rpc timeout" },
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 0n,
      limits,
    });
    expect(failed.status).toBe("unavailable");
    expect(failed.availableWei).toBeNull();
    const wrong = assessObservedGas({
      configuredAddress: gas,
      read: { ...fresh, chainId: 10143 },
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 0n,
      limits,
    });
    expect(wrong.status).toBe("wrong_chain");
    expect(wrong.availableWei).toBeNull();
    const missing = assessObservedGas({
      configuredAddress: null,
      read: fresh,
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 0n,
      limits,
    });
    expect(missing.status).toBe("unconfigured");
    expect(missing.availableWei).toBeNull();
    const mismatch = assessObservedGas({
      configuredAddress: gas,
      read: { ...fresh, address: asset },
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 0n,
      limits,
    });
    expect(mismatch.status).toBe("address_mismatch");
    const thrown = await readNativeBalance(
      {
        getChainId: async () => 143,
        read: async () => {
          throw new Error("socket closed");
        },
      },
      gas,
    );
    expect(thrown).toEqual({ ok: false, error: "socket closed" });
  });

  it("keeps the gas signer disabled and separate from treasury assets", () => {
    const secret = `0x${"ab".repeat(32)}`;
    const refused = loadGasSigner({ CHOG_BANK_GAS_PRIVATE_KEY: secret, CHOG_BANK_GAS_ADDRESS: gas });
    expect(refused.canSign).toBe(false);
    expect(refused.gasAddress).toBeNull();
    expect(JSON.stringify(refused)).not.toContain(secret);
    expect(refused.reason).toMatch(/CHOG_BANK_GAS_PRIVATE_KEY/);
    expect("sign" in refused).toBe(false);
    const same = loadGasSigner({ CHOG_BANK_GAS_ADDRESS: gas, CHOG_BANK_ASSET_ADDRESS: gas });
    expect(same.gasAddress).toBeNull();
    expect(same.reason).toMatch(/must differ/);
    const observedOnly = loadGasSigner({ CHOG_BANK_GAS_ADDRESS: gas, CHOG_BANK_ASSET_ADDRESS: asset });
    expect(observedOnly.canSign).toBe(false);
    expect(observedOnly.gasAddress).toBe(gas);
    expect(observedOnly.assetAddress).toBe(asset);
    expect(observedOnly.approvedOps).toEqual(APPROVED_SIGNER_OPS);
    expect(observedOnly.reason).toContain(MISSING_SIGNER_DEPENDENCIES[0]);
    expect(loadProtectedSigner({ CHOG_BANK_TREASURY_PRIVATE_KEY: secret }).address).toBeNull();
    expect(() =>
      readAppConfig({
        CHOG_BANK_GAS_ADDRESS: gas,
        CHOG_BANK_ASSET_ADDRESS: gas,
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/must differ/);
    const defaults = readAppConfig({} as NodeJS.ProcessEnv);
    expect(defaults.chogWatcherEnabled).toBe(false);
    expect(defaults.chogBankGasAddress).toBeUndefined();
    expect(defaults.chogWatcherIntervalSeconds).toBe(60);
    expect(loadProductionRelayer({ CHOG_BANK_RELAYER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(createDisabledRelayer().enabled).toBe(false);
    expect(
      gateRelayerOp({
        op: "account.executeSession",
        chainId: 143,
        signer: loadProtectedSigner(),
        mode: "production",
        reservationHeld: true,
        treasuryConfigured: true,
        preflightOk: true,
      }).accepted,
    ).toBe(false);
  });
});

describe("sponsorship gates", () => {
  it("blocks a stale watcher and an unresolved invalidation, then still refuses to sign", () => {
    const health = assessWatcher({
      store: new MemoryWatcherStore(genesis, 10n),
      tipBlock: 10n,
      nowMs,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    const missingHistory = canSponsorExecution(health);
    expect(missingHistory.allowed).toBe(false);
    if (!missingHistory.allowed) {
      expect(missingHistory.reason).toMatch(/has not established transfer history/);
    }
    const caughtUp = new MemoryWatcherStore(genesis, 10n);
    caughtUp.commitBlock({ number: 10n, hash: word(10), parentHash: word(9) }, now);
    const stalled = assessWatcher({
      store: caughtUp,
      tipBlock: 10n,
      nowMs: nowMs + 120_000,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(stalled.status).toBe("stalled");
    expect(stalled.sponsorshipAllowed).toBe(false);
    const stalledGate = canSponsorExecution(stalled);
    expect(stalledGate.allowed).toBe(false);
    if (!stalledGate.allowed) {
      expect(stalledGate.reason).toMatch(/watcher is stalled/);
    }
    caughtUp.queueInvalidation({ requestId: "req-1", transferId: "143:dead", reason: "transfer" });
    caughtUp.setInvalidationState(caughtUp.invalidations[0]!.id, "failed");
    const failed = assessWatcher({ store: caughtUp, tipBlock: 10n, nowMs, maxLagBlocks: 2n, maxStaleMs: 60_000 });
    expect(failed.executionAllowed).toBe(true);
    expect(failed.sponsorshipAllowed).toBe(false);
    const failedGate = canSponsorExecution(failed);
    expect(failedGate.allowed).toBe(false);
    if (!failedGate.allowed) {
      expect(failedGate.reason).toMatch(/unresolved invalidation/);
    }
    const gasReading = assessObservedGas({
      configuredAddress: gas,
      read: {
        ok: true,
        chainId: 143,
        address: gas,
        balanceWei: 1_000n,
        blockNumber: 20n,
        observedAt: now,
      },
      nowMs,
      maxAgeMs: 60_000,
      reservedGasWei: 0n,
      reservedDeploymentWei: 0n,
      businessCapitalWei: 100n,
      limits: DEFAULT_BANK_LIMITS,
    });
    expect(
      sponsorshipDecision({
        health,
        gas: gasReading,
        signerCanSign: false,
      }).reason,
    ).toMatch(/transfer history/);
    const healthy = {
      ...health,
      status: "healthy" as const,
      executionAllowed: true,
      sponsorshipAllowed: true,
      cursorBlock: 10n,
      tipBlock: 10n,
      lagBlocks: 0n,
      lastSuccessAt: now,
      pendingInvalidations: 0,
      failedInvalidations: 0,
    };
    expect(sponsorshipDecision({ health: healthy, gas: gasReading, signerCanSign: false }).reason).toBe(
      "signing is disabled",
    );
    expect(sponsorshipDecision({ health: healthy, gas: gasReading, signerCanSign: true }).reason).toMatch(
      /live signer is not enabled/,
    );
  });

  it("refuses concurrent executeSession calls before either one reserves gas", async () => {
    const store = new MemoryChogBankStore();
    await store.saveRequest(request("req-1"));
    await store.saveRequest(request("req-2"));
    await store.saveSession("req-1", session());
    await store.saveSession("req-2", session());
    let sends = 0;
    const engine: BankEngine = {
      store,
      runtime: {
        treasury: injectedTreasury(100n),
        limits: DEFAULT_BANK_LIMITS,
        factoryAddress: null,
        factoryDeployed: false,
        relayerEnabled: true,
      },
      relayer: {
        enabled: true,
        async send() {
          sends += 1;
          return { ok: true, txHash: word(sends), gasUsedWei: 1n };
        },
      },
      now: () => now,
    };
    const call = (id: string) =>
      sponsorSessionCall(engine, {
        requestId: id,
        target: sink,
        selector: ping,
        valueWei: 0n,
        estimatedGasWei: 80n,
        expectedNonce: 0n,
        executor,
        currentOwner: ownerA,
        now: 1_000,
        transfersAfterOpen: [],
      });
    const [first, second] = await Promise.all([call("req-1"), call("req-2")]);
    expect(first).toMatchObject({ skipped: true, reason: expect.stringMatching(/empty transfer list/) });
    expect(second).toMatchObject({ skipped: true, reason: expect.stringMatching(/empty transfer list/) });
    expect(sends).toBe(0);
    expect(store.reservations).toHaveLength(0);
  });
});

describe("phase 6d boundaries", () => {
  it("leaves the V1.1 account and factory address unchanged", () => {
    const accountSource = readFileSync("contracts/src/CitizenAccount.sol", "utf8");
    expect(accountSource).toContain("if (owner == previous)");
    expect(accountSource).toContain("DelegationDisabled");
    expect(predictedFactoryAddress()).toBe(V11_FACTORY_PREDICTED);
    expect(sessionTransferRace.atomicInvalidation).toBe(false);
    expect(sessionTransferRace.v11EnforcesTransferAtExecution).toBe(false);
    expect(sessionTransferRace.offchainWatcherClosesRace).toBe(false);
    expect(sessionTransferRace.executionRefused).toMatch(/empty transfer list/);
    expect(sessionTransferRace.v11Factory).toBe("0xA2edAC990B30A488D61fc4607D4365b22e41e39c");
    expect(sessionTransferRace.unusedV1Factory).toBe("0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c");
    const script = readFileSync("scripts/watcher-run.ts", "utf8");
    expect(script).not.toContain("world_tick");
    expect(script).not.toContain("sendTransaction");
    expect(script).not.toContain("privateKeyToAccount");
    const sql = readFileSync("supabase/migrations/20261019130000_phase6d_watcher_durable.sql", "utf8");
    expect(sql.toLowerCase()).toContain("not applied to hosted supabase");
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/insert\s+into\s+citizens/i);
  });

  it("does not attach the watcher to world tick and leaves new tables empty", async () => {
    const tick = readFileSync("src/app/api/world/tick/route.ts", "utf8");
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    const transactions = readFileSync("src/app/api/transactions/route.ts", "utf8");
    expect(tick).not.toContain("scanTransfers");
    expect(tick).not.toContain("runDurableScan");
    expect(runner).not.toContain("getLogs");
    expect(runner).not.toContain("scanTransfers");
    expect(transactions).toContain("assertExecutionDisabled");
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 1);
      },
    });
    const started = await initialize(db);
    expect(started.status).toBe("initialized");
    const sessions = await rows<{ count: number }>(db, "select count(*)::int as count from nft_watched_sessions");
    const jobs = await rows<{ count: number }>(db, "select count(*)::int as count from nft_watcher_invalidations");
    expect(sessions[0]?.count).toBe(0);
    expect(jobs[0]?.count).toBe(0);
    await expect(db.query("select save_nft_watcher_snapshot('{\"chainId\":\"1\"}'::jsonb)")).rejects.toThrow(/chain must be 143/);
    await db.close();
  }, 60_000);
});
