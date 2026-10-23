import { describe, expect, it, vi } from "vitest";
import { buildDecisionContext } from "@/lib/ai/context";
import { acceptMindChoice, buildMindMenu, isStickyRejection } from "@/lib/ai/mind-menu";
import { citizenDeadlineMs, fetchWithDeadline, finishBeforeDeadline, withTimeout } from "@/lib/ai/invocation";
import { createGeminiProvider } from "@/lib/ai/providers/gemini";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { readAppConfig } from "@/lib/config/env";
import { BUILDINGS } from "@/lib/world/layout";
import { progressBond } from "@/lib/world/relationships";
import { constructionKindsForShortage, resourcePressures } from "@/lib/world/shortage";
import type { BuildingView, CitizenView } from "@/lib/world/types";
import type { PersonalityTraits } from "@/lib/ai/personality";

const industrious: PersonalityTraits = {
  sociability: 20,
  curiosity: 40,
  industriousness: 80,
  cooperation: 50,
  caution: 30,
  planning: 60,
  resourcefulness: 70,
  preferredActivity: "work",
};

function citizen(patch: Partial<CitizenView> = {}): CitizenView {
  return {
    tokenId: "7",
    name: "Test",
    origin: "founding",
    role: "woodcutter",
    homeId: "house-01",
    workId: "mossy-woods",
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

function buildings(extra: BuildingView[] = []): BuildingView[] {
  const base: BuildingView[] = BUILDINGS.map((b) => ({
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
    stock: b.kind === "storehouse" ? { food: 80, wood: 60, stone: 40, tools: 20 } : ({} as Record<string, number>),
    completedAt: null,
    updatedTick: 0,
  }));
  return [...base, ...extra];
}

function park(): BuildingView {
  return {
    id: "park-01",
    kind: "park",
    name: "Willow Park",
    x: 40,
    y: 20,
    w: 4,
    h: 3,
    doorX: 41,
    doorY: 20,
    capacity: null,
    jobSlots: null,
    role: null,
    openAir: true,
    status: "active",
    constructionProgress: null,
    batchShifts: null,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: {},
    completedAt: null,
    updatedTick: 1,
  };
}

function bank(): BuildingView {
  return { ...park(), id: "chog-bank", kind: "bank", name: "ChogBank", openAir: false };
}

function contextFor(stock: { food: number; wood: number; stone: number; tools: number }, who = citizen(), places = buildings()) {
  return buildDecisionContext({
    citizenId: "11111111-1111-4111-8111-111111111111",
    citizen: who,
    buildings: places,
    worldS: 12 * 3600,
    stock,
    personality: industrious,
    skills: [{ name: "gathering", level: 2, experience: 4 }],
    goals: [],
    memories: [],
    canBuild: true,
    vacantServedLots: 4,
    reservedLots: 2,
    canBuildKinds: ["house", "farm", "workshop", "park", "amusement", "bank"],
  });
}

describe("mind repair", () => {
  it("returns before a hung call and bounds one provider request", async () => {
    const hung = new Promise<string>(() => {});
    const settled = await finishBeforeDeadline(hung, () => "partial", 30);
    expect(settled).toBe("partial");
    await expect(withTimeout(hung, 20, "database")).rejects.toThrow(/database timed out after 20ms/);
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    await expect(fetchWithDeadline(25)("https://db.example/rest")).rejects.toThrow(/database timed out after 25ms/);
    vi.unstubAllGlobals();

    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) fail();
          signal?.addEventListener("abort", fail);
        }),
    );
    const config = readAppConfig({
      AI_PROVIDER: "gemini",
      AI_API_KEY: "test-key",
      AI_MODEL: "gemini-3.8-flash",
    } as unknown as NodeJS.ProcessEnv);
    await expect(
      createGeminiProvider(config).complete({
        purpose: "citizen_turn",
        messages: [{ role: "user", content: "choose" }],
        timeoutMs: 40,
      }),
    ).rejects.toMatchObject({ code: "timeout", halt: false });
    vi.unstubAllGlobals();
  });

  it("keeps a tail of the runtime for wallet review", () => {
    expect(citizenDeadlineMs(200_000)).toBe(152_000);
    expect(citizenDeadlineMs(80_000)).toBeLessThan(80_000);
    expect(200_000 - citizenDeadlineMs(200_000)).toBeGreaterThanOrEqual(45_000);
  });

  it("changes construction choices when wood is short and restores them when it recovers", () => {
    const open = ["house", "farm", "workshop", "park", "bank"] as const;
    const critical = constructionKindsForShortage(open, { food: 80, wood: 1, stone: 40, tools: 20 });
    expect(critical).toEqual([]);
    const low = constructionKindsForShortage(open, { food: 80, wood: 8, stone: 40, tools: 20 });
    expect(low).toEqual(["farm", "workshop"]);
    expect(low).not.toContain("park");
    const recovered = constructionKindsForShortage(open, { food: 80, wood: 20, stone: 20, tools: 20 });
    expect(recovered).toEqual(["house", "farm", "workshop", "park", "bank"]);
    const wood = resourcePressures({ food: 10, wood: 1, stone: 40, tools: 20 }).find((item) => item.resource === "wood");
    expect(wood?.severity).toBe("critical");
    expect(wood?.gatherRole).toBe("woodcutter");
  });

  it("rejects an impossible build and still offers a feasible alternative", () => {
    const rich = contextFor({ food: 80, wood: 40, stone: 40, tools: 20 }, citizen(), buildings([park(), bank()]));
    const menu = buildMindMenu(rich);
    expect(menu.actions).toContain("work");
    expect(menu.buildKinds).not.toContain("jail");
    const impossible = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildKind: "jail",
        placeName: "Lockup",
        summary: "Raise a jail.",
        rationale: "A sentence needs a room.",
      }),
    );
    expect(impossible.ok).toBe(true);
    if (!impossible.ok) return;
    const refused = acceptMindChoice(impossible.decision, rich, menu);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/disabled/);
    expect(isStickyRejection(refused.reason)).toBe(true);
    const work = parseDecisionOutput(
      JSON.stringify({
        action: "work",
        buildingId: "mossy-woods",
        buildKind: "none",
        summary: "Cut wood at the Mossy Woods.",
        rationale: "The storehouse can use another gathering shift.",
      }),
    );
    expect(work.ok).toBe(true);
    if (!work.ok) return;
    const accepted = acceptMindChoice(work.decision, rich, menu);
    expect(accepted.ok).toBe(true);
  });

  it("lets a citizen visit a park and records a bank visit as simulated", () => {
    const world = contextFor({ food: 80, wood: 40, stone: 40, tools: 20 }, citizen(), buildings([park(), bank()]));
    const menu = buildMindMenu(world);
    expect(menu.places.some((place) => place.action === "socialize" && place.buildingId === "park-01")).toBe(true);
    expect(menu.places.some((place) => place.action === "visit" && place.buildingId === "chog-bank")).toBe(true);
    const visit = parseDecisionOutput(
      JSON.stringify({
        action: "visit",
        buildingId: "chog-bank",
        buildKind: "none",
        summary: "Read the public books at ChogBank.",
        rationale: "The books are open and no payment is needed.",
      }),
    );
    expect(visit.ok).toBe(true);
    if (!visit.ok) return;
    const accepted = acceptMindChoice(visit.decision, world, menu);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.decision.action).toBe("visit");
    expect(accepted.decision.economy).toBeNull();
    expect(JSON.stringify(accepted.decision)).not.toMatch(/txHash|distribute/);
  });

  it("requires repeated mutual interest before dating", () => {
    const base = {
      actorSociability: 70,
      partnerSociability: 80,
      actorCooperation: 60,
      partnerCooperation: 50,
      actorInitiated: true,
      partnerInitiated: false,
      eitherDatingElsewhere: false,
    };
    expect(progressBond({ ...base, meetings: 1 }).dating).toBe(false);
    expect(progressBond({ ...base, meetings: 1 }).stage).toBe("met");
    expect(progressBond({ ...base, meetings: 6, partnerInitiated: true }).stage).toBe("dating");
    const oneSided = progressBond({ ...base, meetings: 8, partnerSociability: 10, partnerInitiated: true });
    expect(oneSided.dating).toBe(false);
    expect(oneSided.stage).toBe("familiar");
    const taken = progressBond({ ...base, meetings: 8, partnerInitiated: true, eitherDatingElsewhere: true });
    expect(taken.stage).toBe("interested");
    expect(taken.dating).toBe(false);
  });
});
