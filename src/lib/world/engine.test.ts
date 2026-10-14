import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { genesisV1Layout, initializationLayout } from "@/lib/world/layout";
import { NFT, START, initialize, openWorldDb, rows, runFor, seedCitizens, tick } from "@/lib/world/test-db";

type EventRow = {
  seq: number;
  kind: string;
  category: string;
  source: string;
  actor_citizen_id: string | null;
  building_id: string | null;
  occurred_at: string;
  created_at: string;
  world_s: number | null;
  payload: Record<string, unknown>;
};

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("world initialization", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 59);
        await pre.query(
          `insert into civilization_events (kind, summary, dedupe_key, payload)
           values ('genesis_joined', 'Chog Genesis #7 verified in the ChogTreasury founding roster.', 'legacy:7', '{"tokenId":"7"}')`,
        );
      },
    });
    await db.query(
      `insert into citizens (chain_id, nft_contract, token_id, enrollment_status, origin, founding_membership_active)
       values (143, $1, 9001, 'pending', 'community', false), (143, $1, 9002, 'active', 'founding_treasury', false)`,
      [NFT],
    );
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it("keeps the existing history row and labels it as a system membership event", async () => {
    const [legacy] = await rows<EventRow>(db, "select * from civilization_events where dedupe_key = 'legacy:7'");
    expect(legacy!.source).toBe("system");
    expect(legacy!.category).toBe("membership");
    expect(Number(legacy!.seq)).toBeGreaterThan(0);
  });

  it("places only eligible existing citizens, once, and records one initialization event", async () => {
    const first = await initialize(db);
    expect(first.status).toBe("initialized");
    expect(first.citizens).toBe(59);

    const counts = async () =>
      (
        await rows<Record<string, number>>(
          db,
          `select
             (select count(*)::int from world_buildings) as buildings,
             (select count(*)::int from world_routes) as routes,
             (select count(*)::int from citizen_world_state) as states,
             (select count(*)::int from civilization_events) as events,
             (select count(*)::int from citizens) as citizens`,
        )
      )[0]!;
    const before = await counts();
    const second = await initialize(db);
    expect(second.status).toBe("already_initialized");
    expect(await counts()).toEqual(before);
    expect(before.citizens).toBe(61);

    const unplaced = await rows(
      db,
      `select c.token_id from citizens c left join citizen_world_state s on s.citizen_id = c.id
       where s.citizen_id is null order by c.token_id`,
    );
    expect(unplaced.map((row) => String((row as { token_id: string }).token_id))).toEqual(["9001", "9002"]);

    const events = await rows<EventRow>(db, "select * from civilization_events where kind = 'world.initialized'");
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("system");
    expect(new Date(events[0]!.occurred_at).toISOString()).toBe(START.toISOString());

    const perCitizen = await rows(db, "select * from civilization_events where source = 'simulation'");
    expect(perCitizen).toHaveLength(0);
  });

  it("stores the versioned layout with stable building positions", async () => {
    const layout = initializationLayout();
    const stored = await rows<{ id: string; x: number; y: number; door_x: number; door_y: number }>(
      db,
      "select id, x, y, door_x, door_y from world_buildings order by id",
    );
    for (const building of layout.buildings) {
      const row = stored.find((item) => item.id === building.id)!;
      expect([row.x, row.y, row.door_x, row.door_y]).toEqual([building.x, building.y, building.door_x, building.door_y]);
    }
    const mismatch = await db.query<{ r: { status: string } }>(
      "select world_initialize_at($1::jsonb, 143, $2, 60, $3) as r",
      [JSON.stringify({ ...layout, hash: "different" }), NFT, START.toISOString()],
    );
    expect(mismatch.rows[0]!.r.status).toBe("layout_mismatch");
  });

  it("never houses more citizens than a home holds", async () => {
    const over = await rows(
      db,
      `select b.id from world_buildings b
       where (select count(*) from citizen_world_state s where s.home_id = b.id) > coalesce(b.capacity, 0)
         and b.kind = 'house'`,
    );
    expect(over).toHaveLength(0);
  });
});

