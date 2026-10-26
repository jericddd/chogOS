import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishStoredAiActivity } from "@/lib/ai/activity-event";

const PUBLISHED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FRESH = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

type Decision = {
  id: string;
  citizen_id: string | null;
  purpose: string;
  status: string;
  rationale: string | null;
  output: unknown;
  outcome_event_id: string | null;
  created_at: string;
};

type Query = { purpose?: string; unpublished: boolean; limit?: number };

function store(seed: Decision[]) {
  const decisions = seed.map((row) => ({ ...row }));
  const events: Array<Record<string, unknown>> = [];
  const queries: Query[] = [];
  let inserts = 0;
  const client = {
    from(table: string) {
      const state: {
        op: string;
        values: Record<string, unknown> | null;
        filters: Array<{ op: string; column: string; value: unknown }>;
        limit?: number;
        single: boolean;
      } = { op: "select", values: null, filters: [], single: false };
      const run = async () => {
        if (table === "ai_decisions" && state.op === "select") {
          const purpose = state.filters.find((filter) => filter.op === "eq" && filter.column === "purpose")?.value;
          const unpublished = state.filters.some(
            (filter) => filter.op === "is" && filter.column === "outcome_event_id" && filter.value === null,
          );
          queries.push({ purpose: typeof purpose === "string" ? purpose : undefined, unpublished, limit: state.limit });
          let rows = decisions.filter((row) => row.purpose === purpose);
          if (unpublished) rows = rows.filter((row) => row.outcome_event_id == null);
          rows.sort((left, right) => right.created_at.localeCompare(left.created_at));
          return { data: rows.slice(0, state.limit ?? rows.length), error: null };
        }
        if (table === "ai_decisions" && state.op === "update") {
          const id = state.filters.find((filter) => filter.op === "eq" && filter.column === "id")?.value;
          const onlyMissing = state.filters.some((filter) => filter.op === "is" && filter.column === "outcome_event_id");
          const row = decisions.find((item) => item.id === id);
          if (row && state.values && (!onlyMissing || row.outcome_event_id == null)) Object.assign(row, state.values);
          return { data: null, error: null };
        }
        if (table === "citizens") return { data: [], error: null };
        if (table === "civilization_events" && state.op === "insert") {
          const row = state.values ?? {};
          if (events.some((event) => event.dedupe_key === row.dedupe_key)) {
            return { data: null, error: { code: "23505", message: "duplicate" } };
          }
          inserts += 1;
          events.push({ ...row, id: `evt-${events.length + 1}` });
          return { data: { id: events.at(-1)?.id }, error: null };
        }
        if (table === "civilization_events") {
          let rows = events;
          for (const filter of state.filters) {
            if (filter.op === "eq") rows = rows.filter((row) => row[filter.column] === filter.value);
            if (filter.op === "in" && Array.isArray(filter.value)) {
              rows = rows.filter((row) => (filter.value as unknown[]).includes(row[filter.column]));
            }
          }
          if (state.single) return { data: rows[0] ? { id: rows[0].id } : null, error: null };
          return { data: rows.map((row) => ({ id: row.id, dedupe_key: row.dedupe_key, kind: row.kind })), error: null };
        }
        return { data: null, error: null };
      };
      const api = {
        insert(values: Record<string, unknown>) {
          state.op = "insert";
          state.values = values;
          return api;
        },
        update(values: Record<string, unknown>) {
          state.op = "update";
          state.values = values;
          return api;
        },
        select() {
          if (state.op !== "insert") state.op = "select";
          return api;
        },
        eq(column: string, value: unknown) {
          state.filters.push({ op: "eq", column, value });
          return api;
        },
        is(column: string, value: unknown) {
          state.filters.push({ op: "is", column, value });
          return api;
        },
        in(column: string, value: unknown) {
          state.filters.push({ op: "in", column, value });
          return api;
        },
        order() {
          return api;
        },
        limit(value: number) {
          state.limit = value;
          return api;
        },
        maybeSingle() {
          state.single = true;
          return run();
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return run().then(resolve, reject);
        },
      };
      return api;
    },
  };
  return { decisions, events, queries, inserted: () => inserts, client: client as unknown as SupabaseClient };
}

