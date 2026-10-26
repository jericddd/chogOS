import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { finishBeforeDeadline } from "@/lib/ai/invocation";
import { AI_RUN_INTERRUPTED, interruptedMindReport, type MindReportSnapshot } from "@/lib/ai/run-record";

function blankReport(): MindReportSnapshot {
  return {
    status: "ran",
    provider: "gemini",
    model: "gemini-3.8-flash",
    claimed: 0,
    inferred: 0,
    submitted: 0,
    constructed: 0,
    rejected: 0,
    decisions: [],
  };
}

describe("unfinished AI run", () => {
  it("returns a snapshot that is not a completed cycle and ignores later mutations", async () => {
    const report = blankReport();
    const hung = new Promise<MindReportSnapshot>(() => {});
    const settled = await finishBeforeDeadline(
      hung,
      () => {
        const snapshot = interruptedMindReport(report);
        report.status = "ran";
        report.claimed = 4;
        report.inferred = 2;
        report.reason = "late completion";
        report.decisions.push({ tokenId: "105", status: "queued", detail: "work" });
        report.treasury = { status: "proposed", detail: "late treasury" };
        return snapshot;
      },
      20,
    );

    expect(settled.status).toBe("interrupted");
    expect(settled.reason).toBe(AI_RUN_INTERRUPTED);
    expect(settled.reason).toMatch(/not a completed decision cycle/);
    expect(settled.claimed).toBe(0);
    expect(settled.inferred).toBe(0);
    expect(settled.decisions).toEqual([]);
    expect(settled.treasury).toBeUndefined();
    expect(report.claimed).toBe(4);
  });

  it("keeps the activity backfill after the decision cycle and tells the truth when the deadline wins", () => {
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    const activity = readFileSync("src/lib/ai/activity-event.ts", "utf8");
    const opened = runner.indexOf('rpc("world_ensure_minds")');
    const budget = runner.indexOf("evaluateBudget(config, usage)");
    expect(runner.slice(opened, budget)).not.toContain("publishStoredAiActivity");
    expect(runner.slice(runner.indexOf("async function finish"))).toContain("publishStoredAiActivity");
    expect(runner).toContain("AI_RUN_STARTED");
    expect(runner).toContain("interruptedMindReport");
    expect(runner).toContain("control.stop = true");
    expect(runner).not.toContain("Returned before the host timeout");
    expect(runner).not.toMatch(/sendTransaction|signTypedData|walletClient|eth_sendRawTransaction/);
    expect(activity).toContain('is("outcome_event_id", null)');
    expect(activity).toContain("AI_ACTIVITY_BACKFILL_LIMIT = 20");
    expect(activity).not.toContain(".limit(400)");
  });
});
