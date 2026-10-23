import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "@/lib/ai/providers/gemini";
import {
  pacificDayStartMs,
  reserveOnLedger,
  SharedQuotaLedger,
  createQuotaState,
  type QuotaDecision,
} from "@/lib/ai/model-quota";
import { FLASH_GAP_MS } from "@/lib/ai/model-route";
import { AiProviderError } from "@/lib/ai/types";
import { readAppConfig } from "@/lib/config/env";
import { initialize, openWorldDb, rows, seedCitizens } from "@/lib/world/test-db";
import type { PGlite } from "@electric-sql/pglite";

const DAY = "2026-10-24T07:00:00.000Z";
const BEFORE_RESET = "2026-10-24T06:59:00.000Z";

function config() {
  return readAppConfig({
    AI_PROVIDER: "gemini",
    AI_API_KEY: "test-key",
    AI_MODEL: "gemini-3.8-flash",
  } as unknown as NodeJS.ProcessEnv);
}

function okText() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"action":"rest","summary":"Rest.","rationale":"Night."}' }] } }],
    }),
    { status: 200 },
  );
}

describe("Gemini quota day", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses midnight Pacific, including the daylight-saving offset", () => {
    expect(new Date(pacificDayStartMs(Date.parse(BEFORE_RESET))).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(new Date(pacificDayStartMs(Date.parse(DAY))).toISOString()).toBe(DAY);
    expect(new Date(pacificDayStartMs(Date.parse("2026-10-24T18:00:00Z"))).toISOString()).toBe(DAY);
    expect(new Date(pacificDayStartMs(Date.parse("2026-01-15T20:00:00Z"))).toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("spaces Flash, caps the day and the minute, and lets the next quota day start clean", () => {
    const state = createQuotaState();
    const start = Date.parse(DAY);
    const first = reserveOnLedger(state, "flash", start);
    const tooSoon = reserveOnLedger(state, "flash", start + 60_000);
    expect(first).toMatchObject({ ok: true, attempts: 1 });
    expect(tooSoon).toMatchObject({ ok: false, code: "spacing", attempts: 1 });
    let at = start;
    for (let n = 2; n <= 20; n += 1) {
      at += FLASH_GAP_MS;
      expect(reserveOnLedger(state, "flash", at).ok).toBe(true);
    }
    state.days.set(`flash:${start}`, { attempts: 20, lastAtMs: start + 60 * 60_000 });
    const capped = reserveOnLedger(state, "flash", start + 60 * 60_000 + FLASH_GAP_MS);
    expect(capped).toMatchObject({ ok: false, code: "day", attempts: 20 });
    const nextDay = reserveOnLedger(state, "flash", start + 24 * 60 * 60_000);
    expect(nextDay).toMatchObject({ ok: true, attempts: 1 });
  });

  it("enforces Lite's per-minute cap and serializes overlapping Flash attempts", async () => {
    const state = createQuotaState();
    const minute = Date.parse("2026-10-24T07:10:00Z");
    for (let n = 0; n < 15; n += 1) {
      expect(reserveOnLedger(state, "lite", minute).ok).toBe(true);
    }
    expect(reserveOnLedger(state, "lite", minute)).toMatchObject({ ok: false, code: "rpm", attempts: 15 });

    state.days.set(`flash:${Date.parse(DAY)}`, { attempts: 3, lastAtMs: minute - FLASH_GAP_MS - 1_000 });
    state.minutes.set(`flash:${Math.floor(minute / 60_000) * 60_000}`, 5);
    expect(reserveOnLedger(state, "flash", minute)).toMatchObject({ ok: false, code: "rpm", attempts: 3 });

    const shared = new SharedQuotaLedger();
    const raced = await Promise.all([shared.reserve("flash", minute), shared.reserve("flash", minute)]);
    const admitted = raced.filter((item: QuotaDecision) => item.ok);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.attempts).toBe(1);
    expect(raced.some((item) => item.code === "spacing")).toBe(true);
  });

  it("does not send a request that the shared ledger refuses, including a retry", async () => {
    const fetchSpy = vi.fn(async () => okText());
    vi.stubGlobal("fetch", fetchSpy);
    await expect(createGeminiProvider(config()).complete({ purpose: "citizen_turn", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockClear();
    await expect(
      createGeminiProvider(config()).complete({
        purpose: "treasury_allocation",
        reserveAttempt: async () => {
          throw new AiProviderError("The shared model slot is not open.", "rate_limit", false);
        },
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "rate_limit", halt: false });
    expect(fetchSpy).not.toHaveBeenCalled();

    let reserved = 0;
    fetchSpy.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(
      createGeminiProvider(config()).complete({
        purpose: "citizen_turn",
        reserveAttempt: async () => {
          reserved += 1;
          if (reserved > 1) throw new AiProviderError("The shared model slot is not open.", "rate_limit", false);
        },
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls as unknown[][])[0]?.[0])).toContain("gemini-3.5-flash-lite");

    reserved = 0;
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => okText());
    const reservedFirst = await createGeminiProvider(config()).complete({
      purpose: "citizen_turn",
      attemptAlreadyReserved: true,
      reserveAttempt: async () => {
        reserved += 1;
      },
      messages: [{ role: "user", content: "x" }],
    });
    expect(reservedFirst.model).toBe("gemini-3.5-flash-lite");
    expect(reserved).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const calls = { n: 0 };
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(
      createGeminiProvider(config()).complete({
        purpose: "treasury_allocation",
        reserveAttempt: async () => {
          calls.n += 1;
        },
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "timeout", halt: false });
    expect(calls.n).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("durable model ledger", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await openWorldDb();
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it("reserves Flash and Lite in Postgres across the Pacific day, retries, and the minute cap", async () => {
    const migration = readFileSync("supabase/migrations/20261024043000_model_quota.sql", "utf8");
    expect(migration).toContain("for update");
    expect(migration).toContain("interval '72 minutes'");
    expect(migration).toContain("interval '4 minutes'");
    expect(migration).toContain("America/Los_Angeles");

    const call = async (tier: string, at: string) =>
      (
        await rows<{ r: { ok?: boolean; code?: string; attempts?: number } }>(
          db,
          "select ai_reserve_model_attempt($1, $2::timestamptz) as r",
          [tier, at],
        )
      )[0]!.r;

    const yesterday = await call("flash", BEFORE_RESET);
    const today = await call("flash", DAY);
    expect(yesterday).toMatchObject({ ok: true, attempts: 1 });
    expect(today).toMatchObject({ ok: true, attempts: 1 });
    const crowded = await call("flash", "2026-10-24T07:01:00Z");
    expect(crowded).toMatchObject({ ok: false, code: "spacing", attempts: 1 });

    const spaced = await call("flash", "2026-10-24T08:12:00Z");
    expect(spaced).toMatchObject({ ok: true, attempts: 2 });

    await db.query(
      `update ai_usage_counters
       set invocations = 20,
           halted_reason = to_char((timestamptz '2026-10-24 10:00:00+00' - interval '73 minutes') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')
       where bucket = 'day' and period_start = $1::timestamptz`,
      [DAY],
    );
    const daily = await call("flash", "2026-10-24T10:00:00Z");
    expect(daily).toMatchObject({ ok: false, code: "day", attempts: 20 });

    await db.query(
      `update ai_usage_counters
       set invocations = 0,
           halted_reason = to_char((timestamptz '2026-10-24 11:00:00+00' - interval '73 minutes') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')
       where bucket = 'day' and period_start = $1::timestamptz`,
      [DAY],
    );
    await db.query(
      `insert into ai_usage_counters (bucket, period_start, invocations)
       values ('hour', timestamptz '2026-10-24 11:00:00+00' + interval '1 millisecond', 5)
       on conflict (bucket, period_start) do update set invocations = 5`,
    );
    const rpm = await call("flash", "2026-10-24T11:00:00Z");
    expect(rpm).toMatchObject({ ok: false, code: "rpm" });
    const dayLeft = await rows<{ invocations: number }>(
      db,
      "select invocations from ai_usage_counters where bucket = 'day' and period_start = $1::timestamptz",
      [DAY],
    );
    expect(dayLeft[0]?.invocations).toBe(0);

    for (let n = 0; n < 15; n += 1) {
      expect((await call("lite", "2026-10-24T11:05:00Z")).ok).toBe(true);
    }
    expect(await call("lite", "2026-10-24T11:05:00Z")).toMatchObject({ ok: false, code: "rpm" });

    await db.query("select ai_close_model_day('flash', $1::timestamptz)", ["2026-10-24T12:00:00Z"]);
    expect(await call("flash", "2026-10-24T12:30:00Z")).toMatchObject({ ok: false, code: "day" });
    expect((await call("lite", "2026-10-24T12:30:00Z")).ok).toBe(true);
    expect(await call("nope", DAY)).toMatchObject({ ok: false, code: "invalid" });

    const privileges = await rows<{ anon: boolean; service: boolean }>(
      db,
      `select has_function_privilege('anon', 'ai_reserve_model_attempt(text,timestamptz)', 'execute') as anon,
              has_function_privilege('service_role', 'ai_reserve_model_attempt(text,timestamptz)', 'execute') as service`,
    );
    expect(privileges[0]).toEqual({ anon: false, service: true });

    const definitions = await rows<{ claim: string; reserve: string }>(
      db,
      `select pg_get_functiondef('ai_claim_citizens(uuid,integer,interval)'::regprocedure) as claim,
              pg_get_functiondef('ai_reserve_model_attempt(text,timestamptz)'::regprocedure) as reserve`,
    );
    expect(definitions[0]?.claim).toContain("4 minutes");
    expect(definitions[0]?.claim).not.toContain("2 minutes");
    expect(definitions[0]?.reserve.toLowerCase()).toContain("for update");
  }, 120_000);

  it("releases a deferred citizen and reclaims an expired lease without repeating a finished decision", async () => {
    await seedCitizens(db, 4);
    await initialize(db, 60);
    await db.exec("select world_ensure_minds()");
    const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 1, interval '300 seconds')",
      [run],
    );
    const citizen = first[0]?.claimed_citizen_id;
    expect(citizen).toBeTruthy();
    const lease = await rows<{ seconds: number }>(
      db,
      "select extract(epoch from (claimed_until - now()))::int as seconds from ai_citizen_claims where citizen_id = $1",
      [citizen],
    );
    expect(lease[0]!.seconds).toBeGreaterThan(180);
    expect(lease[0]!.seconds).toBeLessThanOrEqual(240);

    await db.query("select world_release_claim($1, $2, false)", [citizen, run]);
    const again = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 8, interval '300 seconds')",
      [next],
    );
    expect(again.map((row) => row.claimed_citizen_id)).toContain(citizen);

    await db.query("select world_release_claim($1, $2, true)", [citizen, next]);
    const blocked = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 8, interval '300 seconds')",
      [run],
    );
    expect(blocked.map((row) => row.claimed_citizen_id)).not.toContain(citizen);

    await db.query(
      "update ai_citizen_claims set last_decision_at = now() - interval '301 seconds', claimed_until = null where citizen_id = $1",
      [citizen],
    );
    const afterInterval = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 8, interval '300 seconds')",
      [run],
    );
    expect(afterInterval.map((row) => row.claimed_citizen_id)).toContain(citizen);

    await db.query(
      "update ai_citizen_claims set claimed_until = now() - interval '1 minute', last_decision_at = null where citizen_id = $1",
      [citizen],
    );
    const expired = await rows<{ claimed_citizen_id: string }>(
      db,
      "select claimed_citizen_id from ai_claim_citizens($1, 8, interval '300 seconds')",
      [next],
    );
    expect(expired.map((row) => row.claimed_citizen_id)).toContain(citizen);
  }, 120_000);
});

describe("runner admission", () => {
  it("reserves the first citizen attempt before the call and still releases the claim", () => {
    const runner = readFileSync("src/lib/ai/runner.ts", "utf8");
    expect(runner).toContain("attemptAlreadyReserved: true");
    expect(runner).toContain("reserveAttempt");
    expect(runner).toContain("world_release_claim");
    expect(runner).toContain("publishDecisionActivity");
    expect(runner).toContain("jail, detention, fines, and watch are disabled");
    expect(runner).not.toContain("sendTransaction");
    expect(runner).not.toContain("privateKey");
  });
});
