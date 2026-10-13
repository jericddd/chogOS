/**
 * Fallback scheduler for databases without pg_cron. Calls world_tick every
 * WORLD_TICK_SECONDS (default 5). Several runners at once are safe: the
 * database lock lets one tick through and the others return busy or too_soon.
 *
 *   npm run world:runner
 */
import { explainRpcError, openOperatorClient } from "./world-client";

const intervalMs = Math.max(1, Number(process.env.WORLD_TICK_SECONDS ?? 5)) * 1000;

async function main(): Promise<void> {
  const { client } = openOperatorClient();
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  console.log(`Ticking every ${intervalMs / 1000}s. Ctrl+C stops.`);
  while (!stopping) {
    const started = Date.now();
    const { data, error } = await client.rpc("world_tick");
    if (error) {
      console.error(new Date().toISOString(), explainRpcError(error));
    } else {
      const result = data as { status: string; tick?: number; processed?: number; failed?: number; joined?: number; resumed?: boolean };
      if (result.status !== "ok" || result.processed || result.failed || result.joined || result.resumed) {
        console.log(new Date().toISOString(), JSON.stringify(result));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, intervalMs - (Date.now() - started))));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
