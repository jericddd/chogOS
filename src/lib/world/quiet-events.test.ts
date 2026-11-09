import { describe, expect, it } from "vitest";
import { initialize, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

describe("routine event quieting", () => {
  it("keeps one simulation homecoming per day and still counts every meeting", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 2);
    await initialize(db, 60);
    const people = await rows<{ id: string }>(db, "select id from citizens order by token_id limit 2");
    const [first, second] = people;
    expect(first && second).toBeTruthy();

    const record = (dedupe: string, kind: string, source: string, related: string | null) =>
      db.query("select world_record_event($1, $2, 'movement', $3, 'A routine line.', $4, 'house-01', $5, now(), 0, 1, '{}'::jsonb) as id", [
        dedupe,
        kind,
        source,
        first!.id,
        related,
      ]);

    await record("home-1", "movement.arrived_home", "simulation", null);
    await record("home-2", "movement.arrived_home", "simulation", null);
    const homes = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'movement.arrived_home'",
    );
    expect(homes[0]!.n).toBe(1);

    await record("ai-home-1", "movement.arrived_home", "ai", null);
    await record("ai-home-2", "movement.arrived_home", "ai", null);
    const aiHomes = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'movement.arrived_home' and source = 'ai'",
    );
    expect(aiHomes[0]!.n).toBe(2);

    await db.query(
      "select world_record_event($1, 'social.met', 'social', 'simulation', 'They met.', $2, 'house-01', $3, now(), 10, 2, '{}'::jsonb)",
      ["met-1", first!.id, second!.id],
    );
    await db.query(
      "select world_record_event($1, 'social.met', 'social', 'simulation', 'They met again.', $2, 'house-01', $3, now(), 20, 3, '{}'::jsonb)",
      ["met-2", first!.id, second!.id],
    );
    const mets = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events where kind = 'social.met'");
    const bond = await rows<{ meetings: number }>(db, "select meetings from citizen_bonds");
    expect(mets[0]!.n).toBe(1);
    expect(bond[0]!.meetings).toBe(2);

    await record("build-1", "construction.work_started", "simulation", null);
    await record("build-2", "construction.work_started", "simulation", null);
    const builds = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'construction.work_started'",
    );
    expect(builds[0]!.n).toBe(2);
  });
});
