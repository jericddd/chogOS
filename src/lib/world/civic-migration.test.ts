import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";
import { migrationFiles } from "@/lib/world/test-db";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
const CIVIC = "20261023040000_civic_places.sql";
const MIND = "20261023190000_mind_repair.sql";

const quotedToken = (word: string) => `'${word}'`;

async function openMigratedDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role authenticator nologin;
    create role service_role nologin bypassrls;
  `);
  return db;
}

async function applyBefore(db: PGlite, fileName: string): Promise<void> {
  for (const file of migrationFiles()) {
    if (file >= fileName) break;
    await db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
}

function sqlFile(fileName: string): string {
  return readFileSync(path.join(migrationsDir, fileName), "utf8");
}

/**
 * The production kind check can be deparsed without a separately quoted
 * 'market' token. Rebuild the four allow-lists in that shape, and rename the
 * activity check so only the single-column fallback can find it.
 */
async function installProductionShapedChecks(db: PGlite): Promise<void> {
  await db.exec(`
    alter table public.world_buildings drop constraint world_buildings_kind_check;
    alter table public.world_buildings add constraint world_buildings_kind_check
      check (kind ~ '^(house|hall|commons|farm|forest|quarry|workshop|storehouse|market)$');

    alter table public.citizen_world_state drop constraint citizen_world_state_activity_check;
    alter table public.citizen_world_state add constraint citizen_world_state_activity_legacy
      check (activity ~ '^(walking|working|gathering|building|shopping|socializing|resting|sleeping|idle|unavailable)$');

    alter table public.citizen_world_state drop constraint citizen_world_state_purpose_check;
    alter table public.citizen_world_state add constraint citizen_world_state_purpose_check
      check (purpose is null or purpose ~ '^(work|shop|socialize|rest|sleep|idle)$');

    alter table public.world_intents drop constraint world_intents_action_check;
    alter table public.world_intents add constraint world_intents_action_check
      check (action ~ '^(work|shop|socialize|rest|sleep)$');
  `);
}

async function constraintDef(db: PGlite, name: string): Promise<string | null> {
  const result = await db.query<{ def: string | null }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`,
    [name],
  );
  return result.rows[0]?.def ?? null;
}

