import { describe, expect, it } from "vitest";
import { genesisV1Layout, initializationLayout } from "@/lib/world/layout";
import { planConstruction, planHousePlacement, surveyedPlots } from "@/lib/world/placement";
import { toBuilding, type BuildingRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, seedCitizens, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

async function buildingViews(db: Awaited<ReturnType<typeof openWorldDb>>) {
  const buildingRows = await rows<BuildingRow>(db, "select * from world_buildings");
  return buildingRows.map(toBuilding);
}

async function occupiedPlots(db: Awaited<ReturnType<typeof openWorldDb>>) {
  const plots = await rows<{ id: string; status: string }>(db, "select id, status from world_plots");
  return new Set(plots.filter((plot) => plot.status !== "vacant").map((plot) => plot.id));
}

describe("phase 5a lots and construction kinds", () => {
  it("adds road-served lots without touching reserved y=2 lots or founding buildings", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    const plots = await rows<{ id: string; served: boolean; status: string; y: number }>(db, "select id, served, status, y from world_plots order by id");
    expect(plots.length).toBe(26);
    expect(plots.filter((plot) => plot.served).length).toBe(20);
    expect(plots.filter((plot) => plot.y === 2).every((plot) => plot.served === false && plot.status !== "occupied")).toBe(true);
    expect(plots.some((plot) => plot.id === "plot-80-11" && plot.served && plot.status === "vacant")).toBe(true);
    expect(plots.some((plot) => plot.id === "plot-53-57" && plot.served && plot.status === "vacant")).toBe(true);

    const before = plots.length;
    await db.exec(`
      insert into world_plots (id, x, y, w, h, served, status)
      values
        ('plot-80-11', 80, 11, 3, 3, true, 'vacant'),
        ('plot-53-57', 53, 57, 3, 3, true, 'vacant')
      on conflict (id) do nothing
    `);
    const after = await rows<{ n: number }>(db, "select count(*)::int as n from world_plots");
    expect(after[0]!.n).toBe(before);

    const buildings = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings");
    expect(buildings[0]!.n).toBe(initializationLayout().buildings.length);
    expect(genesisV1Layout().hash).toBe("7e8db240");
    const layout = await rows<{ layout_version: string }>(db, "select layout_version from world_state");
    expect(layout[0]!.layout_version).toBe("genesis-v1.1");
    await db.close();
  }, 60_000);

  it("places a farm, rejects illegal kinds and reserved lots, then activates it as a farmer workplace", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await db.exec(`
      update citizen_world_state
      set role = null, work_id = null
      where citizen_id in (
        select citizen_id from citizen_world_state
        where activity <> 'unavailable'
        order by citizen_id
        limit 8
      )
    `);
    const views = await buildingViews(db);
    const occupied = await occupiedPlots(db);
    const farmPlan = planConstruction(views, occupied, "farm");
    expect(farmPlan.ok).toBe(true);
    if (!farmPlan.ok) {
      await db.close();
      return;
    }
    expect(farmPlan.plan.kind).toBe("farm");
    expect(surveyedPlots().find((plot) => plot.id === farmPlan.plan.plotId)?.served).toBe(true);

    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'proposed', $1, 'gemini', 'gemini-3.5-flash-lite') returning id",
      [citizen!.citizen_id],
    );

    const reserved = await db.query<{ r: Record<string, unknown> }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
      ["plot-64-2", "house", "house-99", "Nope", 65, 2, JSON.stringify(farmPlan.plan.routes), "ai", decision!.id, citizen!.citizen_id],
    );
    expect(reserved.rows[0]!.r.ok).toBe(false);

    const road = await db.query<{ r: Record<string, unknown> }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
      [farmPlan.plan.plotId, "road", "road-01", "Road", farmPlan.plan.door.x, farmPlan.plan.door.y, JSON.stringify(farmPlan.plan.routes), "ai", decision!.id, citizen!.citizen_id],
    );
    expect(road.rows[0]!.r.ok).toBe(false);

    const placed = await db.query<{ r: Record<string, unknown> }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
      [
        farmPlan.plan.plotId,
        "farm",
        farmPlan.plan.buildingId,
        farmPlan.plan.name,
        farmPlan.plan.door.x,
        farmPlan.plan.door.y,
        JSON.stringify(farmPlan.plan.routes),
        "ai",
        decision!.id,
        citizen!.citizen_id,
      ],
    );
    expect(placed.rows[0]!.r.ok).toBe(true);
    expect(placed.rows[0]!.r.kind).toBe("farm");

    const duplicate = await db.query<{ r: Record<string, unknown> }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
      [
        farmPlan.plan.plotId,
        "farm",
        "farm-99",
        "Duplicate",
        farmPlan.plan.door.x,
        farmPlan.plan.door.y,
        JSON.stringify(farmPlan.plan.routes),
        "ai",
        decision!.id,
        citizen!.citizen_id,
      ],
    );
    expect(duplicate.rows[0]!.r.ok).toBe(false);

    const [site] = await rows<{ status: string; kind: string; role: string | null; construction_progress: number }>(
      db,
      "select status, kind, role, construction_progress from world_buildings where id = $1",
      [farmPlan.plan.buildingId],
    );
    expect(site).toMatchObject({ status: "under_construction", kind: "farm", role: "builder" });
    expect(Number(site!.construction_progress)).toBe(0);

    const started = await rows<{ source: string; kind: string; event_hash: string | null; payload: Record<string, unknown> }>(
      db,
      "select source, kind, event_hash, payload from civilization_events where kind = 'construction.started' and building_id = $1",
      [farmPlan.plan.buildingId],
    );
    expect(started[0]!.source).toBe("ai");
    expect(started[0]!.payload.kind).toBe("farm");

    const [builder] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where work_id = $1 and role = 'builder' limit 1",
      [farmPlan.plan.buildingId],
    );
    expect(builder).toBeTruthy();
    await db.query("update world_buildings set construction_progress = 96 where id = $1", [farmPlan.plan.buildingId]);
    const [workDecision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'gemini-3.5-flash-lite') returning id",
      [builder!.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', $2, 'ai', $3)",
      [builder!.citizen_id, farmPlan.plan.buildingId, workDecision!.id],
    );
    for (let seconds = 10; seconds <= 50 * 60; seconds += 20) {
      await tick(db, at(seconds));
      const [progress] = await rows<{ status: string; construction_progress: number }>(
        db,
        "select status, construction_progress from world_buildings where id = $1",
        [farmPlan.plan.buildingId],
      );
      if (progress!.status === "active") {
        break;
      }
    }
    const [done] = await rows<{
      status: string;
      role: string | null;
      job_slots: number | null;
      batch_shifts: number | null;
      open_air: boolean;
      capacity: number | null;
    }>(
      db,
      "select status, role, job_slots, batch_shifts, open_air, capacity from world_buildings where id = $1",
      [farmPlan.plan.buildingId],
    );
    expect(done).toMatchObject({
      status: "active",
      role: "farmer",
      job_slots: 4,
      batch_shifts: 3,
      open_air: true,
      capacity: null,
    });
    const farmers = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from citizen_world_state where work_id = $1 and role = 'farmer'",
      [farmPlan.plan.buildingId],
    );
    expect(farmers[0]!.n).toBeGreaterThan(0);
    const leftoverBuilders = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from citizen_world_state where work_id = $1 and role = 'builder'",
      [farmPlan.plan.buildingId],
    );
    expect(leftoverBuilders[0]!.n).toBe(0);
    const completed = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'construction.completed' and building_id = $1",
      [farmPlan.plan.buildingId],
    );
    expect(completed[0]!.n).toBe(1);

    const [farmer] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where work_id = $1 and role = 'farmer' limit 1",
      [farmPlan.plan.buildingId],
    );
    const [reason] = await rows<{ reason: string | null }>(
      db,
      "select world_check_action($1, 'work', $2, $3) as reason",
      [farmer!.citizen_id, farmPlan.plan.buildingId, 12 * 3600],
    );
    expect(reason!.reason).toBeNull();

    const afterFarm = await buildingViews(db);
    const workshopPlan = planConstruction(afterFarm, await occupiedPlots(db), "workshop");
    expect(workshopPlan.ok).toBe(true);
    if (workshopPlan.ok) {
      const [second] = await rows<{ id: string }>(
        db,
        "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'proposed', $1, 'gemini', 'gemini-3.5-flash-lite') returning id",
        [citizen!.citizen_id],
      );
      const workshop = await db.query<{ r: Record<string, unknown> }>(
        "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
        [
          workshopPlan.plan.plotId,
          "workshop",
          workshopPlan.plan.buildingId,
          workshopPlan.plan.name,
          workshopPlan.plan.door.x,
          workshopPlan.plan.door.y,
          JSON.stringify(workshopPlan.plan.routes),
          "ai",
          second!.id,
          citizen!.citizen_id,
        ],
      );
      expect(workshop.rows[0]!.r.ok).toBe(true);
      await db.query("update world_buildings set construction_progress = 100, status = 'active', completed_at = now() where id = $1", [
        workshopPlan.plan.buildingId,
      ]);
      const [shop] = await rows<{ role: string | null; batch_shifts: number | null; status: string }>(
        db,
        "select role, batch_shifts, status from world_buildings where id = $1",
        [workshopPlan.plan.buildingId],
      );
      expect(shop).toMatchObject({ status: "active", role: "crafter", batch_shifts: 3 });
    }

    const housePlan = planHousePlacement(await buildingViews(db), await occupiedPlots(db));
    expect(housePlan.ok).toBe(true);
    const founding = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from world_buildings where id in ('north-farm', 'riverside-farm', 'workshop-a', 'house-01')",
    );
    expect(founding[0]!.n).toBe(4);
    await db.close();
  }, 180_000);
});
