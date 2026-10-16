import { describe, expect, it } from "vitest";
import { BUILDINGS, isRoad, pathAcross, type PathBuilding } from "@/lib/world/layout";
import { planConstruction, surveyedPlots } from "@/lib/world/placement";
import { ROAD_STUBS } from "@/lib/world/roads";
import { toBuilding, type BuildingRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, seedCitizens, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

async function buildingViews(db: Awaited<ReturnType<typeof openWorldDb>>) {
  return (await rows<BuildingRow>(db, "select * from world_buildings")).map(toBuilding);
}

async function occupiedPlots(db: Awaited<ReturnType<typeof openWorldDb>>) {
  const plots = await rows<{ id: string; status: string }>(db, "select id, status from world_plots");
  return new Set(plots.filter((plot) => plot.status !== "vacant").map((plot) => plot.id));
}

async function stock(db: Awaited<ReturnType<typeof openWorldDb>>) {
  const [row] = await rows<{ stock: Record<string, number> }>(db, "select stock from world_buildings where id = 'storehouse'");
  return row!.stock;
}

async function placeRoad(
  db: Awaited<ReturnType<typeof openWorldDb>>,
  stub: string,
  source = "system",
  decision: string | null = null,
  citizen: string | null = null,
) {
  const placed = await db.query<{ r: Record<string, unknown> }>("select world_place_road($1,$2,$3,$4) as r", [
    stub,
    source,
    decision,
    citizen,
  ]);
  return placed.rows[0]!.r;
}

describe("phase 5b roads", () => {
  it("places a catalog spur, unlocks only the touching lot, and lets Phase 5a build on it", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);

    const beforeStock = await stock(db);
    const beforePlots = await rows<{ id: string; served: boolean; status: string; y: number }>(
      db,
      "select id, served, status, y from world_plots order by id",
    );
    expect(beforePlots.filter((plot) => plot.served)).toHaveLength(20);
    expect(beforePlots.filter((plot) => plot.y === 2).every((plot) => plot.served === false && plot.status === "reserved")).toBe(
      true,
    );
    const [foundingSteps] = await rows<{ steps: number }>(
      db,
      "select steps from world_routes where from_id = 'house-01' and to_id = 'market'",
    );
    const [clockBefore] = await rows<{ speed: number; layout_version: string; tick_seq: number }>(
      db,
      "select speed::int as speed, layout_version, tick_seq::int from world_state",
    );

    const unknown = await placeRoad(db, "invented-path");
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe("unknown road stub");

    const disconnected = await db.query(
      "insert into world_road_catalog (id, name, tiles, serves_plot_ids) values ('island-10-2', 'Island', '[{\"x\":10,\"y\":2}]'::jsonb, '{}')",
    );
    expect(disconnected.affectedRows ?? 1).toBeGreaterThan(0);
    const island = await placeRoad(db, "island-10-2");
    expect(island.ok).toBe(false);
    expect(island.reason).toBe("road stub does not connect to the existing road network");

    await db.query(
      "insert into world_road_catalog (id, name, tiles, serves_plot_ids) values ('over-house', 'Over house', '[{\"x\":2,\"y\":4}]'::jsonb, '{}')",
    );
    const overlap = await placeRoad(db, "over-house");
    expect(overlap.ok).toBe(false);
    expect(overlap.reason).toBe("road stub overlaps a building");

    await db.query(
      "insert into world_road_catalog (id, name, tiles, serves_plot_ids) values ('east-y2-64-short', 'Short spur', '[{\"x\":65,\"y\":6}]'::jsonb, array['plot-64-2'])",
    );
    await db.query(
      "insert into world_roads (id, stub_id, layout_version, tiles, status, source) values ('east-y2-64-short', 'east-y2-64-short', 'genesis-v1.1', '[{\"x\":65,\"y\":6}]'::jsonb, 'complete', 'system')",
    );
    await db.query("select world_refresh_plot_service()");
    const short = await rows<{ served: boolean; status: string }>(db, "select served, status from world_plots where id = 'plot-64-2'");
    expect(short[0]).toMatchObject({ served: false, status: "reserved" });
    await db.query("delete from world_roads where id = 'east-y2-64-short'");

    const starved = await db.query("update world_buildings set stock = jsonb_set(stock, '{wood}', '1') where id = 'storehouse'");
    expect(starved.affectedRows ?? 1).toBe(1);
    const broke = await placeRoad(db, "east-y2-64");
    expect(broke.ok).toBe(false);
    expect(broke.reason).toBe("not enough wood and stone in the Storehouse");
    expect((await stock(db)).wood).toBe(1);
    const noEvent = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events where kind = 'road.placed'");
    expect(noEvent[0]!.n).toBe(0);
    await db.query("update world_buildings set stock = $1::jsonb where id = 'storehouse'", [JSON.stringify(beforeStock)]);

    const placed = await placeRoad(db, "east-y2-64");
    expect(placed.ok).toBe(true);
    expect(placed.stubId).toBe("east-y2-64");
    expect(placed.servedPlotIds).toEqual(["plot-64-2"]);

    const duplicate = await placeRoad(db, "east-y2-64");
    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toBe("road stub already placed");

    const afterStock = await stock(db);
    expect(afterStock.wood).toBe(beforeStock.wood - 3);
    expect(afterStock.stone).toBe(beforeStock.stone - 2);

    const overlay = await rows<{ id: string; tiles: Array<{ x: number; y: number }>; status: string }>(
      db,
      "select id, tiles, status from world_roads",
    );
    expect(overlay).toEqual([
      {
        id: "east-y2-64",
        tiles: [
          { x: 65, y: 9 },
          { x: 65, y: 8 },
          { x: 65, y: 6 },
          { x: 65, y: 5 },
        ],
        status: "complete",
      },
    ]);

    const plots = await rows<{ id: string; served: boolean; status: string; y: number }>(
      db,
      "select id, served, status, y from world_plots order by id",
    );
    expect(plots.find((plot) => plot.id === "plot-64-2")).toMatchObject({ served: true, status: "vacant" });
    expect(plots.filter((plot) => plot.y === 2 && plot.id !== "plot-64-2").every((plot) => plot.served === false && plot.status === "reserved")).toBe(
      true,
    );
    expect(plots.filter((plot) => plot.served)).toHaveLength(21);

    const again = await db.query<{ r: Record<string, unknown> }>("select world_refresh_plot_service() as r");
    expect(again.rows[0]!.r).toMatchObject({ ok: true, served: [] });
    const servedEvents = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'plot.served' and payload->>'plotId' = 'plot-64-2'",
    );
    expect(servedEvents[0]!.n).toBe(1);

    const roadEvents = await rows<{ source: string; kind: string; category: string; dedupe_key: string; payload: Record<string, unknown> }>(
      db,
      "select source, kind, category, dedupe_key, payload from civilization_events where kind = 'road.placed'",
    );
    expect(roadEvents).toHaveLength(1);
    expect(roadEvents[0]).toMatchObject({
      source: "system",
      category: "construction",
      dedupe_key: "sim:east-y2-64:road.placed",
    });
    expect(roadEvents[0]!.payload.stubId).toBe("east-y2-64");
    const plotEvent = await rows<{ source: string; kind: string }>(
      db,
      "select source, kind from civilization_events where kind = 'plot.served'",
    );
    expect(plotEvent).toEqual([{ source: "simulation", kind: "plot.served" }]);

    const lot: PathBuilding = {
      id: "house-east-64",
      kind: "house",
      rect: { x: 64, y: 2, w: 3, h: 3 },
      door: { x: 65, y: 4 },
    };
    const walked = pathAcross(BUILDINGS[0]!, lot, [...BUILDINGS, lot], ROAD_STUBS[0]!.tiles);
    expect(walked?.some((tile) => tile.x === 65 && tile.y === 6)).toBe(true);
    expect(walked?.some((tile) => tile.x === 65 && tile.y === 5)).toBe(true);

    const [foundingAfter] = await rows<{ steps: number }>(
      db,
      "select steps from world_routes where from_id = 'house-01' and to_id = 'market'",
    );
    expect(foundingAfter!.steps).toBe(foundingSteps!.steps);

    const occupied = await occupiedPlots(db);
    const housePlan = planConstruction(await buildingViews(db), occupied, "house", ROAD_STUBS[0]!.tiles);
    expect(housePlan.ok).toBe(true);
    if (!housePlan.ok) {
      await db.close();
      return;
    }
    expect(housePlan.plan.plotId).toBe("plot-64-2");
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
        housePlan.plan.plotId,
        "house",
        housePlan.plan.buildingId,
        housePlan.plan.name,
        housePlan.plan.door.x,
        housePlan.plan.door.y,
        JSON.stringify(housePlan.plan.routes),
        "ai",
        decision!.id,
        citizen!.citizen_id,
      ],
    );
    expect(built.rows[0]!.r.ok).toBe(true);
    const site = await rows<{ x: number; y: number; status: string }>(
      db,
      "select x, y, status from world_buildings where id = $1",
      [housePlan.plan.buildingId],
    );
    expect(site[0]).toMatchObject({ x: 64, y: 2, status: "under_construction" });
    const newRoutes = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from world_routes where from_id = $1 or to_id = $1",
      [housePlan.plan.buildingId],
    );
    expect(newRoutes[0]!.n).toBeGreaterThan(0);

    const stillReserved = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from world_plots where y = 2 and served = false and status = 'reserved'",
    );
    expect(stillReserved[0]!.n).toBe(5);

    const [clockAfter] = await rows<{ speed: number; layout_version: string; tick_seq: number; grid_w?: number }>(
      db,
      "select speed::int as speed, layout_version, tick_seq::int from world_state",
    );
    expect(clockAfter!.speed).toBe(clockBefore!.speed);
    expect(clockAfter!.layout_version).toBe("genesis-v1.1");
    const buildings = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings where id = 'house-01'");
    expect(buildings[0]!.n).toBe(1);
    const needs = await rows<{ n: number }>(db, "select count(*)::int as n from town_needs");
    expect(needs[0]!.n).toBe(3);
    await db.query("select world_evaluate_town_needs($1::timestamptz, $2::bigint, $3::bigint)", [
      at(20).toISOString(),
      20 * 60,
      20,
    ]);
    const needRows = await rows<{ need_type: string; status: string }>(db, "select need_type, status from town_needs order by need_type");
    expect(needRows.map((row) => row.need_type)).toEqual(["food_shortage", "materials_shortage", "tools_shortage"]);

    const sample = [
      [65, 7],
      [29, 19],
      [0, 0],
      [64, 2],
    ] as const;
    for (const [x, y] of sample) {
      const [row] = await rows<{ ok: boolean }>(db, "select world_is_base_road($1,$2) as ok", [x, y]);
      expect(row!.ok).toBe(isRoad(x, y));
    }

    const stepped = await tick(db, at(25));
    expect(stepped.status).toBe("ok");
    await db.close();
  }, 120_000);

  it("records an AI road placement through world_place_road without inventing stock", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 8);
    await initialize(db, 60);
    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'proposed', $1, 'gemini', 'test') returning id",
      [citizen!.citizen_id],
    );
    const placed = await placeRoad(db, "east-y2-68", "ai", decision!.id, citizen!.citizen_id);
    expect(placed.ok).toBe(true);
    expect(placed.servedPlotIds).toEqual(["plot-68-2"]);
    const event = await rows<{ source: string; decision_id: string | null }>(
      db,
      "select source, decision_id from civilization_events where kind = 'road.placed'",
    );
    expect(event[0]).toMatchObject({ source: "ai", decision_id: decision!.id });
    const accepted = await rows<{ status: string }>(db, "select status from ai_decisions where id = $1", [decision!.id]);
    expect(accepted[0]!.status).toBe("accepted");
    expect(surveyedPlots(ROAD_STUBS[1]!.tiles).find((plot) => plot.id === "plot-68-2")?.served).toBe(true);
    expect(surveyedPlots(ROAD_STUBS[1]!.tiles).find((plot) => plot.id === "plot-64-2")?.served).toBe(false);
    await db.close();
  }, 60_000);
});
