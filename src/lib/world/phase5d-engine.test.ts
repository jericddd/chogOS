import { describe, expect, it } from "vitest";
import { planConstruction } from "@/lib/world/placement";
import { completeOverlayTiles } from "@/lib/world/roads";
import { toBuilding, toRoad, type BuildingRow, type RoadRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, seedCitizens, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

async function setStock(
  db: Awaited<ReturnType<typeof openWorldDb>>,
  stock: { food?: number; wood?: number; stone?: number; tools?: number },
) {
  const [current] = await rows<{ stock: Record<string, number> }>(db, "select stock from world_buildings where id = 'storehouse'");
  const next = { ...current!.stock, ...stock };
  await db.query("update world_buildings set stock = $1::jsonb where id = 'storehouse'", [JSON.stringify(next)]);
}

async function evaluate(
  db: Awaited<ReturnType<typeof openWorldDb>>,
  seconds: number,
  tickSeq = seconds,
) {
  await db.query("select world_evaluate_town_needs($1::timestamptz, $2::bigint, $3::bigint)", [
    at(seconds).toISOString(),
    seconds * 60,
    tickSeq,
  ]);
  return (
    await db.query<{ r: Record<string, unknown> }>("select world_advance_town_projects($1::timestamptz, $2::bigint, $3::bigint) as r", [
      at(seconds).toISOString(),
      seconds * 60,
      tickSeq,
    ])
  ).rows[0]!.r;
}

async function overlay(db: Awaited<ReturnType<typeof openWorldDb>>) {
  const roads = (await rows<RoadRow>(db, "select * from world_roads")).map(toRoad).filter((road): road is NonNullable<ReturnType<typeof toRoad>> => road !== null);
  return completeOverlayTiles(roads);
}

describe("phase 5d town projects", () => {
  it("creates a territorial project from healthy state, does not duplicate it, and does not invent a farm emergency", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 400, wood: 400, stone: 400, tools: 400 });

    const first = await evaluate(db, 10, 10);
    expect(first.ok).toBe(true);
    const open = await rows<{ project_type: string; status: string; objective_key: string; recommended_kind: string }>(
      db,
      "select project_type, status, objective_key, recommended_kind from town_projects where status in ('proposed','active','blocked') order by priority desc",
    );
    expect(open.map((row) => row.project_type)).toEqual(["territorial"]);
    expect(open[0]).toMatchObject({
      objective_key: "territorial:east-y2-64",
      recommended_kind: "road",
    });
    expect(["proposed", "active"]).toContain(open[0]!.status);

    await evaluate(db, 15, 11);
    await evaluate(db, 20, 12);
    const again = await rows<{ n: number }>(db, "select count(*)::int as n from town_projects");
    expect(again[0]!.n).toBe(1);
    const created = await rows<{ source: string; n: number }>(
      db,
      "select source, count(*)::int as n from civilization_events where kind = 'town.project_created' group by source",
    );
    expect(created).toEqual([{ source: "system", n: 1 }]);
    const farms = await rows<{ n: number }>(db, "select count(*)::int as n from town_projects where project_type = 'food_production'");
    expect(farms[0]!.n).toBe(0);
    const hashed = await rows<{ seq: number; chain_status: string }>(
      db,
      "select seq, chain_status from civilization_events where kind = 'town.project_created'",
    );
    expect(Number(hashed[0]!.seq)).toBeGreaterThan(0);
    expect(hashed[0]!.chain_status).toBe("offchain");
    await db.close();
  }, 60_000);

  it("does not unlock a lot or complete a road step because an intent was queued", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 400, wood: 400, stone: 400, tools: 400 });
    await evaluate(db, 10, 10);
    const [project] = await rows<{ id: string; current_step_id: string; status: string }>(
      db,
      "select id::text, current_step_id, status from town_projects where objective_key = 'territorial:east-y2-64'",
    );
    expect(project!.current_step_id).toBe("place_road");

    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'test') returning id",
      [citizen!.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', 'north-farm', 'ai', $2)",
      [citizen!.citizen_id, decision!.id],
    );
    const linked = await db.query<{ r: Record<string, unknown> }>("select world_link_town_project($1::uuid, $2::uuid, $3::uuid) as r", [
      project!.id,
      decision!.id,
      citizen!.citizen_id,
    ]);
    expect(linked.rows[0]!.r.ok).toBe(true);
    await evaluate(db, 20, 20);
    const afterIntent = await rows<{ current_step_id: string; status: string; last_decision_id: string | null }>(
      db,
      "select current_step_id, status, last_decision_id::text from town_projects where id = $1::uuid",
      [project!.id],
    );
    expect(afterIntent[0]!.current_step_id).toBe("place_road");
    expect(afterIntent[0]!.status).not.toBe("completed");
    expect(afterIntent[0]!.last_decision_id).toBe(decision!.id);
    const served = await rows<{ n: number }>(db, "select count(*)::int as n from world_plots where id = 'plot-64-2' and served");
    expect(served[0]!.n).toBe(0);
    await db.close();
  }, 60_000);

  it("completes territorial steps only after the catalog road exists and the plot is served", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 400, wood: 400, stone: 400, tools: 400 });
    await evaluate(db, 10, 10);

    const placed = await db.query<{ r: Record<string, unknown> }>("select world_place_road($1,$2,$3,$4) as r", [
      "east-y2-64",
      "system",
      null,
      null,
    ]);
    expect(placed.rows[0]!.r.ok).toBe(true);
    const [plot] = await rows<{ served: boolean; status: string }>(
      db,
      "select served, status from world_plots where id = 'plot-64-2'",
    );
    expect(plot).toMatchObject({ served: true, status: "vacant" });

    await evaluate(db, 30, 30);
    const done = await rows<{
      status: string;
      current_step_id: string | null;
      steps: Array<{ id: string; status: string }>;
    }>(db, "select status, current_step_id, steps from town_projects where objective_key = 'territorial:east-y2-64'");
    expect(done[0]!.status).toBe("completed");
    expect(done[0]!.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
      "place_road:completed",
      "verify_connection:completed",
      "unlock_plot:completed",
    ]);
    const completedEvent = await rows<{ source: string; n: number }>(
      db,
      "select source, count(*)::int as n from civilization_events where kind = 'town.project_completed' group by source",
    );
    expect(completedEvent).toEqual([{ source: "system", n: 1 }]);
    await evaluate(db, 40, 40);
    const still = await rows<{ n: number; status: string }>(
      db,
      "select count(*)::int as n, min(status) as status from town_projects where objective_key = 'territorial:east-y2-64'",
    );
    expect(still[0]).toMatchObject({ n: 1, status: "completed" });
    await db.close();
  }, 90_000);

  it("tracks a food project from shortage through recovered stock without treating a proposal as food", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 12, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 10, 10);
    const food = await rows<{ status: string; current_step_id: string; steps: Array<{ id: string; status: string }> }>(
      db,
      "select status, current_step_id, steps from town_projects where project_type = 'food_production'",
    );
    expect(food[0]!.current_step_id).toBe("observe_production");
    expect(food[0]!.steps.find((step) => step.id === "place_building")?.status).toBe("skipped");
    expect(food[0]!.status).toBe("active");

    const [foodBefore] = await rows<{ food: number }>(
      db,
      "select (stock->>'food')::int as food from world_buildings where id = 'storehouse'",
    );
    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'test') returning id",
      [citizen!.citizen_id],
    );
    const [project] = await rows<{ id: string }>(db, "select id::text from town_projects where project_type = 'food_production'");
    await db.query("select world_link_town_project($1::uuid, $2::uuid, $3::uuid)", [project!.id, decision!.id, citizen!.citizen_id]);
    await evaluate(db, 20, 20);
    const still = await rows<{ status: string; current_step_id: string }>(
      db,
      "select status, current_step_id from town_projects where project_type = 'food_production'",
    );
    expect(still[0]).toMatchObject({ status: "active", current_step_id: "observe_production" });
    const [foodAfter] = await rows<{ food: number }>(
      db,
      "select (stock->>'food')::int as food from world_buildings where id = 'storehouse'",
    );
    expect(foodAfter!.food).toBe(foodBefore!.food);

    await setStock(db, { food: 80, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 30, 30);
    const recovered = await rows<{ status: string }>(db, "select status from town_projects where project_type = 'food_production'");
    expect(recovered[0]!.status).toBe("completed");
    await db.close();
  }, 60_000);

  it("requires an actual house to start and finish before a residential project can complete", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 400, wood: 400, stone: 400, tools: 400 });
    await db.query("update citizen_world_state set home_id = null where activity <> 'unavailable'");
    await evaluate(db, 10, 10);
    const residential = await rows<{
      id: string;
      status: string;
      current_step_id: string;
      recommended_kind: string;
    }>(db, "select id::text, status, current_step_id, recommended_kind from town_projects where project_type = 'residential'");
    expect(residential[0]).toMatchObject({
      current_step_id: "place_building",
      recommended_kind: "house",
    });
    expect(residential[0]!.status).toBe("active");
    const residentialId = residential[0]!.id;

    const views = (await rows<BuildingRow>(db, "select * from world_buildings")).map(toBuilding);
    const occupied = new Set(
      (await rows<{ id: string; status: string }>(db, "select id, status from world_plots"))
        .filter((plot) => plot.status !== "vacant")
        .map((plot) => plot.id),
    );
    const plan = planConstruction(views, occupied, "house", await overlay(db));
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
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'proposed', $1, 'gemini', 'test') returning id",
      [citizen!.citizen_id],
    );
    const built = await db.query<{ r: Record<string, unknown> }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) as r",
      [
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
      ],
    );
    expect(built.rows[0]!.r.ok).toBe(true);
    await evaluate(db, 20, 20);
    const started = await rows<{ current_step_id: string; related_building_id: string | null; status: string }>(
      db,
      "select current_step_id, related_building_id, status from town_projects where id = $1::uuid",
      [residentialId],
    );
    expect(started[0]!.related_building_id).toBe(plan.plan.buildingId);
    expect(started[0]!.current_step_id).toBe("complete_building");
    expect(started[0]!.status).toBe("blocked");

    await db.query(
      "update world_buildings set status = 'active', construction_progress = 100, completed_at = now(), role = null, job_slots = null where id = $1",
      [plan.plan.buildingId],
    );
    await evaluate(db, 30, 30);
    const finished = await rows<{ status: string; current_step_id: string | null }>(
      db,
      "select status, current_step_id from town_projects where id = $1::uuid",
      [residentialId],
    );
    expect(finished[0]!.status).toBe("completed");

    const clock = await rows<{ speed: number; layout_version: string }>(
      db,
      "select speed::int as speed, layout_version from world_state",
    );
    expect(clock[0]).toMatchObject({ speed: 60, layout_version: "genesis-v1.1" });
    const founding = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings where id = 'house-01'");
    expect(founding[0]!.n).toBe(1);
    const stepped = await tick(db, at(40));
    expect(stepped.status).toBe("ok");
    await db.close();
  }, 120_000);
});
