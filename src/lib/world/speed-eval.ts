import type { PGlite } from "@electric-sql/pglite";
import { START, initialize, openWorldDb, rows, runFor, seedCitizens, tick } from "@/lib/world/test-db";

export type DemoWindow = {
  speed: number;
  label: string;
  startWorldHour: number;
  realSeconds: number;
  citizensChangedFirstMinute: number;
  citizensWithTwoTransitions: number;
  transitions: number;
  events: number;
  eventsPerMinute: number;
  eventKinds: number;
  averageWalking: number;
  peakWalking: number;
  worldHoursElapsed: number;
  failed: number;
};

const WORLD_START = 5 * 3600 + 40 * 60;

async function versions(db: PGlite): Promise<Map<string, number>> {
  const list = await rows<{ citizen_id: string; version: string }>(db, "select citizen_id, version from citizen_world_state");
  return new Map(list.map((row) => [row.citizen_id, Number(row.version)]));
}

/**
 * Initializes a fresh world with the founding population, advances it to the
 * requested world hour on the real engine, then watches one demo window.
 */
export async function measureWindow(
  speed: number,
  startWorldHour: number,
  label: string,
  realSeconds = 300,
  population = 59,
): Promise<DemoWindow> {
  const db = await openWorldDb();
  await seedCitizens(db, population);
  await initialize(db, speed);
  const lead = Math.max(0, ((startWorldHour * 3600 - WORLD_START) / speed) | 0);
  const prelude = await runFor(db, START, Math.floor(lead / 10) * 10, 10);
  let at = lead > 0 ? prelude.end : START;

  const base = await versions(db);
  const [{ n: eventsBase }] = await rows<{ n: number }>(db, "select count(*)::int as n from civilization_events");
  const [{ w: worldBase }] = await rows<{ w: string }>(db, "select last_tick_world_s as w from world_state");
  let changedFirstMinute = 0;
  let walkingSum = 0;
  let peakWalking = 0;
  let samples = 0;
  let failed = 0;

  for (let elapsed = 5; elapsed <= realSeconds; elapsed += 5) {
    at = new Date(at.getTime() + 5000);
    const result = await tick(db, at);
    failed += Number(result.failed ?? 0);
    const [{ walking }] = await rows<{ walking: number }>(
      db,
      "select count(*)::int as walking from citizen_world_state where activity = 'walking'",
    );
    walkingSum += walking;
    peakWalking = Math.max(peakWalking, walking);
    samples += 1;
    if (elapsed === 60) {
      const now = await versions(db);
      changedFirstMinute = [...now].filter(([id, version]) => version !== base.get(id)).length;
    }
  }

  const after = await versions(db);
  let transitions = 0;
  let twoPlus = 0;
  for (const [id, version] of after) {
    const delta = version - (base.get(id) ?? 0);
    transitions += delta;
    if (delta >= 2) {
      twoPlus += 1;
    }
  }
  const [{ n: eventsAfter, kinds }] = await rows<{ n: number; kinds: number }>(
    db,
    `select count(*)::int as n,
            (select count(distinct kind)::int from civilization_events where seq > $1) as kinds
     from civilization_events`,
    [eventsBase],
  );
  const [{ w: worldAfter }] = await rows<{ w: string }>(db, "select last_tick_world_s as w from world_state");
  await db.close();

  const events = eventsAfter - eventsBase;
  return {
    speed,
    label,
    startWorldHour,
    realSeconds,
    citizensChangedFirstMinute: changedFirstMinute,
    citizensWithTwoTransitions: twoPlus,
    transitions,
    events,
    eventsPerMinute: Math.round((events / realSeconds) * 60 * 10) / 10,
    eventKinds: kinds,
    averageWalking: Math.round((walkingSum / samples) * 10) / 10,
    peakWalking,
    worldHoursElapsed: Math.round(((Number(worldAfter) - Number(worldBase)) / 3600) * 10) / 10,
    failed,
  };
}
