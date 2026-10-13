/**
 * Operator controls. Each change is recorded as a system event.
 *
 *   npm run world:admin -- status
 *   npm run world:admin -- speed 60        (or demo, calm)
 *   npm run world:admin -- pause
 *   npm run world:admin -- resume
 */
import { runnerHealth, formatWorldTime, worldSecondsAt } from "../src/lib/world/clock";
import { toClock, WORLD_STATE_COLUMNS, type WorldStateRow } from "../src/lib/world/rows";
import { describeSpeed, parseWorldSpeed } from "../src/lib/world/speed";
import { explainRpcError, openOperatorClient } from "./world-client";

async function main(): Promise<void> {
  const [command, value] = process.argv.slice(2);
  const { client } = openOperatorClient();

  if (command === "speed") {
    const speed = parseWorldSpeed(value);
    const { data, error } = await client.rpc("world_set_speed", { p_speed: speed });
    if (error) throw new Error(explainRpcError(error));
    console.log(describeSpeed(speed), JSON.stringify(data));
    return;
  }
  if (command === "pause" || command === "resume") {
    const { data, error } = await client.rpc("world_set_status", { p_status: command === "pause" ? "paused" : "running" });
    if (error) throw new Error(explainRpcError(error));
    console.log(JSON.stringify(data));
    return;
  }
  if (command === "status" || command === undefined) {
    const { data, error } = await client.from("world_state").select(`${WORLD_STATE_COLUMNS}, last_error, last_tick_ms, last_tick_processed`).maybeSingle();
    if (error) throw new Error(explainRpcError(error));
    if (!data) {
      console.log("The world is not initialized. Run npm run world:init.");
      return;
    }
    const row = data as WorldStateRow & { last_error: string | null; last_tick_ms: number | null; last_tick_processed: number };
    const clock = toClock(row, new Date());
    const now = Date.now();
    const { count } = await client.from("civilization_events").select("id", { count: "exact", head: true });
    const cron = await client.rpc("world_cron_status");
    console.log(
      JSON.stringify(
        {
          status: clock.status,
          health: runnerHealth(clock, now),
          worldTime: formatWorldTime(worldSecondsAt(clock, now)),
          speed: describeSpeed(clock.speed),
          tick: clock.tickSeq,
          lastTickAt: clock.lastTickAt,
          lastTickMs: row.last_tick_ms,
          lastTickProcessed: row.last_tick_processed,
          lastError: row.last_error,
          lastErrorAt: row.last_error_at,
          events: count,
          scheduler: cron.error ? "unknown" : cron.data,
          layout: `${clock.layoutVersion} ${clock.layoutHash}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error("Use status, speed <n|demo|calm>, pause, or resume.");
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
