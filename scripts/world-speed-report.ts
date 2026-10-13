/**
 * Runs the real world engine in an in-process Postgres at several speeds and
 * prints what a viewer would see in a 5-minute demo. No network access.
 *
 *   npm run world:speed-report
 */
import { measureWindow } from "../src/lib/world/speed-eval";

const speeds = (process.argv[2] ?? "30,60,120").split(",").map(Number);
const windows: Array<[string, number]> = [
  ["first visit after setup (05:40)", 5 + 40 / 60],
  ["midday (12:00)", 12],
  ["evening (19:00)", 19],
  ["night (23:30)", 23.5],
];

async function main(): Promise<void> {
  const results = [];
  for (const speed of speeds) {
    for (const [label, hour] of windows) {
      results.push(await measureWindow(speed, hour, label));
    }
  }
  console.table(
    results.map((r) => ({
      speed: `${r.speed}x`,
      window: r.label,
      "moved in 1st min": r.citizensChangedFirstMinute,
      "2+ transitions": r.citizensWithTwoTransitions,
      transitions: r.transitions,
      "events/min": r.eventsPerMinute,
      kinds: r.eventKinds,
      "avg walking": r.averageWalking,
      "peak walking": r.peakWalking,
      "world hours": r.worldHoursElapsed,
      failed: r.failed,
    })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
