import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { runDurableScan, type Sql } from "@/lib/watcher/durable";
import type { BlockHeader, LogSource, RawTransfer } from "@/lib/watcher/types";
import { START, initialize, openWorldDb, rows, seedCitizens, tick } from "@/lib/world/test-db";

const nft = addresses.chogGenesis;
const from = getAddress("0x1111111111111111111111111111111111111111");
const to = getAddress("0x2222222222222222222222222222222222222222");
const now = "2026-10-19T00:00:00.000Z";

function word(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

class FakeChain implements LogSource {
  blocks: BlockHeader[] = [];
  logs: RawTransfer[] = [];
  tip = 0n;
  fail: "logs" | null = null;

  latest() {
    const header = this.blocks.find((block) => block.number === this.tip);
    return Promise.resolve(header ?? { error: "missing tip" });
  }

  header(blockNumber: bigint) {
    const header = this.blocks.find((block) => block.number === blockNumber);
    return Promise.resolve(header ?? { error: "missing block" });
  }

  transfers(fromBlock: bigint, toBlock: bigint) {
    if (this.fail === "logs") {
      return Promise.resolve({ error: "rpc logs failed" });
    }
    return Promise.resolve(this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
  }
}

function header(number: number, parent: number, hash = number): BlockHeader {
  return { number: BigInt(number), hash: word(hash), parentHash: word(parent) };
}

function transfer(input: Partial<RawTransfer> = {}): RawTransfer {
  return {
    blockNumber: 11n,
    blockHash: word(11),
    transactionHash: word(1100),
    transactionIndex: 0,
    logIndex: 4,
    address: nft,
    from,
    to,
    tokenId: 7n,
    ...input,
  };
}

function sqlFor(db: { query: Sql["query"] }): Sql {
  return { query: (text, params) => db.query(text, params) };
}

describe("permanent citizenship repair", () => {
  it("does not insert citizens or drop tables", () => {
    const sql = readFileSync("supabase/migrations/20261019140000_permanent_citizenship.sql", "utf8");
    expect(sql).not.toMatch(/insert\s+into\s+citizens/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).toContain("repair_permanent_citizenship");
    expect(sql).toContain("project_nft_transfer_activities");
  });

  it("restores a suspended founding citizen without inventing a home, and is safe to repeat", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 3);
    await initialize(db, 60);
    const [kept, traced, unknown] = await rows<{ id: string; token_id: string; home_id: string | null }>(
      db,
      `select c.id, c.token_id::text, s.home_id
       from citizens c join citizen_world_state s on s.citizen_id = c.id
       where c.token_id in (7, 14, 21) order by c.token_id`,
    );
    const [house] = await rows<{ id: string }>(db, "select id from world_buildings where kind = 'house' order by id limit 1");
    const [job] = await rows<{ id: string; role: string }>(
      db,
      "select id, role from world_buildings where role is not null order by id limit 1",
    );
    await db.query(
      `update citizens
       set enrollment_status = 'suspended', founding_membership_active = false
       where token_id in (7, 14, 21)`,
    );
    await db.query(
      `insert into genesis_roster (citizen_id, treasury_address, membership_active, verification_status, first_verified_at, left_treasury_at)
       values ($1, $2, false, 'verified', now(), now())`,
      [kept!.id, "0x84113421A8a564b594ee9Ae78c875310332d7023"],
    );
    await db.query(
      `update citizen_world_state
       set activity = 'unavailable', location_id = null, origin_id = null, destination_id = null, purpose = null,
           ends_at = null, world_ends_s = null, home_id = null, work_id = null, role = null
       where citizen_id in ($1, $2, $3)`,
      [kept!.id, traced!.id, unknown!.id],
    );
    await db.query(
      `insert into civilization_events (dedupe_key, kind, category, source, summary, actor_citizen_id, chain_status, payload)
       values ('test:home:7', 'citizen.joined_world', 'citizen', 'system', 'placed', $1, 'offchain', $2::jsonb)`,
      [kept!.id, JSON.stringify({ home: kept!.home_id, work: job!.id, role: job!.role, tokenId: "7" })],
    );
    await db.query(
      `insert into civilization_events (dedupe_key, kind, category, source, summary, actor_citizen_id, building_id, chain_status, payload)
       values
         ('test:sleep:14', 'citizen.sleep', 'citizen', 'system', 'slept', $1, $2, 'offchain', '{"tokenId":"14"}'),
         ('test:work:14', 'resource.gathering_started', 'work', 'simulation', 'worked', $1, $3, 'offchain', $4::jsonb)`,
      [traced!.id, house!.id, job!.id, JSON.stringify({ role: job!.role, tokenId: "14" })],
    );
    const first = await db.query<{ r: { citizens: number; roster: number; restored: number } }>(
      "select repair_permanent_citizenship() as r",
    );
    const second = await db.query<{ r: { citizens: number; restored: number } }>(
      "select repair_permanent_citizenship() as r",
    );
    expect(first.rows[0]!.r.citizens).toBe(3);
    expect(first.rows[0]!.r.roster).toBe(1);
    expect(first.rows[0]!.r.restored).toBe(3);
    expect(second.rows[0]!.r.citizens).toBe(0);
    expect(second.rows[0]!.r.restored).toBe(0);
    const after = await rows<{
      id: string;
      token_id: string;
      enrollment_status: string;
      founding_membership_active: boolean;
      home_id: string | null;
      work_id: string | null;
      role: string | null;
      activity: string;
    }>(
      db,
      `select c.id, c.token_id::text, c.enrollment_status, c.founding_membership_active, s.home_id, s.work_id, s.role, s.activity
       from citizens c join citizen_world_state s on s.citizen_id = c.id
       where c.token_id in (7, 14, 21) order by c.token_id`,
    );
    expect(after[0]).toMatchObject({
      id: kept!.id,
      enrollment_status: "active",
      founding_membership_active: true,
      home_id: kept!.home_id,
      work_id: job!.id,
      role: job!.role,
    });
    expect(after[1]).toMatchObject({
      id: traced!.id,
      enrollment_status: "active",
      founding_membership_active: true,
      home_id: house!.id,
      work_id: job!.id,
      role: job!.role,
      activity: "idle",
    });
    expect(after[2]).toMatchObject({
      id: unknown!.id,
      enrollment_status: "active",
      founding_membership_active: true,
      home_id: null,
      work_id: null,
      role: null,
      activity: "idle",
    });
    const roster = await rows<{ membership_active: boolean; left_treasury_at: string | null }>(
      db,
      "select membership_active, left_treasury_at from genesis_roster where citizen_id = $1",
      [kept!.id],
    );
    expect(roster[0]).toEqual({ membership_active: true, left_treasury_at: null });
    await db.close();
  }, 60_000);
});