describe("simulation", () => {
  let db: PGlite;
  let end: Date;

  beforeAll(async () => {
    db = await openWorldDb();
    await seedCitizens(db, 59);
    await initialize(db, 60);
    const run = await runFor(db, START, 75 * 60, 10);
    const [state] = await rows<{ last_error: string | null }>(db, "select last_error from world_state");
    expect(state!.last_error).toBeNull();
    expect(run.failed).toBe(0);
    end = run.end;
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it("advances world time at the configured speed while real timestamps stay real", async () => {
    const [state] = await rows<{ last_tick_world_s: string; last_tick_at: string; tick_seq: string }>(
      db,
      "select * from world_state",
    );
    expect(new Date(state!.last_tick_at).toISOString()).toBe(end.toISOString());
    expect(Number(state!.last_tick_world_s)).toBe(5 * 3600 + 40 * 60 + 75 * 60 * 60);

    const events = await rows<EventRow>(db, "select * from civilization_events where source = 'simulation'");
    expect(events.length).toBeGreaterThan(100);
    for (const event of events) {
      const occurred = new Date(event.occurred_at).getTime();
      expect(occurred).toBeGreaterThanOrEqual(START.getTime());
      expect(occurred).toBeLessThanOrEqual(end.getTime());
      const expectedWorld = 5 * 3600 + 40 * 60 + ((occurred - START.getTime()) / 1000) * 60;
      expect(Math.abs(Number(event.world_s) - expectedWorld)).toBeLessThanOrEqual(60);
    }
  });

  it("completes only shifts that were started, after the full shift duration", async () => {
    const events = await rows<EventRow>(
      db,
      `select * from civilization_events
       where actor_citizen_id is not null and source = 'simulation'
       order by occurred_at, seq`,
    );
    const open = new Map<string, EventRow>();
    let completed = 0;
    for (const event of events) {
      const citizen = event.actor_citizen_id!;
      if (/^(work\.shift_started|resource\.(farming|gathering)_started|construction\.work_started)$/.test(event.kind)) {
        expect(open.has(citizen)).toBe(false);
        open.set(citizen, event);
      } else if (event.kind === "work.shift_completed") {
        const started = open.get(citizen);
        expect(started, `completion without start for ${citizen}`).toBeDefined();
        expect(started!.building_id).toBe(event.building_id);
        expect(Number(event.world_s) - Number(started!.world_s)).toBeGreaterThanOrEqual(4 * 3600);
        open.delete(citizen);
        completed += 1;
      } else if (event.kind !== "citizen.moved_in") {
        expect(open.has(citizen), `${event.kind} during an unfinished shift`).toBe(false);
      }
    }
    expect(completed).toBeGreaterThan(40);
  });

  it("only lets citizens work where they hold a matching job", async () => {
    const mismatched = await rows(
      db,
      `select e.kind, e.building_id, b.role, e.payload ->> 'role' as citizen_role
       from civilization_events e
       join world_buildings b on b.id = e.building_id
       where e.kind in ('work.shift_started', 'resource.farming_started', 'resource.gathering_started', 'construction.work_started')
         and b.role is distinct from e.payload ->> 'role'`,
    );
    expect(mismatched).toHaveLength(0);
    const unassigned = await rows(
      db,
      `select s.citizen_id from citizen_world_state s
       where s.activity in ('working', 'gathering', 'building') and s.location_id is distinct from s.work_id
         and s.role is not null and s.role <> 'builder'`,
    );
    expect(unassigned).toHaveLength(0);
  });

  it("keeps walking citizens on real routes and resting citizens at their own home", async () => {
    const walking = await rows<{ steps: number | null; duration: number }>(
      db,
      `select r.steps, s.world_ends_s - s.world_started_s as duration
       from citizen_world_state s
       left join world_routes r on r.from_id = s.origin_id and r.to_id = s.destination_id
       where s.activity = 'walking'`,
    );
    for (const row of walking) {
      expect(row.steps).not.toBeNull();
      expect(Number(row.duration)).toBe(Number(row.steps) * 30);
    }
    const wrongHome = await rows(
      db,
      `select citizen_id from citizen_world_state
       where activity in ('resting', 'sleeping')
         and location_id <> coalesce(home_id, 'commons-hall')
         and location_id <> 'commons-hall'`,
    );
    expect(wrongHome).toHaveLength(0);
  });

  it("keeps simulated stock within its bounds", async () => {
    const [store] = await rows<{ stock: Record<string, number> }>(
      db,
      "select stock from world_buildings where id = 'storehouse'",
    );
    for (const value of Object.values(store!.stock)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(400);
    }
  });

  it("does nothing when the same tick is retried", async () => {
    const before = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events");
    const versions = await rows(db, "select citizen_id, version from citizen_world_state order by citizen_id");
    const retry = await tick(db, end);
    expect(retry.status).toBe("too_soon");
    expect(await rows(db, "select count(*)::int as n from civilization_events")).toEqual(before);
    expect(await rows(db, "select citizen_id, version from citizen_world_state order by citizen_id")).toEqual(versions);
  });

  it("pauses the world across a long runner outage instead of replaying it", async () => {
    const [before] = await rows<{ last_tick_world_s: string; tick_seq: string }>(db, "select * from world_state");
    const eventsBefore = (await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events"))[0]!.n;
    const later = new Date(end.getTime() + 3 * 3600 * 1000);
    const result = await tick(db, later);
    expect(result.status).toBe("ok");
    expect(result.resumed).toBe(true);

    const [after] = await rows<{ last_tick_world_s: string; anchor_real: string }>(db, "select * from world_state");
    expect(Number(after!.last_tick_world_s)).toBe(Number(before!.last_tick_world_s));
    const eventsAfter = (await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events"))[0]!.n;
    expect(eventsAfter - eventsBefore).toBeLessThanOrEqual(3);
    const resumed = await rows<EventRow>(db, "select * from civilization_events where kind = 'world.resumed'");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.source).toBe("system");

    const stale = await rows(db, "select citizen_id from citizen_world_state where ends_at < $1", [later.toISOString()]);
    expect(stale).toHaveLength(0);
    end = (await runFor(db, later, 60, 10)).end;
  });

  it("records no success event for a transition that fails, and keeps the world running", async () => {
    const cutoff = end;
    const [{ walking, events: eventsBefore }] = await rows<{ walking: number; events: number }>(
      db,
      `select
         (select count(*)::int from citizen_world_state where activity = 'walking' and destination_id = 'market') as walking,
         (select count(*)::int from civilization_events) as events`,
    );
    await db.exec("delete from world_routes where to_id = 'market'");
    const run = await runFor(db, end, 20 * 60, 10);
    end = run.end;

    const [{ visits, events: eventsAfter }] = await rows<{ visits: number; events: number }>(
      db,
      `select
         (select count(*)::int from civilization_events
          where kind = 'citizen.market_visit' and occurred_at > $1 and (payload ->> 'arrived')::boolean) as visits,
         (select count(*)::int from civilization_events) as events`,
      [cutoff.toISOString()],
    );
    expect(visits).toBeLessThanOrEqual(walking);
    expect(run.failed).toBeGreaterThan(0);
    const [state] = await rows<{ last_error: string | null }>(db, "select last_error from world_state");
    expect(state!.last_error).toContain("no road");
    expect(eventsAfter).toBeGreaterThan(eventsBefore);

    for (const route of initializationLayout().routes.filter((item) => item.to === "market")) {
      await db.query("insert into world_routes (from_id, to_id, steps) values ($1, $2, $3)", [
        route.from,
        route.to,
        route.steps,
      ]);
    }
  }, 60_000);
});

describe("failed transitions", () => {
  it("rolls back a failing step without writing its event and retries it later", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 3);
    await initialize(db, 60);
    await db.exec("delete from world_routes");
    const result = await tick(db, at(100));
    expect(Number(result.failed)).toBeGreaterThan(0);
    expect(Number(result.processed)).toBe(0);
    const events = await rows(db, "select * from civilization_events where source = 'simulation'");
    expect(events).toHaveLength(0);
    const [state] = await rows<{ last_error: string }>(db, "select last_error from world_state");
    expect(state!.last_error).toContain("no road");
    const pending = await rows<{ ends_at: string; activity: string }>(db, "select ends_at, activity from citizen_world_state");
    for (const row of pending) {
      expect(row.activity).toBe("sleeping");
      expect(new Date(row.ends_at).getTime()).toBeGreaterThan(at(100).getTime());
    }
    await db.close();
  }, 60_000);
});

describe("validation and the Phase 4 intent seam", () => {
  let db: PGlite;
  let citizen: { citizen_id: string; work_id: string; role: string; home_id: string | null };

  beforeAll(async () => {
    db = await openWorldDb();
    await seedCitizens(db, 12);
    await initialize(db, 60);
    [citizen] = await rows(
      db,
      "select citizen_id, work_id, role, home_id from citizen_world_state where role = 'crafter' limit 1",
    );
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  const check = async (action: string, building: string, world: number) =>
    (
      await rows<{ r: string | null }>(db, "select world_check_action($1, $2, $3, $4) as r", [
        citizen.citizen_id,
        action,
        building,
        world,
      ])
    )[0]!.r;

  it("refuses work outside an assignment, outside hours, or without materials", async () => {
    const morning = 9 * 3600;
    expect(await check("work", citizen.work_id, morning)).toBeNull();
    expect(await check("work", "north-farm", morning)).toBe("citizen is not assigned to this building");
    expect(await check("work", citizen.work_id, 21 * 3600)).toBe("outside working hours");
    expect(await check("shop", "market", 21 * 3600)).toBe("the market is closed");
    expect(await check("rest", "house-15", morning)).not.toBeNull();
    await db.exec(`update world_buildings set stock = jsonb_set(stock, '{wood}', '0') where id = 'storehouse'`);
    expect(await check("work", citizen.work_id, morning)).toBe("not enough wood in the Storehouse");
    await db.exec(`update world_buildings set stock = jsonb_set(stock, '{wood}', '60') where id = 'storehouse'`);
  });

  it("rejects an invalid intent with a reason and applies a valid one with its source", async () => {
    const [decision] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('test', 'queued', $1, 'gemini', 'gemini-3.8-flash') returning id",
      [citizen.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'work', 'north-farm', 'ai', $2)",
      [citizen.citizen_id, decision!.id],
    );
    await runFor(db, START, 3 * 60, 10);
    const [rejected] = await rows<{ status: string; reason: string }>(db, "select status, reason from world_intents");
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.reason).toBe("citizen is not assigned to this building");

    const [state] = await rows<{ ends_at: string; activity: string }>(
      db,
      "select ends_at, activity from citizen_world_state where citizen_id = $1",
      [citizen.citizen_id],
    );
    const [second] = await rows<{ id: string }>(
      db,
      "insert into ai_decisions (purpose, status, citizen_id, provider, model) values ('test', 'queued', $1, 'gemini', 'gemini-3.8-flash') returning id",
      [citizen.citizen_id],
    );
    await db.query(
      "insert into world_intents (citizen_id, action, building_id, source, decision_id) values ($1, 'socialize', 'commons-square', 'ai', $2)",
      [citizen.citizen_id, second!.id],
    );
    expect(state!.ends_at).toBeTruthy();
    for (let seconds = 3 * 60 + 10; seconds < 20 * 60; seconds += 10) {
      await tick(db, at(seconds));
      const [intent] = await rows<{ status: string }>(db, "select status from world_intents where action = 'socialize'");
      if (intent!.status !== "pending") {
        break;
      }
    }
    const [accepted] = await rows<{ status: string; reason: string | null }>(
      db,
      "select status, reason from world_intents where action = 'socialize'",
    );
    expect(accepted).toEqual({ status: "accepted", reason: null });
    const [after] = await rows<{ decision_source: string; purpose: string | null; activity: string }>(
      db,
      "select decision_source, purpose, activity from citizen_world_state where citizen_id = $1",
      [citizen.citizen_id],
    );
    expect(after!.decision_source).toBe("ai");
    expect(after!.purpose ?? after!.activity).toMatch(/socialize|socializing/);
  });
});

describe("population changes", () => {
  it("marks a citizen unavailable when it stops being eligible and adds newly enrolled citizens", async () => {
    const db = await openWorldDb();
    await seedCitizens(db, 5);
    await initialize(db, 60);
    await db.query("update citizens set founding_membership_active = false where token_id = 7");
    await db.query(
      `insert into citizens (chain_id, nft_contract, token_id, enrollment_status, origin, founding_membership_active)
       values (143, $1, 4242, 'active', 'community', false)`,
      [NFT],
    );
    await tick(db, at(10));
    const states = await rows<{ token_id: string; activity: string; location_id: string | null }>(
      db,
      `select c.token_id::text, s.activity, s.location_id from citizen_world_state s join citizens c on c.id = s.citizen_id
       where c.token_id in (7, 4242) order by c.token_id`,
    );
    expect(states).toEqual([
      { token_id: "7", activity: "unavailable", location_id: null },
      { token_id: "4242", activity: "idle", location_id: "commons-square" },
    ]);
    const kinds = await rows<{ kind: string; source: string }>(
      db,
      "select kind, source from civilization_events where kind like 'citizen.%' order by seq",
    );
    expect(kinds).toEqual([
      { kind: "citizen.unavailable", source: "system" },
      { kind: "citizen.joined_world", source: "system" },
    ]);
    const second = await tick(db, at(20));
    expect(second.joined).toBe(0);
    await db.close();
  }, 60_000);
});

describe("map expansion", () => {
  it("upgrades genesis-v1 to genesis-v1.1 without moving the town or duplicating history", async () => {
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 59);
      },
    });
    const founded = await db.query<{ r: Record<string, unknown> }>(
      "select world_initialize_at($1::jsonb, 143, $2, 60, $3) as r",
      [JSON.stringify(genesisV1Layout()), NFT, START.toISOString()],
    );
    expect(founded.rows[0]!.r.status).toBe("initialized");
    const before = (
      await rows<{
        buildings: number;
        routes: number;
        citizens: number;
        events: number;
        house_x: number;
        speed: number;
        tick: number;
      }>(
        db,
        `select
           (select count(*)::int from world_buildings) as buildings,
           (select count(*)::int from world_routes) as routes,
           (select count(*)::int from citizen_world_state) as citizens,
           (select count(*)::int from civilization_events) as events,
           (select x from world_buildings where id = 'house-01') as house_x,
           (select speed::int from world_state) as speed,
           (select tick_seq::int from world_state) as tick`,
      )
    )[0]!;
    expect(before.buildings).toBe(25);
    expect(before.citizens).toBe(59);
    expect(before.house_x).toBe(2);

    const first = await db.query<{ r: Record<string, unknown> }>(
      "select world_expand_layout_at($1::jsonb, $2) as r",
      [JSON.stringify(initializationLayout()), at(30).toISOString()],
    );
    expect(first.rows[0]!.r.status).toBe("expanded");
    expect(first.rows[0]!.r.fromVersion).toBe("genesis-v1");
    expect(first.rows[0]!.r.gridW).toBe(120);
    expect(first.rows[0]!.r.gridH).toBe(80);

    const after = (
      await rows<{
        buildings: number;
        citizens: number;
        house_x: number;
        house_y: number;
        version: string;
        grid_w: number;
        grid_h: number;
        regions: number;
        speed: number;
        events: number;
      }>(
        db,
        `select
           (select count(*)::int from world_buildings) as buildings,
           (select count(*)::int from citizen_world_state) as citizens,
           (select x from world_buildings where id = 'house-01') as house_x,
           (select y from world_buildings where id = 'house-01') as house_y,
           (select layout_version from world_state) as version,
           (select grid_w from world_state) as grid_w,
           (select grid_h from world_state) as grid_h,
           (select count(*)::int from world_regions) as regions,
           (select speed::int from world_state) as speed,
           (select count(*)::int from civilization_events) as events`,
      )
    )[0]!;
    expect(after.buildings).toBe(before.buildings);
    expect(after.citizens).toBe(59);
    expect(after.house_x).toBe(2);
    expect(after.house_y).toBe(4);
    expect(after.version).toBe("genesis-v1.1");
    expect(after.grid_w).toBe(120);
    expect(after.grid_h).toBe(80);
    expect(after.regions).toBe(4);
    expect(after.speed).toBe(before.speed);
    expect(after.events).toBe(before.events + 1);

    const expanded = await rows<{ kind: string; source: string }>(
      db,
      "select kind, source from civilization_events where kind = 'world.expanded'",
    );
    expect(expanded).toEqual([{ kind: "world.expanded", source: "system" }]);

    const second = await db.query<{ r: Record<string, unknown> }>(
      "select world_expand_layout_at($1::jsonb, $2) as r",
      [JSON.stringify(initializationLayout()), at(40).toISOString()],
    );
    expect(second.rows[0]!.r.status).toBe("already_expanded");
    const eventsAgain = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events where kind = 'world.expanded'");
    expect(eventsAgain[0]!.n).toBe(1);
    const regionsAgain = await rows<{ n: number }>(db, "select count(*)::int as n from world_regions");
    expect(regionsAgain[0]!.n).toBe(4);

    const stepped = await tick(db, at(45));
    expect(stepped.status).toBe("ok");
    expect(Number(stepped.failed ?? 0)).toBe(0);
    await db.close();
  }, 60_000);
});

