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
  delete process.env.AI_RUNNER_ENABLED;
});

afterEach(() => {
  process.env = env;
});

describe("AI runner route", () => {
  it("stays closed until AI_RUNNER_SECRET is set", async () => {
    const { POST } = await import("@/app/api/ai/run/route");
    const response = await POST(new Request("http://x/api/ai/run", { method: "POST", headers: { authorization: "Bearer x" } }));
    expect(response.status).toBe(403);
    expect(runAiMind).not.toHaveBeenCalled();
  });

  it("requires the bearer secret and does not expose a public GET", async () => {
    process.env.AI_RUNNER_SECRET = "ai-runner-secret-for-tests-only";
    const mod = await import("@/app/api/ai/run/route");
    expect(Object.keys(mod)).toEqual(["POST"]);
    const denied = await mod.POST(
      new Request("http://x/api/ai/run", { method: "POST", headers: { authorization: "Bearer nope", "x-forwarded-for": "8.8.8.8" } }),
    );
    expect(denied.status).toBe(401);
    runAiMind.mockResolvedValue({ status: "disabled", provider: "gemini", claimed: 0, inferred: 0, submitted: 0, constructed: 0, rejected: 0, decisions: [] });
    const allowed = await mod.POST(
      new Request("http://x/api/ai/run", {
        method: "POST",
        headers: { authorization: "Bearer ai-runner-secret-for-tests-only", "x-forwarded-for": "8.8.8.9" },
      }),
    );
    expect(runAiMind).toHaveBeenCalledTimes(1);
    expect(allowed.status).toBe(403);
  });
});
