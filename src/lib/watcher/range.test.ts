import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { readAppConfig } from "@/lib/config/env";
import { runDurableScan, type Sql } from "@/lib/watcher/durable";
import { rpcErrorClass } from "@/lib/watcher/range";
import { MemoryWatcherStore } from "@/lib/watcher/memory-store";
import { scanTransfers } from "@/lib/watcher/scan";
import type { BlockHeader, LogSource, RawTransfer } from "@/lib/watcher/types";
import { openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

const genesis = addresses.chogGenesis;
const ownerA = getAddress("0x2222222222222222222222222222222222222222");
const ownerB = getAddress("0x3333333333333333333333333333333333333333");
const now = "2026-10-19T00:00:00.000Z";

function word(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

class FakeChain implements LogSource {
  blocks: BlockHeader[] = [];
  logs: RawTransfer[] = [];
  tip = 0n;
  logCalls: Array<{ from: bigint; to: bigint }> = [];
  headerCalls = 0;
  logError: ((from: bigint, to: bigint) => string | null) | null = null;
  sleeps: number[] = [];

  latest() {
    const header = this.blocks.find((block) => block.number === this.tip);
    return Promise.resolve(header ?? { error: "missing tip" });
  }

  header(blockNumber: bigint) {
    this.headerCalls += 1;
    const header = this.blocks.find((block) => block.number === blockNumber);
    return Promise.resolve(header ?? { error: "missing block" });
  }

  transfers(fromBlock: bigint, toBlock: bigint) {
    this.logCalls.push({ from: fromBlock, to: toBlock });
    const reason = this.logError?.(fromBlock, toBlock);
    if (reason) {
      return Promise.resolve({ error: reason });
    }
    return Promise.resolve(this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
  }

  sleep(ms: number) {
    this.sleeps.push(ms);
    return Promise.resolve();
  }
}

function fill(chain: FakeChain, from: number, to: number): void {
  chain.blocks = [];
  for (let number = from; number <= to; number += 1) {
    chain.blocks.push({ number: BigInt(number), hash: word(number), parentHash: word(number - 1) });
  }
  chain.tip = BigInt(to);
}

function transfer(input: {
  block: number;
  logIndex?: number;
  from?: Address;
  to?: Address;
  tx?: number;
  tokenId?: bigint;
}): RawTransfer {
  return {
    blockNumber: BigInt(input.block),
    blockHash: word(input.block),
    transactionHash: word(1_000 + (input.tx ?? input.block)),
    transactionIndex: 0,
    logIndex: input.logIndex ?? 0,
    address: genesis,
    from: input.from ?? ownerA,
    to: input.to ?? ownerB,
    tokenId: input.tokenId ?? 7n,
  };
}

function sqlFor(db: { query: Sql["query"] }): Sql {
  return { query: (text, params) => db.query(text, params) };
}

describe("range watcher", () => {
  it("reads both transfer directions in one range and ignores a duplicate log", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 6);
    const forward = transfer({ block: 2, from: ownerA, to: ownerB });
    const back = transfer({ block: 5, logIndex: 1, from: ownerB, to: ownerA, tx: 50 });
    chain.logs = [forward, forward, back];
    const store = new MemoryWatcherStore(genesis, 1n);
    const report = await scanTransfers(store, chain, now, { rangeBlocks: 10n, maxBlocks: 20n });
    expect(report).toMatchObject({ ok: true, caughtUp: true, ranges: 1, toBlock: 6n, tipBlock: 6n, logs: 2 });
    expect(chain.logCalls).toEqual([{ from: 1n, to: 6n }]);
    expect(chain.headerCalls).toBeLessThan(6);
    expect(store.logs.map((log) => [log.from, log.to])).toEqual([
      [ownerA, ownerB],
      [ownerB, ownerA],
    ]);
    const again = await scanTransfers(store, chain, now, { rangeBlocks: 10n, maxBlocks: 20n });
    expect(again).toMatchObject({ ok: true, logs: 0, caughtUp: true });
    expect(store.logs).toHaveLength(2);
  });

  it("checkpoints an empty span and resumes after the budget stops the run", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 9);
    chain.logs = [transfer({ block: 8, from: ownerA, to: ownerB, tx: 80 })];
    const store = new MemoryWatcherStore(genesis, 1n);
    const saved: bigint[] = [];
    const limits = {
      rangeBlocks: 100n,
      maxBlocks: 3n,
      onCheckpoint: async () => {
        saved.push(store.getCursor().lastScannedBlock!);
      },
    };
    const first = await scanTransfers(store, chain, now, limits);
    expect(first).toMatchObject({ ok: true, caughtUp: false, toBlock: 3n, tipBlock: 9n, logs: 0, ranges: 1 });
    expect(saved).toEqual([3n]);
    expect(chain.logCalls).toEqual([{ from: 1n, to: 3n }]);

    const resumed = MemoryWatcherStore.fromSnapshot(store.snapshot());
    chain.logCalls = [];
    const second = await scanTransfers(resumed, chain, now, limits);
    expect(second).toMatchObject({ ok: true, caughtUp: false, toBlock: 6n, logs: 0 });
    const third = await scanTransfers(resumed, chain, now, limits);
    expect(third).toMatchObject({ ok: true, caughtUp: true, toBlock: 9n, logs: 1 });
    expect(resumed.logs).toHaveLength(1);
    expect(resumed.logs[0]?.blockNumber).toBe(8n);
  });

  it("keeps the last checkpoint when a later range fails", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 6);
    chain.logs = [transfer({ block: 2, tx: 2 }), transfer({ block: 5, tx: 5, from: ownerB, to: ownerA })];
    chain.logError = (from) => (from >= 3n ? "429 Too Many Requests" : null);
    const store = new MemoryWatcherStore(genesis, 1n);
    const report = await scanTransfers(store, chain, now, {
      rangeBlocks: 2n,
      maxBlocks: 10n,
      maxAttempts: 2,
      retryMs: 5,
      sleep: (ms) => chain.sleep(ms),
    });
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toMatch(/429/);
    }
    expect(store.getCursor().lastScannedBlock).toBe(2n);
    expect(store.logs.map((log) => log.blockNumber)).toEqual([2n]);
    expect(chain.sleeps.length).toBeGreaterThan(0);
    expect(chain.logCalls.filter((call) => call.from >= 3n).length).toBe(2);
  });

  it("splits a range that the provider rejects and refuses a saturated single block", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 4);
    chain.logs = [transfer({ block: 1, logIndex: 0, tx: 1 }), transfer({ block: 4, logIndex: 1, tx: 4, from: ownerB, to: ownerA })];
    chain.logError = (from, to) => (to !== from ? "query returned more than 10000 results" : null);
    const store = new MemoryWatcherStore(genesis, 1n);
    const split = await scanTransfers(store, chain, now, {
      rangeBlocks: 4n,
      maxBlocks: 10n,
      maxLogsPerRange: 50,
      pauseMs: 5,
      sleep: (ms) => chain.sleep(ms),
    });
    expect(split).toMatchObject({ ok: true, caughtUp: true, toBlock: 4n, logs: 2 });
    expect(chain.logCalls.some((call) => call.to - call.from > 1n)).toBe(true);
    expect(chain.logCalls.filter((call) => call.from === call.to)).toHaveLength(4);
    expect(chain.sleeps).toEqual([5, 5, 5, 5]);
    expect(store.logs).toHaveLength(2);

    const saturated = new FakeChain();
    fill(saturated, 1, 1);
    saturated.logs = [transfer({ block: 1, logIndex: 0, tx: 1 }), transfer({ block: 1, logIndex: 1, tx: 2 })];
    const blocked = new MemoryWatcherStore(genesis, 1n);
    const refused = await scanTransfers(blocked, saturated, now, { rangeBlocks: 5n, maxBlocks: 5n, maxLogsPerRange: 1 });
    expect(refused.ok).toBe(false);
    expect(blocked.getCursor().lastScannedBlock).toBeNull();
    expect(blocked.logs).toHaveLength(0);
  });

  it("drops logs above a reorged checkpoint and replays the canonical transfer", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 6);
    chain.logs = [transfer({ block: 4, tx: 4 }), transfer({ block: 6, tx: 6, from: ownerB, to: ownerA })];
    const store = new MemoryWatcherStore(genesis, 1n);
    await scanTransfers(store, chain, now, { rangeBlocks: 10n, maxBlocks: 10n });
    expect(store.logs).toHaveLength(2);
    chain.blocks[5] = { number: 6n, hash: word(99), parentHash: word(5) };
    chain.logs = [
      transfer({ block: 4, tx: 4 }),
      { ...transfer({ block: 6, tx: 70, from: ownerB, to: ownerA }), blockHash: word(99) },
    ];
    const replay = await scanTransfers(store, chain, now, { rangeBlocks: 10n, maxBlocks: 10n });
    expect(replay).toMatchObject({ ok: true, logs: 1 });
    expect(store.logs.map((log) => log.transactionHash)).toEqual([word(1_004), word(1_070)]);
    expect(store.getCursor().lastScannedHash).toBe(word(99));
  });

  it("does not advance the cursor when an unremoved log disagrees with the block hash", async () => {
    const chain = new FakeChain();
    fill(chain, 1, 3);
    chain.logs = [{ ...transfer({ block: 2, tx: 2 }), blockHash: word(999) }];
    const store = new MemoryWatcherStore(genesis, 1n);
    const report = await scanTransfers(store, chain, now, { rangeBlocks: 10n, maxBlocks: 10n });
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toMatch(/does not match the canonical block hash/);
    }
    expect(store.getCursor().lastScannedBlock).toBeNull();
    expect(store.logs).toHaveLength(0);

    const removed = new FakeChain();
    fill(removed, 1, 3);
    removed.logs = [{ ...transfer({ block: 2, tx: 2 }), removed: true }];
    const empty = new MemoryWatcherStore(genesis, 1n);
    const skipped = await scanTransfers(empty, removed, now, { rangeBlocks: 10n, maxBlocks: 10n, pauseMs: 25, sleep: (ms) => removed.sleep(ms) });
    expect(skipped).toMatchObject({ ok: true, caughtUp: true, logs: 0, toBlock: 3n });
    expect(empty.logs).toHaveLength(0);
    expect(removed.sleeps).toEqual([25]);
  });

  it("classifies provider failures and stays disabled by default", () => {
    expect(rpcErrorClass("429 Too Many Requests")).toBe("transient");
    expect(rpcErrorClass("query returned more than 10000 results")).toBe("limit");
    expect(rpcErrorClass("eth_getLogs is limited to a 100 range")).toBe("limit");
    expect(rpcErrorClass('{"code":-32614,"message":"eth_getLogs is limited to a 100 range"}')).toBe("limit");
    expect(rpcErrorClass("rpc logs failed")).toBe("fatal");
    const config = readAppConfig({} as NodeJS.ProcessEnv);
    expect(config.chogWatcherEnabled).toBe(false);
    expect(config.chogWatcherRangeBlocks).toBe(100);
    expect(config.chogWatcherMaxBlocksPerRun).toBe(5000);
    expect(config.chogWatcherMaxLogsPerRange).toBe(2000);
    expect(config.chogWatcherRpcAttempts).toBe(4);
    expect(config.chogWatcherRpcPauseMs).toBe(200);
    expect(config.chogWatcherRpcRetryMs).toBe(400);
    expect(() => readAppConfig({ CHOG_WATCHER_RANGE_BLOCKS: "9000" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /CHOG_WATCHER_RANGE_BLOCKS/,
    );
  });
});

