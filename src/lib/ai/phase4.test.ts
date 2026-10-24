import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateBudget, haltFromError, isRetriableHaltReason, usagePeriods } from "@/lib/ai/budget";
import { buildDecisionContext, decisionMessages } from "@/lib/ai/context";
import { CONSTRUCT_KINDS } from "@/lib/world/layout";
import { acceptGrowth, growthBlocker, landCanGrow } from "@/lib/ai/growth";
import { describePlace } from "@/lib/ai/place";
import { preferredFeasibleAction, rankActions, type PersonalityTraits } from "@/lib/ai/personality";
import {
  AI_INVOCATION_DEADLINE_MS,
  AI_INVOCATION_DEADLINE_SHORT_MS,
  FREE_TIER_REQUEST_GAP_MS,
  awaitFreeTierSlot,
  deadlineForRequest,
  freeTierWaitMs,
  timeoutWithinDeadline,
} from "@/lib/ai/invocation";
import {
  createGeminiProvider,
  GEMINI_HOBBY_MODEL,
  geminiEndpoint,
  geminiModelsToTry,
  geminiThinkingConfig,
} from "@/lib/ai/providers/gemini";
import { createProviderFromConfig } from "@/lib/ai/resolve";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { AiProviderError } from "@/lib/ai/types";
import { aiStatusLabel, readAppConfig } from "@/lib/config/env";
import { validateProposal } from "@/lib/world/actions";
import { planConstruction, planHousePlacement, surveyedPlots } from "@/lib/world/placement";
import { BUILDINGS } from "@/lib/world/layout";
import type { BuildingView, CitizenView } from "@/lib/world/types";

const industrious: PersonalityTraits = {
  sociability: 10,
  curiosity: 10,
  industriousness: 90,
  cooperation: 20,
  caution: 15,
  planning: 40,
  resourcefulness: 70,
  preferredActivity: "work",
};

const sociable: PersonalityTraits = {
  sociability: 92,
  curiosity: 20,
  industriousness: 12,
  cooperation: 80,
  caution: 20,
  planning: 15,
  resourcefulness: 30,
  preferredActivity: "socialize",
};

function citizen(patch: Partial<CitizenView> = {}): CitizenView {
  return {
    tokenId: "7",
    name: "Test",
    origin: "founding",
    role: "crafter",
    homeId: "house-01",
    workId: "workshop-a",
    activity: "idle",
    locationId: "commons-square",
    originId: null,
    destinationId: null,
    purpose: null,
    startedAt: "2026-10-13T00:00:00Z",
    endsAt: null,
    worldStartedS: 12 * 3600,
    worldEndsS: null,
    shiftsToday: 0,
    dayIndex: 0,
    decisionSource: "simulation",
    updatedTick: 1,
    ...patch,
  };
}

function buildings(): BuildingView[] {
  return BUILDINGS.map((b) => ({
    id: b.id,
    kind: b.kind,
    name: b.name,
    x: b.rect.x,
    y: b.rect.y,
    w: b.rect.w,
    h: b.rect.h,
    doorX: b.door.x,
    doorY: b.door.y,
    capacity: b.capacity,
    jobSlots: b.jobSlots,
    role: b.role,
    openAir: b.open,
    status: b.initialStatus,
    constructionProgress: b.initialStatus === "under_construction" ? 0 : null,
    batchShifts: b.batchShifts,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: b.kind === "storehouse" ? { food: 80, wood: 60, stone: 40, tools: 0 } : ({} as Record<string, number>),
    completedAt: null,
    updatedTick: 0,
  }));
}

describe("personalities", () => {
  it("ranks different actions for different traits given the same options", () => {
    const options = ["work", "socialize", "rest"] as const;
    expect(preferredFeasibleAction(industrious, options)).toBe("work");
    expect(preferredFeasibleAction(sociable, options)).toBe("socialize");
    expect(rankActions(industrious, options)[0]).not.toBe(rankActions(sociable, options)[0]);
  });
});

