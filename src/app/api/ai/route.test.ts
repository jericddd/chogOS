import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runAiMind = vi.fn();
vi.mock("@/lib/ai/runner", () => ({
  runAiMind: (...args: unknown[]) => runAiMind(...args),
}));

const env = { ...process.env };

beforeEach(() => {
  runAiMind.mockReset();
  process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
  delete process.env.AI_RUNNER_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.AI_RUNNER_ENABLED;
});

afterEach(() => {
  process.env = env;
});

describe("AI runner route", () => {
  it("stays closed until AI_RUNNER_SECRET or CRON_SECRET is set", async () => {
    const { POST, GET } = await import("@/app/api/ai/run/route");
    const post = await POST(new Request("http://x/api/ai/run", { method: "POST", headers: { authorization: "Bearer x" } }));
    const get = await GET(new Request("http://x/api/ai/run", { method: "GET", headers: { authorization: "Bearer x" } }));
    expect(post.status).toBe(403);
    expect(get.status).toBe(403);
    expect(runAiMind).not.toHaveBeenCalled();
  });

  it("accepts Vercel Cron GET with CRON_SECRET", async () => {
    process.env.CRON_SECRET = "vercel-cron-secret-for-tests-only";
    process.env.AI_RUNNER_ENABLED = "true";
    const { GET } = await import("@/app/api/ai/run/route");
    const denied = await GET(
      new Request("http://x/api/ai/run", { headers: { authorization: "Bearer nope", "x-forwarded-for": "8.8.8.8" } }),
    );
    expect(denied.status).toBe(401);
    runAiMind.mockResolvedValue({
      status: "idle",
      provider: "gemini",
      claimed: 0,
      inferred: 0,
      submitted: 0,
      constructed: 0,
      rejected: 0,
      decisions: [],
    });
    const allowed = await GET(
      new Request("http://x/api/ai/run", {
        headers: { authorization: "Bearer vercel-cron-secret-for-tests-only", "x-forwarded-for": "8.8.8.9" },
      }),
    );
    expect(runAiMind).toHaveBeenCalledTimes(1);
    expect(runAiMind.mock.calls[0]?.[1]).toBe(80_000);
    expect(allowed.status).toBe(200);
  });

  it("requires the bearer secret on POST", async () => {
    process.env.AI_RUNNER_SECRET = "ai-runner-secret-for-tests-only";
    const { POST } = await import("@/app/api/ai/run/route");
    const denied = await POST(
      new Request("http://x/api/ai/run", { method: "POST", headers: { authorization: "Bearer nope", "x-forwarded-for": "8.8.8.8" } }),
    );
    expect(denied.status).toBe(401);
    runAiMind.mockResolvedValue({
      status: "disabled",
      provider: "gemini",
      claimed: 0,
      inferred: 0,
      submitted: 0,
      constructed: 0,
      rejected: 0,
      decisions: [],
    });
    const allowed = await POST(
      new Request("http://x/api/ai/run", {
        method: "POST",
        headers: { authorization: "Bearer ai-runner-secret-for-tests-only", "x-forwarded-for": "8.8.8.9" },
      }),
    );
    expect(runAiMind).toHaveBeenCalledTimes(1);
    expect(runAiMind.mock.calls[0]?.[1]).toBe(80_000);
    expect(allowed.status).toBe(403);
    const longWait = await POST(
      new Request("http://x/api/ai/run", {
        method: "POST",
        headers: {
          authorization: "Bearer ai-runner-secret-for-tests-only",
          "x-forwarded-for": "8.8.8.10",
          "x-chog-ai-wait": "long",
        },
      }),
    );
    expect(longWait.status).toBe(403);
    expect(runAiMind.mock.calls[1]?.[1]).toBe(200_000);
  });
});