describe("civic migration against the production check shape", () => {
  it("keeps civic_places ahead of mind_repair and widens the live checks without deleting rows", async () => {
    const files = migrationFiles();
    expect(files.indexOf(CIVIC)).toBeGreaterThanOrEqual(0);
    expect(files.indexOf(CIVIC)).toBeLessThan(files.indexOf(MIND));
    expect(files.filter((file) => file > CIVIC && file < MIND)).toEqual([]);

    const db = await openMigratedDb();
    await applyBefore(db, CIVIC);
    await installProductionShapedChecks(db);

    const kindBefore = await constraintDef(db, "world_buildings_kind_check");
    expect(kindBefore).toBeTruthy();
    expect(kindBefore!.includes(quotedToken("market"))).toBe(false);
    expect(kindBefore!.includes("market")).toBe(true);
    expect(kindBefore!.includes("park")).toBe(false);

    await db.exec(`
      insert into citizens (chain_id, nft_contract, token_id, enrollment_status, origin)
      values (143, '0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763', 999001, 'active', 'community');
      insert into civilization_events (kind, summary, dedupe_key)
      values ('world.marker', 'pre-civic marker', 'test:pre-civic-marker');
    `);
    const buildingsBefore = await db.query<{ id: string }>("select id from world_buildings order by id");
    const citizensBefore = await db.query<{ n: number }>("select count(*)::int as n from citizens");
    const eventsBefore = await db.query<{ n: number }>(
      "select count(*)::int as n from civilization_events where dedupe_key = 'test:pre-civic-marker'",
    );
    expect(citizensBefore.rows[0]!.n).toBe(1);
    expect(eventsBefore.rows[0]!.n).toBe(1);

    await expect(db.exec(sqlFile(MIND))).rejects.toThrow(/civic_places/);
    const lawsAfterEarlyMind = await db.query<{ rel: string | null }>(
      "select to_regclass('public.world_laws')::text as rel",
    );
    const bondAfterEarlyMind = await db.query<{ rel: string | null }>(
      "select to_regprocedure('public.world_progress_bond(uuid,uuid)')::text as rel",
    );
    const fineAfterEarlyMind = await db.query<{ rel: string | null }>(
      "select to_regprocedure('public.world_levy_fine(uuid,uuid)')::text as rel",
    );
    expect(lawsAfterEarlyMind.rows[0]!.rel).toBeNull();
    expect(bondAfterEarlyMind.rows[0]!.rel).toBeNull();
    expect(fineAfterEarlyMind.rows[0]!.rel).toBeNull();

    await db.exec(sqlFile(CIVIC));
    await db.exec(sqlFile(MIND));

    const kindAfter = await constraintDef(db, "world_buildings_kind_check");
    const activityAfter = await constraintDef(db, "citizen_world_state_activity_check");
    const purposeAfter = await constraintDef(db, "citizen_world_state_purpose_check");
    const actionAfter = await constraintDef(db, "world_intents_action_check");
    expect(kindAfter).toContain("park");
    expect(kindAfter).toContain("bank");
    expect(activityAfter).toContain("visiting");
    expect(purposeAfter).toContain("visit");
    expect(actionAfter).toContain("visit");
    expect(await constraintDef(db, "citizen_world_state_activity_legacy")).toBeNull();
    expect(await constraintDef(db, "world_intents_ai_decision")).toBeTruthy();

    const objects = await db.query<{
      laws: string | null;
      sentences: string | null;
      bonds: string | null;
      open_places: string | null;
      snapshot: string | null;
      progress: string | null;
    }>(`
      select
        to_regclass('public.world_laws')::text as laws,
        to_regclass('public.world_sentences')::text as sentences,
        to_regclass('public.citizen_bonds')::text as bonds,
        to_regprocedure('public.world_open_civic_places()')::text as open_places,
        to_regprocedure('public.world_civic_snapshot()')::text as snapshot,
        to_regprocedure('public.world_progress_bond(uuid,uuid)')::text as progress
    `);
    expect(objects.rows[0]).toMatchObject({
      laws: "world_laws",
      sentences: "world_sentences",
      bonds: "citizen_bonds",
      open_places: "world_open_civic_places()",
      snapshot: "world_civic_snapshot()",
      progress: "world_progress_bond(uuid,uuid)",
    });

    const citizensAfter = await db.query<{ n: number }>("select count(*)::int as n from citizens");
    const marker = await db.query<{ summary: string }>(
      "select summary from civilization_events where dedupe_key = 'test:pre-civic-marker'",
    );
    const buildingsAfter = await db.query<{ id: string }>("select id from world_buildings order by id");
    expect(citizensAfter.rows[0]!.n).toBe(1);
    expect(marker.rows.map((row) => row.summary)).toEqual(["pre-civic marker"]);
    const afterIds = new Set(buildingsAfter.rows.map((row) => row.id));
    for (const building of buildingsBefore.rows) expect(afterIds.has(building.id)).toBe(true);

    const jail = await db.query<{ reason: string }>(
      `select world_place_building('plot-64-11', 'jail', 'jail-01', 'Jail', 65, 11, '[]'::jsonb, 'system', null, null) ->> 'reason' as reason`,
    );
    const fine = await db.query<{ reason: string }>(
      "select world_levy_fine(null, null) ->> 'reason' as reason",
    );
    const detention = await db.query<{ reason: string }>(
      "select world_detain_citizen(null, null) ->> 'reason' as reason",
    );
    expect(jail.rows[0]!.reason).toBe("jail construction is disabled");
    expect(fine.rows[0]!.reason).toBe("punitive fines are disabled");
    expect(detention.rows[0]!.reason).toBe("detention is disabled");
  });
});