describe("range projection", () => {
  it("publishes both directions at checkpoints without changing citizenship", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 1);
    const [citizen] = await rows<{ id: string }>(db, "select id from citizens where token_id = 7");
    await db.query(
      `insert into world_buildings (
         id, layout_version, kind, name, x, y, w, h, door_x, door_y, capacity, job_slots, role, status
       ) values
         ('house-13', 'test', 'house', 'House 13', 0, 0, 2, 2, 0, 0, 1, null, null, 'active'),
         ('violet-quarry', 'test', 'quarry', 'Violet Quarry', 4, 0, 2, 2, 4, 0, null, 1, 'stonecutter', 'active')`,
    );
    await db.query(
      `insert into citizen_world_state (
         citizen_id, role, home_id, work_id, activity, location_id, started_at, ends_at, world_started_s, world_ends_s
       ) values ($1, 'stonecutter', 'house-13', 'violet-quarry', 'idle', 'house-13', $2, $3, 0, 600)`,
      [citizen!.id, now, "2026-10-19T00:10:00.000Z"],
    );
    await db.query(
      `insert into citizen_personalities (
         citizen_id, sociability, curiosity, industriousness, cooperation, caution, planning, resourcefulness,
         preferred_activity, init_method
       ) values ($1, 10, 20, 30, 40, 50, 60, 70, 'work', 'deterministic')`,
      [citizen!.id],
    );
    await db.query("update citizens set observed_owner = $1 where id = $2", [ownerA, citizen!.id]);

    const chain = new FakeChain();
    fill(chain, 1, 6);
    chain.logs = [
      transfer({ block: 2, from: ownerA, to: ownerB, tx: 2 }),
      transfer({ block: 5, from: ownerB, to: ownerA, tx: 5 }),
    ];
    const sql = sqlFor(db);
    const limits = { rangeBlocks: 100n, maxBlocks: 3n };
    const first = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: 1n,
      maxLagBlocks: 20n,
      maxStaleMs: 60_000,
      scan: limits,
    });
    expect(first.report).toMatchObject({ ok: true, caughtUp: false, toBlock: 3n });
    const midway = await rows<{
      enrollment_status: string;
      founding_membership_active: boolean;
      observed_owner: string;
      home_id: string;
      work_id: string;
      role: string;
      sociability: number;
      events: number;
    }>(
      db,
      `select c.enrollment_status, c.founding_membership_active, c.observed_owner,
              s.home_id, s.work_id, s.role, p.sociability,
              (select count(*)::int from civilization_events where kind = 'nft.transferred') as events
       from citizens c
       join citizen_world_state s on s.citizen_id = c.id
       join citizen_personalities p on p.citizen_id = c.id
       where c.id = $1`,
      [citizen!.id],
    );
    expect(midway[0]).toMatchObject({
      enrollment_status: "active",
      founding_membership_active: true,
      observed_owner: ownerB,
      home_id: "house-13",
      work_id: "violet-quarry",
      role: "stonecutter",
      sociability: 10,
      events: 1,
    });

    const second = await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: null,
      maxLagBlocks: 20n,
      maxStaleMs: 60_000,
      scan: limits,
    });
    expect(second.report).toMatchObject({ ok: true, caughtUp: true, toBlock: 6n, logs: 1 });
    const events = await rows<{ from_address: string; to_address: string; canonical: boolean; category: string }>(
      db,
      `select payload->>'from' as from_address, payload->>'to' as to_address, canonical, category
       from civilization_events where kind = 'nft.transferred' order by tx_hash`,
    );
    expect(events).toEqual([
      { from_address: ownerA, to_address: ownerB, canonical: true, category: "onchain" },
      { from_address: ownerB, to_address: ownerA, canonical: true, category: "onchain" },
    ]);
    await runDurableScan({
      sql,
      nftContract: genesis,
      source: chain,
      now,
      backfillFrom: null,
      maxLagBlocks: 20n,
      maxStaleMs: 60_000,
      scan: limits,
    });
    const after = await rows<{
      n: number;
      enrollment_status: string;
      founding_membership_active: boolean;
      observed_owner: string;
      home_id: string;
      role: string;
      sociability: number;
      events: number;
    }>(
      db,
      `select count(*) over ()::int as n, c.enrollment_status, c.founding_membership_active, c.observed_owner,
              s.home_id, s.role, p.sociability,
              (select count(*)::int from civilization_events where kind = 'nft.transferred') as events
       from citizens c
       join citizen_world_state s on s.citizen_id = c.id
       join citizen_personalities p on p.citizen_id = c.id`,
    );
    expect(after).toEqual([
      {
        n: 1,
        enrollment_status: "active",
        founding_membership_active: true,
        observed_owner: ownerA,
        home_id: "house-13",
        role: "stonecutter",
        sociability: 10,
        events: 2,
      },
    ]);
    const removed = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind in ('genesis_left', 'citizen.unavailable')",
    );
    expect(removed[0]?.n).toBe(0);
    await db.close();
  }, 60_000);
});
