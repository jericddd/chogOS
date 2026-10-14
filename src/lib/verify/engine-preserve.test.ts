import { describe, expect, it } from "vitest";
import { initializationLayout } from "@/lib/world/layout";
import { initialize, openWorldDb, rows, seedCitizens, START, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("verification migration preserves the world", () => {
  it("keeps buildings, routes, citizens, and history, and seals new events", async () => {
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 12);
        await pre.query(
          `insert into civilization_events (kind, summary, dedupe_key, payload)
           values ('genesis_joined', 'legacy row', 'legacy:preserve', '{"tokenId":"7"}')`,
        );
      },
    });
    await initialize(db, 60, START);
    const buildings = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings");
    const routes = await rows<{ n: number }>(db, "select count(*)::int as n from world_routes");
    const citizens = await rows<{ n: number }>(db, "select count(*)::int as n from citizen_world_state");
    const layout = initializationLayout();
    expect(buildings[0]!.n).toBe(layout.buildings.length);
    expect(routes[0]!.n).toBeGreaterThan(0);
    expect(citizens[0]!.n).toBe(12);

    const unsealed = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where event_hash is not null",
    );
    expect(unsealed[0]!.n).toBe(0);

    const legacy = await rows<{ event_hash: string | null; seq: number }>(
      db,
      "select event_hash, seq from civilization_events where dedupe_key = 'legacy:preserve'",
    );
    expect(legacy[0]!.event_hash).toBeNull();

    const cut = await rows<{ r: Record<string, unknown> }>(db, "select verify_cutover() as r");
    expect(cut[0]!.r.status).toBe("cut_over");
    const hashed = await rows<{ r: Record<string, unknown> }>(db, "select verify_hash_historical() as r");
    expect(hashed[0]!.r.status).toBe("hashed");
    const legacyAfter = await rows<{ event_hash: string | null; integrity_class: string }>(
      db,
      "select event_hash, integrity_class from civilization_events where dedupe_key = 'legacy:preserve'",
    );
    expect(legacyAfter[0]!.integrity_class).toBe("historical");
    expect(legacyAfter[0]!.event_hash).toMatch(/^0x[0-9a-f]{64}$/);

    await tick(db, at(10));
    const live = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where integrity_class = 'live' and event_hash is not null",
    );
    expect(live[0]!.n).toBeGreaterThan(0);

    await expect(db.query("delete from civilization_events")).rejects.toThrow(/append-only/);
    await expect(
      db.query("update civilization_events set summary = 'tamper' where dedupe_key = 'legacy:preserve'"),
    ).rejects.toThrow(/cannot be updated/);
    const again = await rows<{ r: Record<string, unknown> }>(db, "select verify_cutover() as r");
    expect(again[0]!.r.status).toBe("already_cut_over");
    const privilege = async (sql: string) => (await rows<{ ok: boolean }>(db, `select ${sql} as ok`))[0]!.ok;
    for (const table of ["event_integrity_batches", "event_integrity_proofs", "verification_state"]) {
      for (const role of ["anon", "authenticated"]) {
        expect(await privilege(`has_table_privilege('${role}', '${table}', 'select')`)).toBe(false);
      }
      expect(await privilege(`has_table_privilege('service_role', '${table}', 'select')`)).toBe(true);
      expect(await privilege(`has_table_privilege('service_role', '${table}', 'insert')`)).toBe(false);
    }
    expect(await privilege("has_function_privilege('anon', 'verify_cutover()', 'execute')")).toBe(false);
    expect(await privilege("has_function_privilege('service_role', 'verify_cutover()', 'execute')")).toBe(true);

    const hashedRows = await rows<{ id: string; seq: number; event_hash: string }>(
      db,
      `select id, seq, event_hash from civilization_events
       where integrity_class = 'historical' and merkle_batch_id is null
       order by seq`,
    );
    const { buildEventTree, proofForHash, TREE_FORMAT, verifyInclusion } = await import("@/lib/verify/merkle");
    const tree = buildEventTree(hashedRows.map((row) => row.event_hash));
    const proofs = hashedRows.map((row) => ({ eventId: row.id, proof: proofForHash(tree, row.event_hash).proof }));
    const committed = await rows<{ r: Record<string, unknown> }>(db, "select verify_commit_batch($1::jsonb) as r", [
      JSON.stringify({
        kind: "historical_snapshot",
        fromSeq: Number(hashedRows[0]!.seq),
        toSeq: Number(hashedRows[hashedRows.length - 1]!.seq),
        eventCount: hashedRows.length,
        root: tree.root,
        treeFormat: TREE_FORMAT,
        dump: { format: "standard-v1" },
        proofs,
      }),
    ]);
    expect(committed[0]!.r.status).toBe("committed");
    expect(verifyInclusion(tree.root, hashedRows[0]!.event_hash, proofs[0]!.proof)).toBe(true);
    const dup = await rows<{ r: Record<string, unknown> }>(db, "select verify_commit_batch($1::jsonb) as r", [
      JSON.stringify({
        kind: "historical_snapshot",
        fromSeq: Number(hashedRows[0]!.seq),
        toSeq: Number(hashedRows[hashedRows.length - 1]!.seq),
        eventCount: hashedRows.length,
        root: tree.root,
        treeFormat: TREE_FORMAT,
        dump: {},
        proofs,
      }),
    ]);
    expect(dup[0]!.r.status).toBe("duplicate_root");
    const snap = await rows<{ snapshot_committed_at: string | null; kind: string }>(
      db,
      "select snapshot_committed_at, kind from event_integrity_batches where kind = 'historical_snapshot'",
    );
    expect(snap[0]!.kind).toBe("historical_snapshot");
    expect(snap[0]!.snapshot_committed_at).toBeTruthy();

    const mismatch = await rows<{ r: Record<string, unknown> }>(db, "select verify_commit_batch($1::jsonb) as r", [
      JSON.stringify({
        kind: "live",
        fromSeq: 1,
        toSeq: 1,
        eventCount: 1,
        root: "0x" + "11".repeat(32),
        treeFormat: TREE_FORMAT,
        dump: {},
        proofs: [],
      }),
    ]);
    expect(["no_unbatched_events", "count_mismatch", "proof_count_mismatch"]).toContain(mismatch[0]!.r.status);

    await expect(
      db.query("select verify_record_anchor($1, 'confirmed', 10143, $2, null, null)", [
        committed[0]!.r.batchId,
        "0x0000000000000000000000000000000000000001",
      ]),
    ).rejects.toThrow(/requires chain, contract, tx, and block/);

    const first = await rows<{ id: string }>(
      db,
      `select world_record_event('probe:retry', 'probe.retry', 'world', 'system', 'once', null, null, null, now(), 0, 0, '{}'::jsonb) as id`,
    );
    const second = await rows<{ id: string | null }>(
      db,
      `select world_record_event('probe:retry', 'probe.retry', 'world', 'system', 'twice', null, null, null, now(), 0, 0, '{}'::jsonb) as id`,
    );
    expect(first[0]!.id).toBeTruthy();
    expect(second[0]!.id).toBeNull();
    const retries = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where dedupe_key = 'probe:retry'",
    );
    expect(retries[0]!.n).toBe(1);

    const originalId = await rows<{ id: string }>(
      db,
      "select id from civilization_events where dedupe_key = 'legacy:preserve'",
    );
    const correction = await rows<{ id: string }>(
      db,
      "select verify_record_correction($1, 'Correction note.', '{}'::jsonb) as id",
      [originalId[0]!.id],
    );
    expect(correction[0]!.id).toBeTruthy();
    const original = await rows<{ summary: string }>(
      db,
      "select summary from civilization_events where dedupe_key = 'legacy:preserve'",
    );
    expect(original[0]!.summary).toBe("legacy row");

    const chain = await rows<{ seq: number; event_hash: string; prev_event_hash: string | null }>(
      db,
      `select seq, event_hash, prev_event_hash from civilization_events
       where integrity_class = 'live' and event_hash is not null
       order by seq`,
    );
    expect(chain.length).toBeGreaterThan(1);
    expect(chain[1]!.prev_event_hash).toBe(chain[0]!.event_hash);

    await expect(db.query("insert into civilization_events (seq, kind, summary, dedupe_key) values ($1, 'probe', 'dup seq', 'probe:dup-seq')", [chain[0]!.seq])).rejects.toThrow();
    await db.close();
  }, 60_000);
});