describe("database access", () => {
  it("gives browsers nothing and gives the server read access plus the runner functions only", async () => {
    const db = await openWorldDb();
    const privilege = async (sql: string) => (await rows<{ ok: boolean }>(db, `select ${sql} as ok`))[0]!.ok;
    expect(await privilege("has_function_privilege('service_role', 'world_place_building(text,text,text,text,integer,integer,jsonb,text,uuid,uuid)', 'execute')")).toBe(true);
    expect(await privilege("has_function_privilege('anon', 'world_place_building(text,text,text,text,integer,integer,jsonb,text,uuid,uuid)', 'execute')")).toBe(false);
    expect(await privilege("has_function_privilege('service_role', 'world_ensure_minds()', 'execute')")).toBe(true);
    for (const table of ["world_buildings", "world_state", "citizen_world_state", "world_routes", "world_intents", "world_regions", "world_plots"]) {
      for (const role of ["anon", "authenticated"]) {
        expect(await privilege(`has_table_privilege('${role}', '${table}', 'select')`)).toBe(false);
      }
      expect(await privilege(`has_table_privilege('service_role', '${table}', 'select')`)).toBe(true);
      expect(await privilege(`has_table_privilege('service_role', '${table}', 'update')`)).toBe(false);
      expect(await privilege(`has_table_privilege('service_role', '${table}', 'delete')`)).toBe(false);
    }
    for (const role of ["anon", "authenticated"]) {
      expect(await privilege(`has_function_privilege('${role}', 'world_tick()', 'execute')`)).toBe(false);
      expect(await privilege(`has_function_privilege('${role}', 'world_set_speed(numeric)', 'execute')`)).toBe(false);
      expect(await privilege(`has_function_privilege('${role}', 'world_cron_status()', 'execute')`)).toBe(false);
      expect(await privilege(`has_function_privilege('${role}', 'world_initialize(jsonb,integer,text,numeric)', 'execute')`)).toBe(false);
      expect(await privilege(`has_function_privilege('${role}', 'world_expand_layout(jsonb)', 'execute')`)).toBe(false);
    }
    expect(await privilege("has_function_privilege('service_role', 'world_tick()', 'execute')")).toBe(true);
    expect(await privilege("has_function_privilege('service_role', 'world_cron_status()', 'execute')")).toBe(true);
    expect(await privilege("has_function_privilege('service_role', 'world_expand_layout(jsonb)', 'execute')")).toBe(true);
    expect(await privilege("has_function_privilege('service_role', 'world_expand_layout_at(jsonb,timestamptz)', 'execute')")).toBe(false);
    expect(await privilege("has_table_privilege('service_role', 'world_intents', 'insert')")).toBe(true);
    expect(await privilege("has_table_privilege('service_role', 'world_state', 'insert')")).toBe(false);
    expect(await privilege("has_function_privilege('service_role', 'world_tick_at(timestamptz)', 'execute')")).toBe(false);
    expect(
      await privilege("has_function_privilege('service_role', 'world_begin(uuid,text,text,timestamptz,bigint,bigint,text,boolean)', 'execute')"),
    ).toBe(false);
    await db.close();
  }, 60_000);
});
