import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => {
  const state = {
    scheduler: { data: null as unknown, error: null as { message: string } | null },
    decision: { data: null as unknown, error: null as { message: string } | null },
    throwOnCreate: false,
  };
  const from = (table: string) => {
    const api = {
      select() {
        return api;
      },
      eq() {
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      maybeSingle: async () => (table === "ai_scheduler_state" ? state.scheduler : state.decision),
    };
    return api;
  };
  return { state, from };
});

vi.mock("@/lib/db/client", () => ({
  createServiceRoleClient: () => {
    if (db.state.throwOnCreate) throw new Error("database timed out");
    return { from: db.from };
  },
}));

const env = { ...process.env };

afterEach(() => {
  process.env = env;
});

describe("AI run loader", () => {
  it("reads the scheduler and the newest decision without inventing either", async () => {
    process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
    db.state.throwOnCreate = false;
    db.state.scheduler = {
      data: {
        last_run_at: "2026-10-26T14:20:55Z",
        last_success_at: "2026-10-24T15:26:41Z",
        last_error: "AI run interrupted. Work was still unfinished at the host deadline. This is not a completed decision cycle.",
        halt_until: null,
        halt_reason: null,
      },
      error: null,
    };
    db.state.decision = {
      data: {
        id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        status: "accepted",
        purpose: "citizen_turn",
        rationale: "Rest before the shift.",
        output: { action: "rest" },
        created_at: "2026-10-24T11:00:00Z",
      },
      error: null,
    };
    const { loadAiRunView } = await import("@/lib/ai/run-status");
    const view = await loadAiRunView();
    expect(view.state).toBe("interrupted");
    expect(view.lastSuccessAt).toBe("2026-10-24T15:26:41Z");
    expect(view.lastRunAt).toBe("2026-10-26T14:20:55Z");
    expect(view.decision?.statusLabel).toBe("Proposal persisted");
    expect(view.decision?.rationale).toBe("Rest before the shift.");
    expect(view.decision?.txUrl).toBeNull();
    expect(view.latestDecisionAt).toBe("2026-10-24T11:00:00Z");
  });

  it("says the record could not be read, and says so when the database is unset", async () => {
    process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
    db.state.throwOnCreate = false;
    db.state.scheduler = { data: null, error: { message: "relation does not exist" } };
    db.state.decision = { data: null, error: { message: "relation does not exist" } };
    const { loadAiRunView } = await import("@/lib/ai/run-status");
    expect((await loadAiRunView()).state).toBe("unread");

    db.state.throwOnCreate = true;
    expect((await loadAiRunView()).state).toBe("unread");

    process.env = { ...env };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await loadAiRunView()).detail).toMatch(/not connected/);
  });
});
