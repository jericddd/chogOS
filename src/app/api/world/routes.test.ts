import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
vi.mock("@/lib/db/client", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

const loadLive = vi.fn();
const loadEventPage = vi.fn();
vi.mock("@/lib/world/load", () => ({
  loadLive: (...args: unknown[]) => loadLive(...args),
  loadEventPage: (...args: unknown[]) => loadEventPage(...args),
}));

const env = { ...process.env };

beforeEach(() => {
  rpc.mockReset();
  loadLive.mockReset();
  loadEventPage.mockReset();
  process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
  delete process.env.WORLD_RUNNER_SECRET;
});

afterEach(() => {
  process.env = env;
});

describe("public world routes", () => {
  it("expose only read methods", async () => {
    const live = await import("@/app/api/world/live/route");
    const events = await import("@/app/api/world/events/route");
    for (const mod of [live, events]) {
      expect(Object.keys(mod).sort()).toEqual(["GET"]);
    }
    const tick = await import("@/app/api/world/tick/route");
    expect(Object.keys(tick)).toEqual(["POST"]);
  });

  it("serves live state without caching and validates since", async () => {
    const { GET } = await import("@/app/api/world/live/route");
    loadLive.mockResolvedValue({ status: "ok", events: [] });
    const ok = await GET(new Request("http://x/api/world/live?since=41", { headers: { "x-forwarded-for": "1.1.1.1" } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(loadLive).toHaveBeenCalledWith(41);
    const bad = await GET(new Request("http://x/api/world/live?since=abc", { headers: { "x-forwarded-for": "1.1.1.2" } }));
    expect(bad.status).toBe(400);
    loadLive.mockResolvedValue({ status: "migration_pending", detail: "pending" });
    const pending = await GET(new Request("http://x/api/world/live", { headers: { "x-forwarded-for": "1.1.1.3" } }));
    expect(pending.status).toBe(503);
    expect(loadLive).toHaveBeenLastCalledWith(null);
  });

  it("passes only whitelisted filters to the history reader", async () => {
    const { GET } = await import("@/app/api/world/events/route");
    loadEventPage.mockResolvedValue({ status: "ok", events: [], nextBefore: null });
    const ok = await GET(
      new Request("http://x/api/world/events?before=90&limit=10&category=social&source=simulation&citizen=7&building=market", {
        headers: { "x-forwarded-for": "2.2.2.1" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(loadEventPage).toHaveBeenCalledWith(
      { category: "social", source: "simulation", tokenId: "7", buildingId: "market" },
      90,
      10,
    );
    for (const query of ["citizen=7,actor_citizen_id.neq.0", "category=secret", "source=admin", "building=../x", "limit=500"]) {
      const response = await GET(new Request(`http://x/api/world/events?${query}`, { headers: { "x-forwarded-for": "2.2.2.2" } }));
      expect(response.status).toBe(400);
    }
    expect(loadEventPage).toHaveBeenCalledTimes(1);
  });
});

describe("runner route", () => {
  it("stays closed until WORLD_RUNNER_SECRET is set", async () => {
    const { POST } = await import("@/app/api/world/tick/route");
    const response = await POST(new Request("http://x/api/world/tick", { method: "POST", headers: { authorization: "Bearer anything" } }));
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires the bearer secret and only calls world_tick", async () => {
    process.env.WORLD_RUNNER_SECRET = "runner-secret-for-tests-only";
    const { POST } = await import("@/app/api/world/tick/route");
    const denied = await POST(new Request("http://x/api/world/tick", { method: "POST", headers: { authorization: "Bearer nope", "x-forwarded-for": "3.3.3.1" } }));
    expect(denied.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: { status: "ok", tick: 5 }, error: null });
    const allowed = await POST(
      new Request("http://x/api/world/tick", {
        method: "POST",
        headers: { authorization: "Bearer runner-secret-for-tests-only", "x-forwarded-for": "3.3.3.2" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("world_tick");
    expect(await allowed.json()).toEqual({ ok: true, result: { status: "ok", tick: 5 } });
  });
});