describe("onchain transfer activities", () => {
  it("records one confirmed transfer and does not duplicate a backfill or a replay", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 1);
    const [citizen] = await rows<{ id: string }>(db, "select id from citizens where token_id = 7");
    await db.query("update citizens set observed_owner = $1 where id = $2", [from, citizen!.id]);
    const tx = word(1100);
    const dedupe = (
      await rows<{ key: string }>(db, "select nft_transfer_dedupe($1, $2, 4) as key", [nft, tx])
    )[0]!.key;
    await db.query(
      `insert into civilization_events (
         dedupe_key, kind, category, source, summary, actor_citizen_id, chain_id, tx_hash, chain_status, payload, canonical
       ) values ($1, 'nft.transferred', 'onchain', 'onchain', 'Chog #7 transferred from A to B in block 11.', $2, 143, $3, 'confirmed', $4::jsonb, true)`,
      [
        dedupe,
        citizen!.id,
        tx,
        JSON.stringify({ tokenId: "7", from, to, blockNumber: "11", logIndex: 4 }),
      ],
    );
    await db.query(
      `insert into nft_transfer_cursors (chain_id, nft_contract, last_scanned_block, last_scanned_hash, last_success_at)
       values (143, $1, 11, $2, now())`,
      [nft, word(11)],
    );
    await db.query(
      `insert into nft_transfer_logs (
         chain_id, nft_contract, block_number, block_hash, tx_hash, tx_index, log_index, token_id, from_address, to_address
       ) values (143, $1, 11, $2, $3, 0, 4, 7, $4, $5)`,
      [nft, word(11), tx, from, to],
    );
    const first = await db.query<{ r: { inserted: number } }>("select project_nft_transfer_activities($1) as r", [nft]);
    const second = await db.query<{ r: { inserted: number } }>("select project_nft_transfer_activities($1) as r", [nft]);
    expect(first.rows[0]!.r.inserted).toBe(0);
    expect(second.rows[0]!.r.inserted).toBe(0);
    const events = await rows<{
      n: number;
      category: string;
      source: string;
      chain_status: string;
      canonical: boolean;
      tx_hash: string;
      token_id: string;
      from_address: string;
      to_address: string;
    }>(
      db,
      `select count(*) over ()::int as n, category, source, chain_status, canonical, tx_hash,
              payload->>'tokenId' as token_id, payload->>'from' as from_address, payload->>'to' as to_address
       from civilization_events where kind = 'nft.transferred'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      n: 1,
      category: "onchain",
      source: "onchain",
      chain_status: "confirmed",
      canonical: true,
      tx_hash: tx,
      token_id: "7",
      from_address: from,
      to_address: to,
    });
    const [owner] = await rows<{ observed_owner: string; enrollment_status: string; id: string }>(
      db,
      "select id, observed_owner, enrollment_status from citizens where token_id = 7",
    );
    expect(owner).toEqual({ id: citizen!.id, observed_owner: to, enrollment_status: "active" });
    await db.close();
  }, 60_000);

  it("hides an orphaned transfer, restores it when the log returns, and never invents one", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 1);
    const tx = word(1200);
    await db.query(
      `insert into nft_transfer_cursors (chain_id, nft_contract, last_scanned_block, last_success_at)
       values (143, $1, 12, now())`,
      [nft],
    );
    await db.query(
      `insert into nft_transfer_logs (
         chain_id, nft_contract, block_number, block_hash, tx_hash, tx_index, log_index, token_id, from_address, to_address
       ) values (143, $1, 12, $2, $3, 0, 1, 7, $4, $5)`,
      [nft, word(12), tx, from, to],
    );
    await db.query("select project_nft_transfer_activities($1)", [nft]);
    await db.query("delete from nft_transfer_logs");
    const orphaned = await db.query<{ r: { orphaned: number } }>("select project_nft_transfer_activities($1) as r", [nft]);
    expect(orphaned.rows[0]!.r.orphaned).toBe(1);
    const hidden = await rows<{ canonical: boolean; chain_status: string }>(
      db,
      "select canonical, chain_status from civilization_events where kind = 'nft.transferred'",
    );
    expect(hidden).toEqual([{ canonical: false, chain_status: "confirmed" }]);
    const [citizen] = await rows<{ n: number; enrollment_status: string }>(
      db,
      "select count(*)::int as n, enrollment_status from citizens group by enrollment_status",
    );
    expect(citizen).toEqual({ n: 1, enrollment_status: "active" });

    await db.query(
      `insert into nft_transfer_logs (
         chain_id, nft_contract, block_number, block_hash, tx_hash, tx_index, log_index, token_id, from_address, to_address
       ) values (143, $1, 12, $2, $3, 0, 1, 7, $4, $5)`,
      [nft, word(12), tx, from, to],
    );
    const restored = await db.query<{ r: { inserted: number; reconfirmed: number } }>(
      "select project_nft_transfer_activities($1) as r",
      [nft],
    );
    expect(restored.rows[0]!.r.inserted).toBe(0);
    expect(restored.rows[0]!.r.reconfirmed).toBe(1);
    const visible = await rows<{ n: number; canonical: boolean }>(
      db,
      "select count(*)::int as n, canonical from civilization_events where kind = 'nft.transferred' group by canonical",
    );
    expect(visible).toEqual([{ n: 1, canonical: true }]);
    await db.close();
  }, 60_000);

  it("projects a watcher scan once, drops a reorg, and ignores removed or failed reads", async () => {
    const chain = new FakeChain();
    chain.blocks = [header(10, 9), header(11, 10)];
    chain.tip = 11n;
    chain.logs = [transfer()];
    const db = await openWorldDb();
    await seedCitizens(db, 1);
    const sql = sqlFor(db);
    const scanned = await runDurableScan({
      sql,
      nftContract: nft,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(scanned.report.ok).toBe(true);
    const first = await rows<{ tx_hash: string; canonical: boolean; category: string }>(
      db,
      "select tx_hash, canonical, category from civilization_events where kind = 'nft.transferred'",
    );
    expect(first).toEqual([{ tx_hash: word(1100), canonical: true, category: "onchain" }]);
    await runDurableScan({
      sql,
      nftContract: nft,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    const replayed = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'nft.transferred'",
    );
    expect(replayed[0]!.n).toBe(1);

    chain.blocks = [header(10, 9), header(11, 10, 99)];
    chain.logs = [];
    await runDurableScan({
      sql,
      nftContract: nft,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    const orphaned = await rows<{ canonical: boolean }>(
      db,
      "select canonical from civilization_events where kind = 'nft.transferred'",
    );
    expect(orphaned).toEqual([{ canonical: false }]);
    const [still] = await rows<{ n: number; enrollment_status: string }>(
      db,
      "select count(*)::int as n, enrollment_status from citizens group by enrollment_status",
    );
    expect(still).toEqual({ n: 1, enrollment_status: "active" });

    chain.blocks = [header(10, 9), header(11, 10, 99), header(12, 99)];
    chain.tip = 12n;
    chain.fail = "logs";
    const failed = await runDurableScan({
      sql,
      nftContract: nft,
      source: chain,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    expect(failed.report.ok).toBe(false);
    const afterFailure = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'nft.transferred'",
    );
    expect(afterFailure[0]!.n).toBe(1);
    await db.close();

    const ignored = new FakeChain();
    ignored.blocks = [header(10, 9), header(11, 10)];
    ignored.tip = 11n;
    ignored.logs = [transfer({ removed: true }), transfer({ blockHash: word(999), logIndex: 5, transactionHash: word(1101) })];
    const empty = await openWorldDb();
    await seedCitizens(empty, 1);
    await runDurableScan({
      sql: sqlFor(empty),
      nftContract: nft,
      source: ignored,
      now,
      backfillFrom: 10n,
      maxLagBlocks: 2n,
      maxStaleMs: 60_000,
    });
    const none = await rows<{ n: number }>(
      empty,
      "select count(*)::int as n from civilization_events where kind = 'nft.transferred'",
    );
    expect(none[0]!.n).toBe(0);
    const citizens = await rows<{ n: number }>(empty, "select count(*)::int as n from citizens");
    expect(citizens[0]!.n).toBe(1);
    await empty.close();
  }, 60_000);

  it("does not record a transfer from a world tick", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 2);
    await initialize(db, 60);
    await tick(db, new Date(START.getTime() + 10_000));
    const events = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'nft.transferred' or category = 'onchain'",
    );
    expect(events[0]!.n).toBe(0);
    await db.close();
  }, 60_000);
});
