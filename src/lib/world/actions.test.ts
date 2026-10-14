import { describe, expect, it } from "vitest";
import { WORLD_ACTIONS, precheckAction, validateProposal } from "@/lib/world/actions";
import { toBuilding, toCitizen, type BuildingRow, type CitizenRow } from "@/lib/world/rows";
import { START, initialize, openWorldDb, rows, runFor, seedCitizens } from "@/lib/world/test-db";

describe("phase 4 action interface", () => {
  it("prechecks proposals with exactly the database rules", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 59);
    await initialize(db, 60, START);
    await runFor(db, START, 600, 10);

    const citizenRows = await rows<CitizenRow & { citizen_id: string }>(
      db,
      `select s.*, json_build_object('token_id', c.token_id, 'metadata_name', c.metadata_name, 'origin', c.origin) as citizens
       from citizen_world_state s join citizens c on c.id = s.citizen_id
       order by c.token_id limit 24`,
    );
    const buildings = (await rows<BuildingRow>(db, "select * from world_buildings")).map(toBuilding);
    const byId = new Map(buildings.map((b) => [b.id, b]));
    const store = byId.get("storehouse")!.stock;
    const hours = [3, 6, 12, 17.5, 19, 22].map((h) => Math.round(h * 3600));

    const verdicts = await rows<{ citizen_id: string; action: string; building: string; w: string; reason: string | null }>(
      db,
      `select c.citizen_id, a.action, b.id as building, h.w::text as w, world_check_action(c.citizen_id, a.action, b.id, h.w) as reason
       from citizen_world_state c
       cross join unnest($1::text[]) a(action)
       cross join world_buildings b
       cross join unnest($2::bigint[]) h(w)
       where c.citizen_id = any($3::uuid[])`,
      [[...WORLD_ACTIONS], hours, citizenRows.map((r) => r.citizen_id)],
    );
    expect(verdicts.length).toBe(24 * WORLD_ACTIONS.length * buildings.length * hours.length);
    expect(verdicts.filter((v) => v.reason === null).length).toBeGreaterThan(100);
    expect(new Set(verdicts.map((v) => v.reason)).size).toBeGreaterThan(8);

    const views = new Map(citizenRows.map((row) => [row.citizen_id, toCitizen(row)!]));
    let mismatches = 0;
    for (const verdict of verdicts) {
      const check = precheckAction(
        { action: verdict.action as (typeof WORLD_ACTIONS)[number], buildingId: verdict.building },
        views.get(verdict.citizen_id)!,
        byId.get(verdict.building),
        Number(verdict.w),
        { wood: store.wood ?? 0, stone: store.stone ?? 0 },
      );
      const expected = verdict.reason === null ? { ok: true } : { ok: false, reason: verdict.reason };
      if (JSON.stringify(check) !== JSON.stringify(expected)) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
    await db.close();
  }, 120_000);

  it("refuses malformed proposals and AI proposals without a decision record", () => {
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "market", source: "system" })).toEqual({ ok: true });
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "market", source: "ai" }).ok).toBe(false);
    expect(
      validateProposal({
        tokenId: "7",
        action: "work",
        buildingId: "market",
        source: "ai",
        decisionId: "11111111-1111-4111-8111-111111111111",
      }).ok,
    ).toBe(true);
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "market", source: "ai", decisionId: "d" }).ok).toBe(false);
    expect(validateProposal({ tokenId: "7; drop", action: "work", buildingId: "market", source: "system" }).ok).toBe(false);
    expect(validateProposal({ tokenId: "7", action: "transfer" as "work", buildingId: "market", source: "system" }).ok).toBe(false);
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "Market!", source: "system" }).ok).toBe(false);
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "market", source: "simulation" as "ai" }).ok).toBe(false);
  });
});