function decision(id: string, createdAt: string, outcome: string | null = null): Decision {
  return {
    id,
    citizen_id: "cccccccc-dddd-4eee-8fff-111111111111",
    purpose: "citizen_turn",
    status: "proposed",
    rationale: "Rest before the work shift.",
    output: { action: "rest", tokenId: "105" },
    outcome_event_id: outcome,
    created_at: createdAt,
  };
}

describe("stored AI activity backfill", () => {
  it("publishes only unlinked decisions and does not insert them again on retry", async () => {
    const saved = store([decision(FRESH, "2026-10-26T00:00:02Z"), decision(PUBLISHED, "2026-10-26T00:00:01Z", "already")]);
    await publishStoredAiActivity(saved.client);
    expect(saved.queries.every((query) => query.unpublished && query.limit === 20)).toBe(true);
    expect(saved.inserted()).toBe(1);
    expect(saved.events[0]?.dedupe_key).toBe(`ai:citizen-turn:${FRESH}`);
    expect(saved.decisions.find((row) => row.id === FRESH)?.outcome_event_id).toBe(saved.events[0]?.id);
    expect(saved.decisions.find((row) => row.id === PUBLISHED)?.outcome_event_id).toBe("already");

    const before = saved.inserted();
    await publishStoredAiActivity(saved.client);
    expect(saved.inserted()).toBe(before);
  });

  it("links an existing activity row instead of inserting a duplicate", async () => {
    const saved = store([decision(FRESH, "2026-10-26T00:00:02Z")]);
    saved.events.push({ id: "evt-existing", dedupe_key: `ai:citizen-turn:${FRESH}`, kind: "ai.decision" });
    await publishStoredAiActivity(saved.client);
    await publishStoredAiActivity(saved.client);
    expect(saved.inserted()).toBe(0);
    expect(saved.events).toHaveLength(1);
    expect(saved.decisions[0]?.outcome_event_id).toBe("evt-existing");
  });

  it("caps each purpose and stops at the deadline after persisting drafts already built", async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      decision(`dddddddd-eeee-4fff-8aaa-${index.toString(16).padStart(12, "0")}`, `2026-10-26T00:00:${String(index).padStart(2, "0")}Z`),
    );
    const capped = store(many);
    await publishStoredAiActivity(capped.client);
    expect(capped.queries.find((query) => query.purpose === "citizen_turn")?.limit).toBe(20);
    expect(capped.inserted()).toBe(20);

    const clock = store([
      {
        ...decision(FRESH, "2026-10-26T00:00:02Z"),
        purpose: "wallet_issuance",
        output: { choice: "issue", tokenId: "105" },
      },
    ]);
    const times = [0, 0, 100];
    let tick = 0;
    await publishStoredAiActivity(clock.client, {
      deadlineAtMs: 50,
      now: () => times[Math.min(tick++, times.length - 1)] ?? 100,
    });
    expect(clock.queries.map((query) => query.purpose)).toEqual(["wallet_issuance"]);
    expect(clock.inserted()).toBe(1);

    const closed = store([decision(FRESH, "2026-10-26T00:00:02Z")]);
    await publishStoredAiActivity(closed.client, { deadlineAtMs: 50, now: () => 100 });
    expect(closed.queries).toEqual([]);
    expect(closed.inserted()).toBe(0);

    const wide = store([decision(FRESH, "2026-10-26T00:00:02Z")]);
    await publishStoredAiActivity(wide.client, { limit: 400 });
    expect(wide.queries.every((query) => query.limit === 40)).toBe(true);
  });

  it("returns when the database read throws", async () => {
    const client = {
      from() {
        throw new Error("feed down");
      },
    };
    await expect(publishStoredAiActivity(client as unknown as SupabaseClient)).resolves.toBeUndefined();
  });
});