describe("structured decisions", () => {
  it("accepts a bounded action and rejects code, URLs, and unknown actions", () => {
    const ok = parseDecisionOutput(
      JSON.stringify({
        action: "socialize",
        buildingId: "commons-square",
        summary: "Meet neighbours at the square.",
        rationale: "Sociability is high and the square is open.",
      }),
    );
    expect(ok.ok).toBe(true);
    expect(parseDecisionOutput(`not json`).ok).toBe(false);
    expect(parseDecisionOutput(JSON.stringify({ action: "transfer", buildingId: "market", summary: "x", rationale: "y" })).ok).toBe(false);
    expect(
      parseDecisionOutput(
        JSON.stringify({ action: "work", buildingId: "workshop-a", summary: "see https://evil.test", rationale: "no" }),
      ).ok,
    ).toBe(false);
    expect(validateProposal({ tokenId: "7", action: "work", buildingId: "workshop-a", source: "ai" }).ok).toBe(false);
    const farm = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "farm",
        x: 114,
        y: 4,
        summary: "Raise a farm for food.",
        rationale: "Storehouse food is low.",
      }),
    );
    expect(farm.ok).toBe(true);
    if (farm.ok) {
      expect(farm.decision.buildKind).toBe("farm");
      expect(farm.decision.buildingId).toBe("");
      expect(farm.decision.activationMotive).toBeNull();
      expect(farm.decision).not.toHaveProperty("x");
    }
    expect(
      parseDecisionOutput(
        JSON.stringify({ action: "build", buildingId: "", buildKind: "road", summary: "Lay a road.", rationale: "Reach the woods." }),
      ).ok,
    ).toBe(false);
    const inventedRoad = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "road",
        roadStubId: "invented-path",
        summary: "Lay a road.",
        rationale: "Reach the woods.",
      }),
    );
    expect(inventedRoad.ok).toBe(true);
    if (inventedRoad.ok) {
      expect(inventedRoad.decision.roadStubId).toBe("invented-path");
    }
    const road = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "road",
        roadStubId: "east-y2-64",
        x: 99,
        y: 1,
        tiles: [{ x: 1, y: 1 }],
        summary: "Extend the east road.",
        rationale: "Unlock a reserved lot.",
      }),
    );
    expect(road.ok).toBe(true);
    if (road.ok) {
      expect(road.decision.buildKind).toBe("road");
      expect(road.decision.roadStubId).toBe("east-y2-64");
      expect(road.decision.projectId).toBeNull();
      expect(road.decision).not.toHaveProperty("x");
      expect(road.decision).not.toHaveProperty("tiles");
    }
    const withProject = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "road",
        roadStubId: "east-y2-64",
        projectId: "11111111-1111-4111-8111-111111111111",
        coordinates: { x: 1, y: 2 },
        summary: "Advance the town project.",
        rationale: "The engine listed this stub as eligible.",
      }),
    );
    expect(withProject.ok).toBe(true);
    if (withProject.ok) {
      expect(withProject.decision.projectId).toBe("11111111-1111-4111-8111-111111111111");
      expect(withProject.decision).not.toHaveProperty("coordinates");
    }
    expect(
      parseDecisionOutput(
        JSON.stringify({ action: "build", buildingId: "", summary: "Build something.", rationale: "The town should grow." }),
      ).ok,
    ).toBe(false);
  });
});

