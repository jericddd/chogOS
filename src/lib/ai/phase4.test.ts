import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateBudget, haltFromError, usagePeriods } from "@/lib/ai/budget";
import { buildDecisionContext } from "@/lib/ai/context";
import { preferredFeasibleAction, rankActions, type PersonalityTraits } from "@/lib/ai/personality";
import { createGeminiProvider, geminiEndpoint } from "@/lib/ai/providers/gemini";
import { createProviderFromConfig } from "@/lib/ai/resolve";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { AiProviderError } from "@/lib/ai/types";
import { aiStatusLabel, readAppConfig } from "@/lib/config/env";
import { validateProposal } from "@/lib/world/actions";
import { planHousePlacement, surveyedPlots } from "@/lib/world/placement";
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
      messages: [{ role: "user", content: "choose" }],
      responseSchema: { type: "object" },
    });
    expect(completion.provider).toBe("gemini");
    expect(completion.model).toBe("gemini-3.8-flash");
    expect(geminiEndpoint("gemini-3.8-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const firstCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const init = firstCall[1];
    const body = JSON.parse(String(init.body)) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  });

  it("halts on quota and billing errors and never switches provider", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded daily" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchSpy);
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
    } as unknown as NodeJS.ProcessEnv);
    await expect(createGeminiProvider(config).complete({ purpose: "x", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
      code: "quota",
      halt: true,
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Please enable billing to continue" } }), { status: 403 }),
    );
    await expect(createGeminiProvider(config).complete({ purpose: "x", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
      code: "billing",
      halt: true,
    });
    expect(config.aiProvider).toBe("gemini");
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
  it("stops new inference when the hourly or daily cap is reached", () => {
    const config = readAppConfig({} as NodeJS.ProcessEnv);
    expect(config.aiMaxDecisionsPerHour).toBe(12);
    expect(config.aiRunnerEnabled).toBe(false);
    expect(aiStatusLabel(config)).toBe("Awaiting AI activation");
    expect(
      aiStatusLabel(
        readAppConfig({ AI_PROVIDER: "gemini", AI_RUNNER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv),
      ),
    ).toBe("AI mind on Gemini");
    expect(
      evaluateBudget(config, { hourInvocations: 12, dayInvocations: 1, haltUntil: null, haltReason: null }).ok,
    ).toBe(false);
    expect(
      evaluateBudget(config, { hourInvocations: 0, dayInvocations: 48, haltUntil: null, haltReason: null }).ok,
    ).toBe(false);
    const halt = haltFromError(new AiProviderError("quota", "quota", true), new Date("2026-10-14T12:00:00Z"));
    expect(halt?.until).toBe("2026-10-15T00:00:00.000Z");
    expect(usagePeriods(new Date("2026-10-14T12:34:00Z")).hour).toBe("2026-10-14T12:00:00.000Z");
  });
});

describe("construction placement", () => {
  it("uses a road-served plot and rejects overlap, without inventing coordinates", () => {
    const plots = surveyedPlots();
    expect(plots.filter((plot) => plot.served).length).toBe(9);
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
    });
    expect(context.memories.length).toBeLessThanOrEqual(8);
    expect(context.feasible.some((option) => option.action === "work" && option.buildingId === "workshop-a")).toBe(true);
    expect(context.suggested).toBe("work");
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
  });
});
