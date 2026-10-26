import { describe, expect, it } from "vitest";
import { treasuryReasonHash } from "@/lib/economy/treasury-policy";
import {
  AI_RUN_INTERRUPTED,
  AI_RUN_STARTED,
  aiRunFinishNote,
  describeAiRun,
  describeStoredDecision,
  type MindReportSnapshot,
  type SchedulerRecord,
  type StoredDecisionRecord,
} from "@/lib/ai/run-record";

const TX = `0x${"ab".repeat(32)}`;
const REASON = "Citizen aims to meet neighbours at the square and requires funds for social engagement.";
const NOW = Date.parse("2026-10-26T12:00:00Z");

function report(patch: Partial<MindReportSnapshot> = {}): MindReportSnapshot {
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
    ...patch,
  };
}

function scheduler(patch: Partial<SchedulerRecord> = {}): SchedulerRecord {
  return {
    lastRunAt: "2026-10-26T12:00:00Z",
    lastSuccessAt: "2026-10-24T15:26:41Z",
    lastError: null,
    haltUntil: null,
    haltReason: null,
    ...patch,
  };
}

function decision(patch: Partial<StoredDecisionRecord> = {}): StoredDecisionRecord {
  return {
    id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    status: "accepted",
    purpose: "citizen_turn",
    rationale: "It is currently hour 3, which is before the work shift starts at 05:00, so resting at home is appropriate.",
    output: { action: "rest", tokenId: "105" },
    createdAt: "2026-10-24T11:00:00Z",
    ...patch,
  };
}

describe("AI run notes", () => {
  it("names a finished cycle with proposals and a finished cycle with none", () => {
    expect(aiRunFinishNote(report({ inferred: 2, reason: "Stopped remaining citizens before the host timeout." }))).toBe(
      "AI run completed with proposals. Stopped remaining citizens before the host timeout.",
    );
    expect(aiRunFinishNote(report({ reason: "No eligible citizens." }))).toBe(
      "AI run completed with no decisions. No eligible citizens.",
    );
    expect(aiRunFinishNote(report())).toBe("AI run completed with no decisions.");
    expect(aiRunFinishNote(report({ status: "error", reason: "The decision claim failed." }))).toBe(
      "AI run failed. The decision claim failed.",
    );
    expect(aiRunFinishNote(report({ status: "interrupted", inferred: 3 }))).toBe(AI_RUN_INTERRUPTED);
    expect(aiRunFinishNote(report({ treasury: { status: "skipped", detail: "No model time remained." } }))).toBe(
      "AI run completed with no decisions.",
    );
  });
});

