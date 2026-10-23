import { describe, expect, it } from "vitest";
import { START, initialize, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("parks, bank visits, bonds, and closed punishment", () => {
  it("visits a park and the bank, progresses a bond, and refuses a new jail", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 4);
    await initialize(db, 60);
    const opened = await db.query<{ r: { ok: boolean; opened: string[] } }>("select world_open_civic_places() as r");
    expect(opened.rows[0]!.r.ok).toBe(true);
    expect(opened.rows[0]!.r.opened).toEqual(["park-01", "amusement-01", "chog-bank"]);

    const people = await rows<{ citizen_id: string }>(
      db,
      `select s.citizen_id
       from citizen_world_state s
       join citizens c on c.id = s.citizen_id
       where s.activity <> 'unavailable'
       order by c.token_id
       limit 2`,
    );
    const [first, second] = people;
    expect(first && second).toBeTruthy();
    const hour = 10 * 3600;
    const parkCheck = await db.query<{ reason: string | null }>(
      "select world_check_action($1, 'socialize', 'park-01', $2) as reason",
      [first!.citizen_id, hour],
    );
    expect(parkCheck.rows[0]!.reason).toBeNull();
    const bankCheck = await db.query<{ reason: string | null }>(
      "select world_check_action($1, 'visit', 'chog-bank', $2) as reason",
      [first!.citizen_id, hour],
    );
    expect(bankCheck.rows[0]!.reason).toBeNull();

    await db.query("select world_begin($1, 'socialize', 'park-01', $2, $3, 1, 'ai', true)", [
      first!.citizen_id,
      at(0).toISOString(),
      hour,
    ]);
    const [atPark] = await rows<{ activity: string; location_id: string }>(
      db,
      "select activity, location_id from citizen_world_state where citizen_id = $1",
      [first!.citizen_id],
    );
    expect(atPark).toMatchObject({ activity: "socializing", location_id: "park-01" });

    const before = await rows<{ food: number }>(db, "select world_stock('food') as food");
    await db.query("select world_begin($1, 'visit', 'chog-bank', $2, $3, 2, 'ai', true)", [
      second!.citizen_id,
      at(0).toISOString(),
      hour,
    ]);
    const after = await rows<{ food: number }>(db, "select world_stock('food') as food");
    expect(after[0]!.food).toBe(before[0]!.food);
    const [visit] = await rows<{ payload: { movedFunds?: boolean }; chain_status: string; tx_hash: string | null }>(
      db,
      "select payload, chain_status, tx_hash from civilization_events where kind = 'citizen.bank_visit' and actor_citizen_id = $1",
      [second!.citizen_id],
    );
    expect(visit!.payload.movedFunds).toBe(false);
    expect(visit!.chain_status).toBe("offchain");
    expect(visit!.tx_hash).toBeNull();

    await db.query("select world_begin($1, 'socialize', 'park-01', $2, $3, 3, 'simulation', true)", [
      second!.citizen_id,
      at(60).toISOString(),
      hour + 60,
    ]);
    const [met] = await rows<{ n: number }>(
      db,
      "select count(*)::int as n from civilization_events where kind = 'social.met'",
    );
    expect(met!.n).toBeGreaterThan(0);
    const [bond] = await rows<{ meetings: number; stage: string }>(
      db,
      "select meetings, stage from citizen_bonds",
    );
    expect(bond!.meetings).toBe(1);
    expect(bond!.stage).toBe("met");

    await db.query(
      `insert into citizen_personalities (
         citizen_id, sociability, curiosity, industriousness, cooperation, caution, planning, resourcefulness, preferred_activity, init_method
       ) values
       ($1, 70, 40, 40, 60, 20, 20, 20, 'socialize', 'deterministic'),
       ($2, 80, 40, 40, 55, 20, 20, 20, 'socialize', 'deterministic')
       on conflict (citizen_id) do update set sociability = excluded.sociability, cooperation = excluded.cooperation`,
      [first!.citizen_id, second!.citizen_id],
    );
    let stage = "met";
    for (let meeting = 0; meeting < 6; meeting += 1) {
      const actor = meeting % 2 === 0 ? first!.citizen_id : second!.citizen_id;
      const other = actor === first!.citizen_id ? second!.citizen_id : first!.citizen_id;
      const progressed = await db.query<{ r: { stage: string; dating: boolean; meetings: number } }>(
        "select world_progress_bond($1, $2) as r",
        [actor, other],
      );
      stage = progressed.rows[0]!.r.stage;
    }
    expect(stage).toBe("dating");
    const [stored] = await rows<{ stage: string; meetings: number }>(
      db,
      "select stage, meetings from citizen_bonds where citizen_low in ($1, $2)",
      [first!.citizen_id, second!.citizen_id],
    );
    expect(stored!.stage).toBe("dating");
    expect(stored!.meetings).toBeGreaterThanOrEqual(6);

    const jail = await db.query<{ r: { ok: boolean; reason?: string } }>(
      "select world_place_building('plot-70-8', 'jail', 'jail-99', 'Lockup', 70, 8, '[]'::jsonb, 'system', null, null) as r",
    );
    expect(jail.rows[0]!.r).toMatchObject({ ok: false, reason: "jail construction is disabled" });
    const detained = await db.query<{ r: { ok: boolean; reason?: string } }>("select world_detain_citizen($1, null) as r", [
      first!.citizen_id,
    ]);
    expect(detained.rows[0]!.r).toMatchObject({ ok: false, reason: "detention is disabled" });
    const fined = await db.query<{ r: { ok: boolean; reason?: string } }>("select world_levy_fine($1, null) as r", [
      first!.citizen_id,
    ]);
    expect(fined.rows[0]!.r).toMatchObject({ ok: false, reason: "punitive fines are disabled" });
    await db.close();
  }, 60_000);
});
