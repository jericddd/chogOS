import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const loadVerifyBundle = vi.fn();
vi.mock("@/lib/verify/load", () => ({
  loadVerifyBundle: (...args: unknown[]) => loadVerifyBundle(...args),
}));

const env = { ...process.env };

beforeEach(() => {
  loadVerifyBundle.mockReset();
  process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
});

afterEach(() => {
  process.env = env;
});

describe("verify event route", () => {
  it("exposes only GET and rejects writes", async () => {
    const mod = await import("@/app/api/verify/events/[id]/route");
    expect(Object.keys(mod).sort()).toEqual(["GET"]);
  });

  it("validates ids, does not cache, and returns export bytes", async () => {
    const { GET } = await import("@/app/api/verify/events/[id]/route");
    const bad = await GET(new Request("http://x/api/verify/events/nope", { headers: { "x-forwarded-for": "9.9.9.1" } }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(bad.status).toBe(400);
    loadVerifyBundle.mockResolvedValue({ status: "missing" });
    const missing = await GET(
      new Request("http://x/api/verify/events/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { headers: { "x-forwarded-for": "9.9.9.2" } }),
      { params: Promise.resolve({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) },
    );
    expect(missing.status).toBe(404);
    loadVerifyBundle.mockResolvedValue({
      schema: "chogos-verify-export-v1",
      event: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", seq: 1 },
      notes: ["x"],
    });
    const ok = await GET(
      new Request("http://x/api/verify/events/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?export=1", {
        headers: { "x-forwarded-for": "9.9.9.3" },
      }),
      { params: Promise.resolve({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("content-disposition")).toMatch(/chogos-event-/);
  });

  it("rate-limits repeated reads from one client", async () => {
    const { GET } = await import("@/app/api/verify/events/[id]/route");
    loadVerifyBundle.mockResolvedValue({ schema: "chogos-verify-export-v1", event: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, notes: [] });
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const hit = () =>
      GET(new Request("http://x/api/verify/events/" + id, { headers: { "x-forwarded-for": "203.0.113.9" } }), {
        params: Promise.resolve({ id }),
      });
    for (let i = 0; i < 40; i += 1) {
      expect((await hit()).status).toBe(200);
    }
    expect((await hit()).status).toBe(429);
  });
});
