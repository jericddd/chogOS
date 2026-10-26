import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => {
  const state = {
    scheduler: { data: null as unknown, error: null as { message: string } | null },
    decision: { data: null as unknown, error: null as { message: string } | null },
    citizens: { data: [] as unknown[], error: null as { message: string } | null },
    calls: [] as Array<{ table: string; method: string; column?: string; value?: unknown }>,
    throwOnCreate: false,
  };
  const from = (table: string) => {
    const api = {
      purpose: null as string | null,
      select() {
        return api;
      },
      eq(column: string, value: unknown) {
        state.calls.push({ table, method: "eq", column, value });
        if (column === "purpose") api.purpose = typeof value === "string" ? value : null;
        return api;
      },
      in(column: string, value: unknown) {
        state.calls.push({ table, method: "in", column, value });
        return api;
      },
      order() {
        return api;
      },
      limit(value: number) {
        state.calls.push({ table, method: "limit", value });
        return api;
      },
      maybeSingle: async () => (table === "ai_scheduler_state" ? state.scheduler : state.decision),
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        const result = table === "ai_decisions" && api.purpose === "citizen_turn" ? state.citizens : state.decision;
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
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
    db.state.citizens = { data: [], error: null };
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
    expect(view.citizenDecisions).toEqual([]);
  });

  it("keeps citizen turns when the newest row is a later wallet proposal", async () => {
    process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
    db.state.throwOnCreate = false;
    db.state.calls = [];
    db.state.scheduler = {
      data: {
        last_run_at: "2026-10-26T16:54:24Z",
        last_success_at: "2026-10-26T16:40:51Z",
        last_error: "AI run interrupted. Work was still unfinished at the host deadline. This is not a completed decision cycle.",
        halt_until: null,
        halt_reason: null,
      },
      error: null,
    };
    db.state.decision = {
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "proposed",
        purpose: "wallet_issuance",
        rationale: "Every enrolled citizen gets one permanent wallet. Token 946 is next. No address was assigned by this decision. The issuer broadcasts it.",
        output: { tokenId: "946" },
        created_at: "2026-10-26T16:54:25Z",
      },
      error: null,
    };
    db.state.citizens = {
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "queued",
          purpose: "citizen_turn",
          rationale: "The merchant is at the market and chooses to visit the bank to review public records.",
          output: { action: "visit", tokenId: "167" },
          created_at: "2026-10-26T16:39:18Z",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          status: "accepted",
          purpose: "citizen_turn",
          rationale: "Storehouse supplies are maintained by active farmers working the fields during the workday.",
          output: { action: "work", tokenId: "547" },
          created_at: "2026-10-26T16:39:55Z",
        },
      ],
      error: null,
    };
    const { loadAiRunView } = await import("@/lib/ai/run-status");
    const view = await loadAiRunView();
    expect(view.state).toBe("interrupted");
    expect(view.decision?.rationale).toMatch(/Token 946/);
    expect(view.decision?.txUrl).toBeNull();
    expect(view.citizenDecisions.map((row) => [row.tokenId, row.action, row.statusLabel])).toEqual([
      ["167", "visit", "Proposal submitted to the simulation"],
      ["547", "work", "Proposal persisted"],
    ]);
    expect(view.citizenDecisions.every((row) => row.txUrl === null)).toBe(true);
    expect(db.state.calls).toContainEqual({ table: "ai_decisions", method: "eq", column: "purpose", value: "citizen_turn" });
    expect(db.state.calls).toContainEqual({
      table: "ai_decisions",
      method: "in",
      column: "status",
      value: ["queued", "accepted", "proposed", "executed", "rejected", "failed"],
    });
    expect(db.state.calls).toContainEqual({ table: "ai_decisions", method: "limit", value: 8 });
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
