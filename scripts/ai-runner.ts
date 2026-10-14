/**
 * Cloud-side AI decision loop. Does not tick the world. Does not run in a browser.
 *
 *   AI_RUNNER_ENABLED=true npm run ai:runner
 *
 * Interval is AI_RUNNER_SECONDS (default 180). Several runners are safe: claims
 * use row locks. Inference stays out of world_tick().
 */
import { runAiMind } from "../src/lib/ai/runner";
import { readAppConfig } from "../src/lib/config/env";

const intervalMs = Math.max(30, Number(process.env.AI_RUNNER_SECONDS ?? 180)) * 1000;

async function main(): Promise<void> {
  const config = readAppConfig();
  if (!config.aiRunnerEnabled) {
    console.error("AI_RUNNER_ENABLED is not true. The mind stays off.");
    process.exit(2);
  }
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  console.log(`AI runner every ${intervalMs / 1000}s. Provider=${config.aiProvider} model=${config.aiModel ?? "unset"}.`);
  while (!stopping) {
    const started = Date.now();
    const report = await runAiMind(config);
    if (report.status !== "idle" || report.claimed) {
      console.log(new Date().toISOString(), JSON.stringify({ ...report, decisions: report.decisions.slice(0, 8) }));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, intervalMs - (Date.now() - started))));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
