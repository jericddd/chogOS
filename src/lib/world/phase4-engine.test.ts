import { describe, expect, it } from "vitest";
import { planHousePlacement } from "@/lib/world/placement";
import { toBuilding, type BuildingRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, runFor, seedCitizens, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("phase 4 minds, skills, and construction", () => {
  it("initializes personalities idempotently and awards skill once per event", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 12);
    await initialize(db, 60);
    const first = await db.query<{ r: Record<string, unknown> }>("select world_ensure_minds() as r");
    const second = await db.query<{ r: Record<string, unknown> }>("select world_ensure_minds() as r");
    expect(Number(second.rows[0]!.r.personalitiesInserted)).toBe(0);
    expect(Number(first.rows[0]!.r.personalitiesInserted)).toBeGreaterThan(0);
    const people = await rows<{ n: number }>(db, "select count(*)::int as n from citizen_personalities");
    expect(people[0]!.n).toBeGreaterThan(0);
    const dup = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from (select citizen_id from citizen_personalities group by citizen_id having count(*) > 1) s",
    );
    expect(dup[0]!.n).toBe(0);

    const [crafter] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where role = 'crafter' limit 1",
    );
    const [event] = await rows<{ id: string }>(
      db,
      `insert into civilization_events (kind, category, source, summary, actor_citizen_id, dedupe_key, payload)
       values ('work.shift_completed', 'work', 'ai', 'shift', $1, 'phase4:skill', '{}') returning id`,
      [crafter!.citizen_id],
    );
    await db.query("select world_award_skill($1, 'crafting', $2, 8)", [crafter!.citizen_id, event!.id]);
    await db.query("select world_award_skill($1, 'crafting', $2, 8)", [crafter!.citizen_id, event!.id]);
    const [skill] = await rows<{ experience: number; level: number }>(
      db,
      "select experience, level from citizen_skills where citizen_id = $1 and name = 'crafting'",
      [crafter!.citizen_id],
    );
    expect(skill!.experience).toBe(8);
    expect(skill!.level).toBeGreaterThanOrEqual(1);
    const awards = await rows<{ n: number }>(db, "select count(*)::int as n from citizen_skill_awards");
    expect(awards[0]!.n).toBe(1);
    await db.close();
  }, 60_000);

  it("rejects a failed AI intent without recording a success memory, then applies a valid one", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 12);
    await initialize(db, 60);
    await db.query("select world_ensure_minds()");
    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where role = 'crafter' limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'gemini-3.8-flash') returning id",
      [citizen!.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', 'north-farm', 'ai', $2)",
      [citizen!.citizen_id, decision!.id],
    );
    await runFor(db, START, 3 * 60, 10);
    const [rejected] = await rows<{ status: string; reason: string }>(db, "select status, reason from world_intents");
    expect(rejected!.status).toBe("rejected");
    const [decisionRow] = await rows<{ status: string }>(db, "select status from ai_decisions where id = $1", [decision!.id]);
    expect(decisionRow!.status).toBe("rejected");
    const successMemories = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from ai_memories where citizen_id = $1 and outcome = 'success'",
      [citizen!.citizen_id],
    );
    expect(successMemories[0]!.n).toBe(0);
    const rejectedMemories = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from ai_memories where citizen_id = $1 and outcome = 'rejected'",
      [citizen!.citizen_id],
    );
    expect(rejectedMemories[0]!.n).toBe(1);

    const [state] = await rows<{ ends_at: string }>(
      db,
      "select ends_at from citizen_world_state where citizen_id = $1",
      [citizen!.citizen_id],
    );
    const [second] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'gemini-3.8-flash') returning id",
      [citizen!.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'socialize', 'commons-square', 'ai', $2)",
      [citizen!.citizen_id, second!.id],
    );
    expect(state!.ends_at).toBeTruthy();
    for (let seconds = 3 * 60 + 10; seconds < 20 * 60; seconds += 10) {
      await tick(db, at(seconds));
      const [intent] = await rows<{ status: string }>(db, "select status from world_intents where action = 'socialize'");
      if (intent!.status !== "pending") {
        break;
      }
    }
    const [accepted] = await rows<{ status: string }>(db, "select status from world_intents where action = 'socialize'");
    expect(accepted!.status).toBe("accepted");
    const [after] = await rows<{ decision_source: string }>(
      db,
      "select decision_source from citizen_world_state where citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(after!.decision_source).toBe("ai");
    const [executed] = await rows<{ status: string; outcome_event_id: string | null }>(
      db,
      "select status, outcome_event_id from ai_decisions where id = $1",
      [second!.id],
    );
    expect(["accepted", "executed", "queued"]).toContain(executed!.status);
    for (let seconds = 20 * 60; seconds <= 45 * 60; seconds += 20) {
      const aiNow = await rows<{ n: number }>(
        db,
        "select count(*)::int as n from civilization_events where source = 'ai' and actor_citizen_id = $1",
        [citizen!.citizen_id],
      );
      if (aiNow[0]!.n > 0) {
        break;
      }
      await tick(db, at(seconds));
    }
    const aiEvents = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where source = 'ai' and actor_citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(aiEvents[0]!.n).toBeGreaterThan(0);
    const [stateAfter] = await rows<{ purpose: string | null; activity: string; location_id: string | null }>(
      db,
      "select purpose, activity, location_id from citizen_world_state where citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(stateAfter!.purpose === "socialize" || stateAfter!.activity === "socializing" || stateAfter!.location_id === "commons-square").toBe(
      true,
    );
    await db.close();
  }, 60_000);

  it("places a house on a served plot, persists it, and advances construction through ticks", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    const buildingRows = await rows<BuildingRow>(db, "select * from world_buildings");
    const views = buildingRows.map(toBuilding);
    const plan = planHousePlacement(views);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      await db.close();
      return;
    }
    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'proposed', $1, 'gemini', 'gemini-3.8-flash') returning id",
      [citizen!.citizen_id],
    );
    const placed = await db.query<{ r: Record<string, unknown> }>("select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r", [
      plan.plan.plotId,
      "house",
      plan.plan.buildingId,
      plan.plan.name,
      plan.plan.door.x,
      plan.plan.door.y,
      JSON.stringify(plan.plan.routes),
      "ai",
      decision!.id,
      citizen!.citizen_id,
    ]);
    expect(placed.rows[0]!.r.ok).toBe(true);
    const overlap = await db.query<{ r: Record<string, unknown> }>("select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r", [
      plan.plan.plotId,
      "house",
      "house-99",
      "Nope",
      plan.plan.door.x,
      plan.plan.door.y,
      JSON.stringify(plan.plan.routes),
      "ai",
      decision!.id,
      citizen!.citizen_id,
    ]);
    expect(overlap.rows[0]!.r.ok).toBe(false);

    const [site] = await rows<{ status: string; construction_progress: number; x: number; y: number }>(
      db,
      "select status, construction_progress, x, y from world_buildings where id = $1",
      [plan.plan.buildingId],
    );
    expect(site).toMatchObject({ status: "under_construction", x: plan.plan.rect.x, y: plan.plan.rect.y });
    expect(Number(site!.construction_progress)).toBe(0);

    const [builder] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where work_id = $1 and role = 'builder' limit 1",
      [plan.plan.buildingId],
    );
    if (builder) {
      const [workDecision] = await rows<{ id: string }>(
        db,
        "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'gemini-3.8-flash') returning id",
        [builder.citizen_id],
      );
      await db.query(
        "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', $2, 'ai', $3)",
        [builder.citizen_id, plan.plan.buildingId, workDecision!.id],
      );
      for (let seconds = 10; seconds <= 40 * 60; seconds += 20) {
        await tick(db, at(seconds));
        const [progress] = await rows<{ construction_progress: number }>(
          db,
          "select construction_progress from world_buildings where id = $1",
          [plan.plan.buildingId],
        );
        if (Number(progress!.construction_progress) > 0) {
          break;
        }
      }
      const [after] = await rows<{ construction_progress: number; status: string }>(
        db,
        "select construction_progress, status from world_buildings where id = $1",
        [plan.plan.buildingId],
      );
      expect(Number(after!.construction_progress)).toBeGreaterThan(0);
      expect(after!.status).toBe("under_construction");
    }

    const started = await rows<{ source: string }>(
      db,
      "select source from civilization_events where kind = 'construction.started' and building_id = $1",
      [plan.plan.buildingId],
    );
    expect(started[0]!.source).toBe("ai");
    const stillThere = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings where id = $1", [
      plan.plan.buildingId,
    ]);
    expect(stillThere[0]!.n).toBe(1);
    const layout = await rows<{ layout_version: string }>(db, "select layout_version from world_state");
    expect(layout[0]!.layout_version).toBe("genesis-v1.1");
    await db.close();
  }, 120_000);

  it("does not treat a rule-based fallback as an AI decision", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 8);
    await initialize(db, 60, START);
    await runFor(db, START, 120, 10);
    const fakeAi = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events where source = 'ai'");
    expect(fakeAi[0]!.n).toBe(0);
    await db.close();
  }, 60_000);
});

describe("fair claims", () => {
  it("does not hand the same citizen to two overlapping runs", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 8);
    await initialize(db, 60);
    await db.query("select world_ensure_minds()");
    const runA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 2, interval '1800 seconds')",
      [runA],
    );
    const second = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 2, interval '1800 seconds')",
      [runB],
    );
    const ids = new Set([...first, ...second].map((row) => row.claimed_citizen_id));
    expect(ids.size).toBe(first.length + second.length);
    await db.close();
  }, 60_000);
});