describe("AI run presentation", () => {
  it("keeps an older operational sentence and classifies the explicit run notes", () => {
    const older = describeAiRun({
      configured: true,
      readable: true,
      scheduler: scheduler({ lastError: "Stopped remaining citizens before the host timeout." }),
      decision: decision(),
      nowMs: NOW,
    });
    expect(older.state).toBe("noted");
    expect(older.title).toBe("Stored run note");
    expect(older.detail).toBe("Stopped remaining citizens before the host timeout.");
    expect(older.lastSuccessAt).toBe("2026-10-24T15:26:41Z");
    expect(older.latestDecisionAt).toBe("2026-10-24T11:00:00Z");

    expect(
      describeAiRun({
        configured: true,
        readable: true,
        scheduler: scheduler({ lastError: AI_RUN_STARTED, lastSuccessAt: null }),
        decision: null,
        nowMs: NOW,
      }).state,
    ).toBe("started");
    expect(
      describeAiRun({
        configured: true,
        readable: true,
        scheduler: scheduler({ lastError: AI_RUN_INTERRUPTED }),
        decision: decision(),
        nowMs: NOW,
      }),
    ).toMatchObject({ state: "interrupted", detail: AI_RUN_INTERRUPTED });
    expect(
      describeAiRun({
        configured: true,
        readable: true,
        scheduler: scheduler({ lastError: "AI run completed with no decisions. No eligible citizens." }),
        decision: null,
        nowMs: NOW,
      }).state,
    ).toBe("completed_without_decisions");
    expect(
      describeAiRun({
        configured: true,
        readable: true,
        scheduler: scheduler({ lastError: "AI run completed with proposals." }),
        decision: decision(),
        nowMs: NOW,
      }).state,
    ).toBe("completed_with_proposals");
    expect(
      describeAiRun({
        configured: true,
        readable: true,
        scheduler: scheduler({ lastError: "AI run failed. The decision claim failed." }),
        decision: null,
        nowMs: NOW,
      }).state,
    ).toBe("failed");
  });

  it("shows a halt, an empty record, and an unreadable record without inventing times", () => {
    const halted = describeAiRun({
      configured: true,
      readable: true,
      scheduler: scheduler({
        haltUntil: "2026-10-26T13:00:00Z",
        haltReason: "Daily model quota is closed.",
        lastError: AI_RUN_STARTED,
      }),
      decision: decision(),
      nowMs: NOW,
    });
    expect(halted.state).toBe("halted");
    expect(halted.detail).toBe("Daily model quota is closed.");

    const empty = describeAiRun({
      configured: true,
      readable: true,
      scheduler: scheduler({ lastRunAt: null, lastSuccessAt: null, lastError: null }),
      decision: null,
      nowMs: NOW,
    });
    expect(empty).toMatchObject({
      state: "not_recorded",
      lastRunAt: null,
      lastSuccessAt: null,
      latestDecisionAt: null,
      decision: null,
    });

    const unread = describeAiRun({
      configured: true,
      readable: false,
      scheduler: scheduler(),
      decision: decision(),
      nowMs: NOW,
    });
    expect(unread.state).toBe("unread");
    expect(unread.decision).toBeNull();
    expect(unread.lastRunAt).toBeNull();

    expect(
      describeAiRun({ configured: false, readable: false, scheduler: null, decision: null }).detail,
    ).toMatch(/not connected/);
  });

  it("labels a stored proposal without calling it executed, and links only a verified receipt", () => {
    const proposed = describeStoredDecision(decision({ status: "proposed" }));
    expect(proposed.statusLabel).toBe("Proposal persisted");
    expect(proposed.summary).not.toMatch(/executed/i);
    expect(proposed.rationale).toMatch(/hour 3/);
    expect(proposed.txUrl).toBeNull();

    expect(describeStoredDecision(decision({ status: "draft" })).statusLabel).toBe("Proposal not finished");
    expect(describeStoredDecision(decision({ status: "rejected" })).statusLabel).toBe("Proposal rejected");
    expect(describeStoredDecision(decision({ status: "failed" })).statusLabel).toBe("Proposal failed");
    expect(describeStoredDecision(decision({ status: "queued" })).summary).toBe("Proposal submitted to the simulation.");
    expect(describeStoredDecision(decision({ status: "executed", purpose: "citizen_turn" })).summary).toMatch(/not a chain receipt/);

    const confirmed = describeStoredDecision(
      decision({
        status: "executed",
        purpose: "treasury_allocation",
        rationale: "The stored review rationale.",
        output: {
          reason: REASON,
          verified: true,
          onchain: true,
          chainId: 143,
          txHash: TX,
          reasonHash: treasuryReasonHash(REASON),
        },
      }),
    );
    expect(confirmed.statusLabel).toBe("Confirmed on-chain action");
    expect(confirmed.summary).toBe(REASON);
    expect(confirmed.rationale).toBe("The stored review rationale.");
    expect(confirmed.txUrl).toBe(`https://monadscan.com/tx/${TX}`);

    const mismatched = describeStoredDecision(
      decision({
        status: "executed",
        purpose: "treasury_allocation",
        output: {
          reason: REASON,
          verified: true,
          onchain: true,
          chainId: 143,
          txHash: TX,
          reasonHash: `0x${"11".repeat(32)}`,
        },
      }),
    );
    expect(mismatched.txUrl).toBeNull();
    expect(mismatched.statusLabel).toBe("Action recorded");
    expect(mismatched.summary).toMatch(/not a chain receipt/);
  });
});
