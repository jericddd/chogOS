import { describe, expect, it } from "vitest";
import { FOOD_SHORTAGE_RECOVER, TOOLS_SHORTAGE_RECOVER } from "@/lib/world/needs";
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
}

describe("phase 5c town needs", () => {
  it("detects shortages from storehouse stock, uses hysteresis, and does not duplicate events", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);

    const seeded = await rows<{ need_type: string; status: string }>(db, "select need_type, status from town_needs order by need_type");
    expect(seeded.map((row) => row.need_type)).toEqual(["food_shortage", "materials_shortage", "tools_shortage"]);
    expect(seeded.every((row) => row.status === "inactive")).toBe(true);

    await setStock(db, { food: 12, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 10, 10);
    const first = await rows<{ need_type: string; status: string; evidence: { food: number } }>(
      db,
      "select need_type, status, evidence from town_needs where need_type = 'food_shortage'",
    );
    expect(first[0]).toMatchObject({ status: "active" });
    expect(first[0]!.evidence.food).toBe(12);

    await evaluate(db, 15, 11);
    await setStock(db, { food: 8, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 20, 12);
    const detected = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'town.need_detected' and payload->>'needType' = 'food_shortage'",
    );
    expect(detected[0]!.n).toBe(1);
    const hashed = await rows<{
      source: string;
      category: string;
      seq: number;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>(
      db,
      "select source, category, seq, dedupe_key, payload from civilization_events where kind = 'town.need_detected' and payload->>'needType' = 'food_shortage'",
    );
    expect(hashed[0]!.source).toBe("system");
    expect(hashed[0]!.category).toBe("world");
    expect(Number(hashed[0]!.seq)).toBeGreaterThan(0);
    expect(hashed[0]!.dedupe_key).toMatch(/^system:town\.need_detected:food_shortage:/);
    expect(hashed[0]!.payload.evidence).toMatchObject({ food: 12 });

    await setStock(db, { food: 50, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 30, 13);
    const mid = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'food_shortage'");
    expect(mid[0]!.status).toBe("active");

    await setStock(db, { food: FOOD_SHORTAGE_RECOVER, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 40, 14);
    const recovered = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'food_shortage'");
    expect(recovered[0]!.status).toBe("resolved");
    const resolvedEvents = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'town.need_resolved' and payload->>'needType' = 'food_shortage'",
    );
    expect(resolvedEvents[0]!.n).toBe(1);

    await setStock(db, { food: 50, tools: 20, wood: 60, stone: 40 });
    await evaluate(db, 50, 15);
    const bounce = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'food_shortage'");
    expect(bounce[0]!.status).toBe("resolved");

    await setStock(db, { tools: 1, food: FOOD_SHORTAGE_RECOVER, wood: 60, stone: 40 });
    await evaluate(db, 60, 16);
    const tools = await rows<{ status: string; evidence: { tools: number } }>(
      db,
      "select status, evidence from town_needs where need_type = 'tools_shortage'",
    );
    expect(tools[0]).toMatchObject({ status: "active" });
    expect(tools[0]!.evidence.tools).toBe(1);
    await setStock(db, { tools: TOOLS_SHORTAGE_RECOVER, food: FOOD_SHORTAGE_RECOVER, wood: 60, stone: 40 });
    await evaluate(db, 70, 17);
    const toolsOff = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'tools_shortage'");
    expect(toolsOff[0]!.status).toBe("resolved");

    await setStock(db, { wood: 1, stone: 0, food: 80, tools: 20 });
    await evaluate(db, 80, 18);
    const materials = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'materials_shortage'");
    expect(materials[0]!.status).toBe("active");

    await db.close();
  }, 60_000);

  it("does not resolve a shortage because of a proposal, intent, or completed farm, and a tick still evaluates", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 16);
    await initialize(db, 60);
    await setStock(db, { food: 10, tools: 20, wood: 60, stone: 40 });
    await tick(db, at(10));
    const afterTick = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'food_shortage'");
    expect(afterTick[0]!.status).toBe("active");

    const [citizen] = await rows<{ citizen_id: string }>(
      db,
      "select citizen_id from citizen_world_state where activity <> 'unavailable' order by citizen_id limit 1",
    );
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('citizen_turn', 'queued', $1, 'gemini', 'gemini-3.5-flash-lite') returning id",
      [citizen!.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', 'north-farm', 'ai', $2)",
      [citizen!.citizen_id, decision!.id],
    );
    const linked = await db.query<{ r: Record<string, unknown> }>("select world_link_town_need($1, $2) as r", [
      "food_shortage",
      decision!.id,
    ]);
    expect(linked.rows[0]!.r.ok).toBe(true);
    const still = await rows<{ status: string; last_decision_id: string | null; evidence: { food: number } }>(
      db,
      "select status, last_decision_id, evidence from town_needs where need_type = 'food_shortage'",
    );
    expect(still[0]!.status).toBe("active");
    expect(still[0]!.last_decision_id).toBe(decision!.id);
    expect(still[0]!.evidence.food).toBe(10);

    const [foodBefore] = await rows<{ food: number }>(
      db,
      "select (stock->>'food')::int as food from world_buildings where id = 'storehouse'",
    );
    await db.query(
      `update world_buildings
       set status = 'active', construction_progress = 100, role = 'farmer', job_slots = 4, batch_shifts = 3
       where id = 'north-farm'`,
    );
    await evaluate(db, 20, 30);
    const [foodAfter] = await rows<{ food: number }>(
      db,
      "select (stock->>'food')::int as food from world_buildings where id = 'storehouse'",
    );
    expect(foodAfter!.food).toBe(foodBefore!.food);
    const afterFarm = await rows<{ status: string }>(db, "select status from town_needs where need_type = 'food_shortage'");
    expect(afterFarm[0]!.status).toBe("active");

    const y2 = await rows<{ served: boolean; status: string }>(db, "select served, status from world_plots where y = 2");
    expect(y2.every((plot) => plot.served === false)).toBe(true);
    const buildings = await rows<{ n: number }>(db, "select count(*)::int as n from world_buildings");
    expect(buildings[0]!.n).toBe(25);

    await db.close();
  }, 60_000);
});
