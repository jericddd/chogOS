import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string; message: string } | null };
let respond: (table: string) => Result = () => ({ data: [], error: null });
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

function builder(table: string): unknown {
  const target = {
    then(resolve: (value: Result) => unknown) {
      return Promise.resolve(respond(table)).then(resolve);
    },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then") {
        return obj.then;
      }
      return (...args: unknown[]) => {
        calls.push({ table, method: String(prop), args });
        if (prop === "maybeSingle") {
          return Promise.resolve(respond(`${table}:single`));
        }
        return builder(table);
      };
    },
  });
}

vi.mock("@/lib/db/client", () => ({
  createServiceRoleClient: () => ({ from: (table: string) => builder(table) }),
}));

const env = { ...process.env };

beforeEach(() => {
  calls.length = 0;
  process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
});

afterEach(() => {
  process.env = env;
});

describe("world loader", () => {
  it("reports an unapplied migration instead of failing", async () => {
    respond = () => ({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.world_state' in the schema cache" } });
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("migration_pending");
  });

  it("reports an uninitialized world", async () => {
    respond = (table) => ({ data: table.endsWith(":single") ? null : [], error: null });
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("not_initialized");
  });

  it("reports missing configuration without touching the database", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("asks for one extra row to detect missed live events and pages strictly before a cursor", async () => {
    respond = () => ({ data: [], error: null });
    const { loadEventPage, LIVE_EVENT_LIMIT } = await import("@/lib/world/load");
    await loadEventPage({ tokenId: "7", category: "social" }, 120, 10);
    const history = calls.filter((c) => c.table === "civilization_events");
    expect(history).toContainEqual({ table: "civilization_events", method: "lt", args: ["seq", 120] });
    expect(history).toContainEqual({ table: "civilization_events", method: "limit", args: [11] });
    expect(history).toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "social"] });
    expect(history).toContainEqual({
      table: "civilization_events",
      method: "or",
      args: ["payload->>tokenId.eq.7,payload->>relatedTokenId.eq.7"],
    });
    expect(LIVE_EVENT_LIMIT).toBe(100);
  });

  it("queries source=ai when the category filter is the AI alias", async () => {
    respond = () => ({ data: [], error: null });
    const { loadEventPage } = await import("@/lib/world/load");
    await loadEventPage({ category: "ai" }, null, 10);
    const history = calls.filter((c) => c.table === "civilization_events");
    expect(history).toContainEqual({ table: "civilization_events", method: "eq", args: ["source", "ai"] });
    expect(history).not.toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "ai"] });
    calls.length = 0;
    await loadEventPage({ category: "construction", source: "ai" }, null, 1);
    const construction = calls.filter((c) => c.table === "civilization_events");
    expect(construction).toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "construction"] });
    expect(construction).toContainEqual({ table: "civilization_events", method: "eq", args: ["source", "ai"] });
  });
});
