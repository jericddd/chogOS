import { describe, expect, it } from "vitest";
import { planConstruction } from "@/lib/world/placement";
import { toBuilding, type BuildingRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, runFor, seedCitizens, tick } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("parks, the bank door, and civic records", () => {
  it("opens leisure and the bank, then laws, a fine, the jail, and a mark that can fade", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 8);
    await initialize(db, 60);
    const opened = await db.query<{ r: { ok: boolean; opened: string[] } }>("select world_open_civic_places() as r");
    expect(opened.rows[0]!.r.ok).toBe(true);
    expect(opened.rows[0]!.r.opened).toEqual(["park-01", "amusement-01", "chog-bank"]);
    const again = await db.query<{ r: { opened: string[] } }>("select world_open_civic_places() as r");
    expect(again.rows[0]!.r.opened).toEqual([]);

    const places = await rows<{ id: string; kind: string; name: string; status: string; role: string | null; job_slots: number | null }>(
      db,
      "select id, kind, name, status, role, job_slots from world_buildings where kind in ('park', 'amusement', 'bank', 'jail') order by id",
    );
    expect(places).toEqual([
      { id: "amusement-01", kind: "amusement", name: "Lantern Green", status: "active", role: null, job_slots: null },
      { id: "chog-bank", kind: "bank", name: "ChogBank", status: "active", role: null, job_slots: null },
      { id: "park-01", kind: "park", name: "Willow Park", status: "active", role: null, job_slots: null },
    ]);
    const laws = await rows<{ n: number }>(db, "select count(*)::int as n from world_laws");
    expect(laws[0]!.n).toBe(0);

    const [citizen] = await rows<{ citizen_id: string; token_id: string; home_id: string | null }>(
      db,
      `select s.citizen_id, c.token_id::text, s.home_id
       from citizen_world_state s
       join citizens c on c.id = s.citizen_id
       where s.activity <> 'unavailable'
       order by c.token_id
       limit 1`,
    );
    const [other] = await rows<{ citizen_id: string; home_id: string }>(
      db,
      `select s.citizen_id, s.home_id
       from citizen_world_state s
       join citizens c on c.id = s.citizen_id
       where s.activity <> 'unavailable' and s.citizen_id <> $1 and s.home_id is not null
       order by c.token_id
       limit 1`,
      [citizen!.citizen_id],
    );
    const [house] = await rows<{ id: string }>(
      db,
      "select id from world_buildings where kind = 'house' and id is distinct from $1 order by id limit 1",
      [other!.home_id],
    );

    const views = (await rows<BuildingRow>(db, "select * from world_buildings")).map(toBuilding);
    const occupied = new Set(
      (await rows<{ id: string; status: string }>(db, "select id, status from world_plots"))
        .filter((plot) => plot.status !== "vacant")
        .map((plot) => plot.id),
    );
    const jailPlan = planConstruction(views, occupied, "jail");
    expect(jailPlan.ok).toBe(true);
    if (!jailPlan.ok) {
      await db.close();
      return;
    }
    const refusedJail = await db.query<{ r: { ok: boolean; reason?: string } }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,'system',null,null) as r",
      [
        jailPlan.plan.plotId,
        "jail",
        jailPlan.plan.buildingId,
        jailPlan.plan.name,
        jailPlan.plan.door.x,
        jailPlan.plan.door.y,
        JSON.stringify(jailPlan.plan.routes),
      ],
    );
    expect(refusedJail.rows[0]!.r).toMatchObject({ ok: false, reason: "a jail waits until a law is proclaimed" });

    const early = await db.query<{ r: { ok: boolean; reason?: string } }>(
      "select world_proclaim_law('ration_fine', 'The storehouse is short and a breach is stored.', $1, null) as r",
      [citizen!.citizen_id],
    );
    expect(early.rows[0]!.r).toMatchObject({ ok: false, reason: "the record does not support a statute yet" });

    const before = await rows<{ food: number }>(db, "select world_stock('food') as food");
    await db.query("select world_begin($1, 'visit', 'chog-bank', $2, $3, 1, 'simulation', true)", [
      citizen!.citizen_id,
      at(0).toISOString(),
      10 * 3600,
    ]);
    const afterVisit = await rows<{ food: number }>(db, "select world_stock('food') as food");
    expect(afterVisit[0]!.food).toBe(before[0]!.food);
    const visit = await rows<{ payload: { movedFunds?: boolean } }>(
      db,
      "select payload from civilization_events where kind = 'citizen.bank_visit' and actor_citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(visit[0]!.payload.movedFunds).toBe(false);

    await db.query("delete from town_needs where need_type = 'food_shortage'");
    await db.query("select world_store('food', -400, 1)");
    await db.query("select world_store('food', 12, 1)");
    const proclaimed = await db.query<{ r: { ok: boolean; code?: string } }>(
      "select world_proclaim_law('ration_fine', 'Food has stayed under forty.', $1, null) as r",
      [citizen!.citizen_id],
    );
    expect(proclaimed.rows[0]!.r.ok).toBe(true);
    const duplicate = await db.query<{ r: { ok: boolean; reason?: string } }>(
      "select world_proclaim_law('ration_fine', 'Food has stayed under forty.', $1, null) as r",
      [citizen!.citizen_id],
    );
    expect(duplicate.rows[0]!.r.reason).toBe("that law is already stored");

    await db.query("select world_store('food', -400, 1)");
    await db.query("select world_record_breach($1, 'storehouse', 'storehouse_skim', 36000, 2, true)", [citizen!.citizen_id]);
    const unpaid = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'civic.fine_unpaid' and actor_citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(unpaid[0]!.n).toBe(1);
    const notice = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'civic.notice' and building_id = 'commons-square'",
    );
    expect(notice[0]!.n).toBeGreaterThan(0);

    const watchBefore = await db.query<{ reason: string | null }>(
      "select world_check_action($1, 'watch', 'storehouse', $2) as reason",
      [other!.citizen_id, 10 * 3600],
    );
    expect(watchBefore.rows[0]!.reason).toBe("no repeated offense is stored");
    await db.query("select world_record_breach($1, 'market', 'unsanctioned_sale', 36000, 3, true)", [citizen!.citizen_id]);
    const hostile = await db.query<{ marked: boolean }>("select world_is_hostile($1, 40000) as marked", [citizen!.citizen_id]);
    expect(hostile.rows[0]!.marked).toBe(true);
    const watchAfter = await db.query<{ reason: string | null }>(
      "select world_check_action($1, 'watch', 'storehouse', $2) as reason",
      [other!.citizen_id, 10 * 3600],
    );
    expect(watchAfter.rows[0]!.reason).toBeNull();

    const placed = await db.query<{ r: { ok: boolean; reason?: string } }>(
      "select world_place_building($1,$2,$3,$4,$5,$6,$7::jsonb,'system',null,null) as r",
      [
        jailPlan.plan.plotId,
        "jail",
        jailPlan.plan.buildingId,
        jailPlan.plan.name,
        jailPlan.plan.door.x,
        jailPlan.plan.door.y,
        JSON.stringify(jailPlan.plan.routes),
      ],
    );
    expect(placed.rows[0]!.r.ok).toBe(true);
    await db.query(
      "update world_buildings set status = 'active', construction_progress = 100, completed_at = now() where id = $1",
      [jailPlan.plan.buildingId],
    );
    await db.query("update citizen_world_state set role = null, work_id = null where role = 'builder' and work_id = $1", [
      jailPlan.plan.buildingId,
    ]);
    const [farm] = await rows<{ id: string }>(db, "select id from world_buildings where kind = 'farm' and status = 'active' order by id limit 1");
    await db.query("update citizen_world_state set role = 'farmer', work_id = $2 where citizen_id = $1", [
      citizen!.citizen_id,
      farm!.id,
    ]);
    const sentenced = await db.query<{ r: { ok: boolean; reason?: string; jailId?: string } }>(
      "select world_detain_citizen($1, null) as r",
      [citizen!.citizen_id],
    );
    expect(sentenced.rows[0]!.r.ok).toBe(true);
    const amended = await db.query<{ r: { ok: boolean; status?: string; reason?: string } }>(
      "select world_amend_law('ration_fine', 'Detained farmers left the fields while food was under forty.', $1, null, false) as r",
      [other!.citizen_id],
    );
    expect(amended.rows[0]!.r).toMatchObject({ ok: true, status: "amended" });

    const [sentence] = await rows<{ ends_world_s: string }>(
      db,
      "select ends_world_s::text from world_sentences where citizen_id = $1 and released_at is null",
      [citizen!.citizen_id],
    );
    const ends = Number(sentence!.ends_world_s);
    await db.query("select world_release_due($1, $2)", [citizen!.citizen_id, ends]);
    const still = await db.query<{ marked: boolean }>("select world_is_hostile($1, $2) as marked", [
      citizen!.citizen_id,
      ends + 86_400,
    ]);
    expect(still.rows[0]!.marked).toBe(true);
    const faded = await db.query<{ marked: boolean }>("select world_is_hostile($1, $2) as marked", [
      citizen!.citizen_id,
      ends + 3 * 86_400,
    ]);
    expect(faded.rows[0]!.marked).toBe(false);
    const released = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'civic.released' and actor_citizen_id = $1",
      [citizen!.citizen_id],
    );
    expect(released[0]!.n).toBe(1);

    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source) values ($1, 'rest', $2, 'system')",
      [other!.citizen_id, house!.id],
    );
    await db.query("select * from world_choose_action($1, $2)", [other!.citizen_id, 12 * 3600]);
    const door = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'civic.breach' and actor_citizen_id = $1 and payload ->> 'act' = 'wrong_door'",
      [other!.citizen_id],
    );
    expect(door[0]!.n).toBe(1);

    const snapshot = await db.query<{ r: { bankId: string; breachTokens: string[]; laws: { code: string; status: string }[] } }>(
      "select world_civic_snapshot() as r",
    );
    expect(snapshot.rows[0]!.r.bankId).toBe("chog-bank");
    expect(snapshot.rows[0]!.r.breachTokens).toContain(citizen!.token_id);
    expect(snapshot.rows[0]!.r.laws).toEqual([{ code: "ration_fine", status: "amended" }]);

    const ran = await runFor(db, START, 90, 5);
    expect(ran.failed).toBe(0);
    const [state] = await rows<{ last_error: string | null }>(db, "select last_error from world_state");
    expect(state!.last_error).toBeNull();
    const stepped = await tick(db, at(120));
    expect(Number(stepped.failed ?? 0)).toBe(0);

    const privilege = async (sql: string) => (await rows<{ ok: boolean }>(db, `select ${sql} as ok`))[0]!.ok;
    expect(await privilege("has_table_privilege('anon', 'world_laws', 'select')")).toBe(false);
    expect(await privilege("has_table_privilege('service_role', 'world_laws', 'select')")).toBe(true);
    expect(await privilege("has_table_privilege('service_role', 'world_laws', 'update')")).toBe(false);
    expect(await privilege("has_function_privilege('service_role', 'world_civic_snapshot()', 'execute')")).toBe(true);
    expect(await privilege("has_function_privilege('anon', 'world_proclaim_law(text,text,uuid,uuid)', 'execute')")).toBe(false);
    expect(await privilege("has_function_privilege('service_role', 'world_record_breach(uuid,text,text,bigint,bigint,boolean)', 'execute')")).toBe(false);
    await db.close();
  }, 90_000);
});