describe("Gemini adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the official generateContent URL and structured JSON schema", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"action":"rest","buildingId":"house-01","summary":"Rest.","rationale":"Night."}' }] } }],
          usageMetadata: { candidatesTokenCount: 12 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      AI_MODEL: "gemini-3.8-flash",
    } as unknown as NodeJS.ProcessEnv);
    const completion = await createGeminiProvider(config).complete({
      purpose: "citizen_turn",
      reserveAttempt: async () => {},
      messages: [{ role: "user", content: "choose" }],
      responseSchema: { type: "object" },
    });
    expect(completion.provider).toBe("gemini");
    expect(completion.model).toBe(GEMINI_HOBBY_MODEL);
    expect(geminiModelsToTry("gemini-3.8-flash", "citizen_turn")).toEqual([GEMINI_HOBBY_MODEL]);
    expect(geminiModelsToTry("gemini-3.8-flash", "treasury_allocation")).toEqual(["gemini-3.8-flash"]);
    expect(geminiModelsToTry("gemini-3.8-flash")).toEqual(["gemini-3.8-flash"]);
    expect(geminiThinkingConfig(GEMINI_HOBBY_MODEL)).toEqual({ thinkingLevel: "MINIMAL" });
    expect(geminiThinkingConfig("gemini-3.8-flash")).toEqual({ thinkingLevel: "LOW" });
    const firstCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toContain(`/models/${GEMINI_HOBBY_MODEL}:generateContent`);
    expect(geminiEndpoint("gemini-3.8-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const init = firstCall[1];
    const body = JSON.parse(String(init.body)) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  });

  it("halts on quota and billing errors and never switches provider", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded daily" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);
    await expect(
      createGeminiProvider(config).complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({
      code: "quota",
      halt: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Please enable billing to continue" } }), { status: 403 }),
    );
    await expect(
      createGeminiProvider(config).complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({
      code: "billing",
      halt: true,
    });
    expect(config.aiProvider).toBe("gemini");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("closes the day only for an explicit daily 429 and backs off on minute, token, and unclear 429s", async () => {
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);

    async function refusal(body: unknown, status = 429) {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      vi.stubGlobal("fetch", fetchSpy);
      const settled = await createGeminiProvider(config)
        .complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] })
        .then(
          () => ({ code: "ok", halt: false }),
          (error: unknown) =>
            error instanceof AiProviderError
              ? { code: error.code, halt: error.halt }
              : { code: "other", halt: false },
        );
      return { ...settled, fetches: fetchSpy.mock.calls.length };
    }

    const stock = "You exceeded your current quota, please check your plan and billing details.";
    await expect(
      refusal({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: stock,
          details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
        },
      }),
    ).resolves.toEqual({ code: "quota", halt: false, fetches: 1 });

    await expect(
      refusal({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: stock,
          details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }],
        },
      }),
    ).resolves.toEqual({ code: "rate_limit", halt: false, fetches: 1 });

    await expect(
      refusal({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: stock,
          details: [{ violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }] }],
        },
      }),
    ).resolves.toEqual({ code: "rate_limit", halt: false, fetches: 1 });

    await expect(
      refusal({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }),
    ).resolves.toEqual({ code: "rate_limit", halt: false, fetches: 1 });

    await expect(
      refusal({
        error: {
          message: stock,
          details: [
            {
              violations: [
                { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
                { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
              ],
            },
          ],
        },
      }),
    ).resolves.toEqual({ code: "rate_limit", halt: false, fetches: 1 });

    await expect(
      refusal({ error: { message: "Please enable billing to continue" } }, 429),
    ).resolves.toEqual({ code: "billing", halt: true, fetches: 1 });
  });

  it("retries a single Gemini 503 and reserves both attempts", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"action":"rest","summary":"Rest.","rationale":"Night."}' }] } }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    let reserved = 0;
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);
    const completion = await createGeminiProvider(config).complete({
      purpose: "x",
      reserveAttempt: async () => {
        reserved += 1;
      },
      messages: [{ role: "user", content: "x" }],
    });
    expect(completion.text).toContain("rest");
    expect(completion.model).toBe("gemini-3.8-flash");
    expect(reserved).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("gemini-3.8-flash");
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("gemini-3.8-flash");
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("flash-lite");
  });

  it("does not call Flash when a routine Lite model is missing", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "model is not found" } }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      AI_MODEL: "gemini-3.8-flash",
    } as unknown as NodeJS.ProcessEnv);
    await expect(
      createGeminiProvider(config).complete({
        purpose: "citizen_turn",
        reserveAttempt: async () => {},
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "unavailable", halt: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls as unknown[][])[0]?.[0])).toContain(GEMINI_HOBBY_MODEL);
    expect(String((fetchSpy.mock.calls as unknown[][])[0]?.[0])).not.toContain("gemini-3.8-flash");
  });

  it("keeps a later routine turn on Lite and sends treasury only to Flash", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"action":"rest","summary":"Rest.","rationale":"Night."}' }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      AI_MODEL: "gemini-3.8-flash",
    } as unknown as NodeJS.ProcessEnv);
    const provider = createGeminiProvider(config);
    const first = await provider.complete({
      purpose: "citizen_turn",
      reserveAttempt: async () => {},
      messages: [{ role: "user", content: "x" }],
    });
    const second = await provider.complete({
      purpose: "citizen_turn",
      reserveAttempt: async () => {},
      messages: [{ role: "user", content: "y" }],
    });
    const treasury = await provider.complete({
      purpose: "treasury_allocation",
      reserveAttempt: async () => {},
      messages: [{ role: "user", content: "allocate" }],
    });
    expect(first.model).toBe(GEMINI_HOBBY_MODEL);
    expect(second.model).toBe(GEMINI_HOBBY_MODEL);
    expect(treasury.model).toBe("gemini-3.8-flash");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String((fetchSpy.mock.calls as unknown[][])[0]?.[0])).toContain(GEMINI_HOBBY_MODEL);
    expect(String((fetchSpy.mock.calls as unknown[][])[1]?.[0])).toContain(GEMINI_HOBBY_MODEL);
    expect(String((fetchSpy.mock.calls as unknown[][])[2]?.[0])).toContain("gemini-3.8-flash");
  });

  it("surfaces Gemini HTTP 400 body text and does not halt", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid argument: responseSchema" } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);
    const error = await createGeminiProvider(config)
      .complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: "invalid", halt: false });
    expect(String(error)).toMatch(/invalid argument: responseSchema/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not halt the mind when a Gemini model id is missing", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "model is not found" } }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      AI_MODEL: "gemini-2.5-flash",
    } as unknown as NodeJS.ProcessEnv);
    await expect(
      createGeminiProvider(config).complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "unavailable", halt: false });
    expect(isRetriableHaltReason("The configured Gemini model is not available to this account.")).toBe(true);
    expect(isRetriableHaltReason("Gemini free-tier quota is exhausted. New inference is halted.")).toBe(false);
  });

  it("does not retry a timed-out Gemini request", async () => {
    const fetchSpy = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);
    await expect(
      createGeminiProvider(config).complete({ purpose: "x", reserveAttempt: async () => {}, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "timeout", halt: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call Ajax or an unconfigured provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      createProviderFromConfig(readAppConfig({ AI_PROVIDER: "ajax" } as unknown as NodeJS.ProcessEnv)).complete({
        purpose: "tick",
        messages: [],
      }),
    ).rejects.toThrow(/no request was sent/i);
    await expect(
      createProviderFromConfig(readAppConfig({ AI_PROVIDER: "none" } as unknown as NodeJS.ProcessEnv)).complete({
        purpose: "tick",
        messages: [],
      }),
    ).rejects.toThrow(/No AI provider/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("budgets", () => {
  it("stops new inference when the hourly or daily cap is reached", async () => {
    const config = readAppConfig({} as NodeJS.ProcessEnv);
    expect(config.aiMaxDecisionsPerHour).toBe(60);
    expect(config.aiMaxDecisionsPerDay).toBe(500);
    expect(config.aiDecisionsPerRun).toBe(8);
    expect(config.aiMinDecisionIntervalSeconds).toBe(300);
    expect(config.aiRequestTimeoutMs).toBe(40_000);
    expect(config.aiMaxOutputTokens).toBe(2048);
    expect(AI_INVOCATION_DEADLINE_MS).toBe(200_000);
    expect(AI_INVOCATION_DEADLINE_SHORT_MS).toBe(80_000);
    expect(deadlineForRequest(new Request("http://x"))).toBe(AI_INVOCATION_DEADLINE_SHORT_MS);
    expect(deadlineForRequest(new Request("http://x", { headers: { "x-chog-ai-wait": "long" } }))).toBe(
      AI_INVOCATION_DEADLINE_MS,
    );
    expect(timeoutWithinDeadline(0, 20_000, 76_000, AI_INVOCATION_DEADLINE_SHORT_MS)).toBeNull();
    expect(FREE_TIER_REQUEST_GAP_MS).toBe(12_000);
    expect(timeoutWithinDeadline(0, 20_000, 40_000)).toBe(20_000);
    expect(timeoutWithinDeadline(0, 40_000, AI_INVOCATION_DEADLINE_MS - 10_000)).toBe(7_500);
    expect(timeoutWithinDeadline(0, 20_000, AI_INVOCATION_DEADLINE_MS - 4_000)).toBeNull();
    expect(freeTierWaitMs(0, 1_000)).toBe(0);
    expect(freeTierWaitMs(1_000, 5_000)).toBe(8_000);
    expect(freeTierWaitMs(1_000, 13_000)).toBe(0);
    const slept: number[] = [];
    const tooLate = AI_INVOCATION_DEADLINE_MS - 10_000;
    await expect(
      awaitFreeTierSlot(tooLate - 6_000, 0, 20_000, tooLate, async (ms) => {
        slept.push(ms);
      }),
    ).resolves.toBeNull();
    expect(slept).toEqual([]);
    await expect(
      awaitFreeTierSlot(1_000, 0, 20_000, 5_000, async (ms) => {
        slept.push(ms);
      }),
    ).resolves.toEqual({ startedAtMs: 13_000, timeoutMs: 20_000 });
    expect(slept).toEqual([8_000]);
    const overridden = readAppConfig({
      AI_DECISIONS_PER_RUN: "1",
      AI_MAX_DECISIONS_PER_HOUR: "12",
      AI_MAX_DECISIONS_PER_DAY: "20",
    } as unknown as NodeJS.ProcessEnv);
    expect(overridden.aiDecisionsPerRun).toBe(1);
    expect(overridden.aiMaxDecisionsPerHour).toBe(12);
    expect(overridden.aiMaxDecisionsPerDay).toBe(20);
    expect(config.aiRunnerEnabled).toBe(false);
    expect(aiStatusLabel(config)).toBe("Awaiting AI activation");
    expect(
      aiStatusLabel(
        readAppConfig({ AI_PROVIDER: "gemini", AI_RUNNER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv),
      ),
    ).toBe("AI mind on Gemini");
    expect(
      evaluateBudget(config, { hourInvocations: 60, dayInvocations: 1, haltUntil: null, haltReason: null }).ok,
    ).toBe(false);
    expect(
      evaluateBudget(config, { hourInvocations: 59, dayInvocations: 1, haltUntil: null, haltReason: null }).ok,
    ).toBe(true);
    expect(
      evaluateBudget(config, { hourInvocations: 0, dayInvocations: 500, haltUntil: null, haltReason: null }).ok,
    ).toBe(false);
    const halt = haltFromError(new AiProviderError("quota", "quota", true), new Date("2026-10-14T12:00:00Z"));
    expect(halt?.until).toBe("2026-10-15T00:00:00.000Z");
    expect(usagePeriods(new Date("2026-10-14T12:34:00Z")).hour).toBe("2026-10-14T12:00:00.000Z");
  });
});

describe("construction placement", () => {
  it("uses a road-served plot and rejects overlap, without inventing coordinates", () => {
    const plots = surveyedPlots();
    expect(plots.filter((plot) => plot.served).length).toBe(20);
    expect(plots.filter((plot) => plot.rect.y === 2).every((plot) => !plot.served)).toBe(true);
    const views = buildings();
    const first = planHousePlacement(views);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.plan.rect.w).toBe(3);
    expect(first.plan.routes.length).toBe(views.length * 2);
    const occupied = new Set([first.plan.plotId]);
    const withHouse = [
      ...views,
      {
        ...views[0]!,
        id: first.plan.buildingId,
        x: first.plan.rect.x,
        y: first.plan.rect.y,
        w: 3,
        h: 3,
        doorX: first.plan.door.x,
        doorY: first.plan.door.y,
        kind: "house" as const,
        status: "under_construction" as const,
        constructionProgress: 0,
      },
    ];
    expect(planHousePlacement(withHouse, occupied).ok).toBe(true);
    expect(planHousePlacement(withHouse, new Set(plots.filter((p) => p.served).map((p) => p.id))).ok).toBe(false);
    const farm = planConstruction(views, new Set(), "farm");
    expect(farm.ok).toBe(true);
    if (farm.ok) {
      expect(farm.plan.kind).toBe("farm");
      expect(farm.plan.buildingId).toMatch(/^farm-\d+$/);
    }
    expect(planConstruction(views, new Set(), "workshop").ok).toBe(true);
  });
});

describe("decision context", () => {
  it("only offers actions the precheck would allow and keeps memory bounded", () => {
    const context = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 0 },
      personality: industrious,
      skills: [{ name: "crafting", level: 4, experience: 60 }],
      goals: [{ id: "g", kind: "skill_craft", title: "Craft", status: "active", progress: 10 }],
      memories: Array.from({ length: 20 }, (_, i) => ({
        content: `memory ${i}`,
        outcome: i === 0 ? "rejected" : "success",
        importance: i,
        relatedBuildingId: "workshop-a",
      })),
      canBuild: true,
      vacantServedLots: 20,
      reservedLots: 6,
    });
    expect(context.memories.length).toBeLessThanOrEqual(8);
    expect(context.feasible.some((option) => option.action === "work" && option.buildingId === "workshop-a")).toBe(true);
    expect(context.suggested).toBe("work");
    expect(context.walletActivation.state).toBe("unassigned");
    expect(context.walletActivation.eligibleToRequest).toBe(false);
    expect(context.construction.validKinds).toEqual([...CONSTRUCT_KINDS]);
    expect(context.construction.suggestedBuildKind).toBe("workshop");
    const hungry = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 12, tools: 0 },
      personality: industrious,
      skills: [],
      goals: [],
      memories: [],
      canBuild: true,
      vacantServedLots: 20,
      reservedLots: 6,
    });
    expect(hungry.construction.suggestedBuildKind).toBe("farm");
    expect(hungry.stock.food).toBe(12);
    expect(context.townNeeds.some((need) => need.needType === "tools_shortage" && need.status === "active")).toBe(true);
    expect(hungry.townNeeds.some((need) => need.needType === "food_shortage" && need.status === "active")).toBe(true);
    const socialFarmer = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen({ role: "farmer", workId: "north-farm" }),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 12, tools: 20 },
      personality: sociable,
      skills: [],
      goals: [],
      memories: [],
      canBuild: true,
      vacantServedLots: 20,
      reservedLots: 6,
    });
    expect(socialFarmer.suggested).toBe("work");
    expect(socialFarmer.feasible.some((option) => option.action === "socialize")).toBe(true);
    const night = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 22 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 0 },
      personality: industrious,
      skills: [],
      goals: [],
      memories: [],
      canBuild: false,
    });
    expect(night.feasible.some((option) => option.action === "work")).toBe(false);
    const withRoad = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 20 },
      personality: industrious,
      skills: [],
      goals: [],
      memories: [],
      canBuild: false,
      eligibleRoadStubs: [{ id: "east-y2-64", name: "East spur to plot 64,2", servesPlotIds: ["plot-64-2"] }],
    });
    expect(withRoad.canBuild).toBe(true);
    expect(withRoad.construction.roads.canBuildRoad).toBe(true);
    expect(withRoad.townProjects).toEqual([]);
    const messages = decisionMessages(withRoad, 8000);
    expect(messages.system).toContain("how this town grows");
    expect(messages.system).toContain("placeName");
    expect(messages.system).toContain("roadStubId");
    expect(messages.system).not.toContain("Choose only from the feasible actions");
    expect(messages.system).toContain("Do not return propose_economy or request_wallet_activation");
    expect(messages.user).toContain("east-y2-64");
    expect(messages.user).toContain("East spur to plot 64,2");
    expect(messages.user).not.toContain("\"feasible\"");
    expect(messages.user).not.toContain("\"suggested\"");
    expect(messages.user).not.toContain("\"ranked\"");
    const place = describePlace(withRoad);
    expect(place).toContain("Open lots that already touch a road");
    expect(place).toContain("Founding Town");
    expect(place).toContain("Mossy Woods");
    expect(place).toContain("shelter");
    expect(place).not.toContain("Choose only from");
  });

  it("keeps a growth judgment and refuses a daily action without substituting one", () => {
    const open = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 20 },
      personality: industrious,
      skills: [],
      goals: [],
      memories: [],
      canBuild: true,
      vacantServedLots: 26,
      reservedLots: 0,
      eligibleRoadStubs: [{ id: "east-y2-64", name: "East spur to plot 64,2", servesPlotIds: ["plot-64-2"] }],
    });
    expect(landCanGrow(open)).toBe(true);
    const farm = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "farm",
        placeName: "South Meadow Field",
        summary: "Raise another farm on the open road-connected land.",
        rationale: "Two farms already stand in the west and twenty-six lots on the roads are still empty.",
      }),
    );
    expect(farm.ok).toBe(true);
    if (farm.ok) {
      const accepted = acceptGrowth(farm.decision, open);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.decision.buildKind).toBe("farm");
        expect(accepted.decision.placeName).toBe("South Meadow Field");
        expect(accepted.decision.summary).toContain("another farm");
      }
    }
    const unnamed = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "farm",
        summary: "Raise a farm.",
        rationale: "The lots are empty.",
      }),
    );
    expect(unnamed.ok).toBe(true);
    if (unnamed.ok) {
      const refused = acceptGrowth(unnamed.decision, open);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toContain("name the place");
      }
    }
    const named = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "road",
        roadStubId: "East spur to plot 64,2",
        summary: "Lay the unbuilt east spur.",
        rationale: "The description says that survey has not been built.",
      }),
    );
    expect(named.ok).toBe(true);
    if (named.ok) {
      const accepted = acceptGrowth(named.decision, open);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.decision.roadStubId).toBe("east-y2-64");
      }
    }
    const visit = parseDecisionOutput(
      JSON.stringify({
        action: "socialize",
        buildingId: "commons-square",
        summary: "Meet at the square.",
        rationale: "People are nearby.",
      }),
    );
    expect(visit.ok).toBe(true);
    if (visit.ok) {
      const refused = acceptGrowth(visit.decision, open);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toContain("daily life");
      }
    }
    const invented = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildingId: "",
        buildKind: "road",
        roadStubId: "east-y2-64",
        summary: "Lay a road.",
        rationale: "Reach new land.",
      }),
    );
    expect(invented.ok).toBe(true);
    if (invented.ok) {
      const full = buildDecisionContext({
        citizenId: "11111111-1111-4111-8111-111111111111",
        citizen: citizen(),
        buildings: buildings(),
        worldS: 12 * 3600,
        stock: { wood: 60, stone: 40, food: 400, tools: 400 },
        personality: industrious,
        skills: [],
        goals: [],
        memories: [],
        canBuild: true,
        vacantServedLots: 26,
        reservedLots: 0,
        completedRoadIds: ["east-y2-64"],
      });
      expect(acceptGrowth(invented.decision, full).ok).toBe(false);
    }
    const poor = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: buildings(),
      worldS: 12 * 3600,
      stock: { wood: 0, stone: 0, food: 80, tools: 20 },
      personality: industrious,
      skills: [],
      goals: [],
      memories: [],
      canBuild: false,
      vacantServedLots: 26,
    });
    expect(landCanGrow(poor)).toBe(false);
    expect(growthBlocker(poor)).toContain("storehouse");
  });
});
