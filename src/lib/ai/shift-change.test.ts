import { describe, expect, it } from "vitest";
import { buildDecisionContext } from "@/lib/ai/context";
import { acceptMindChoice, buildMindMenu } from "@/lib/ai/mind-menu";
import { parseDecisionOutput } from "@/lib/ai/schema";
import { shiftBrief, shiftOfferFor, type ShiftRosterMember } from "@/lib/ai/shift-change";
import type { PersonalityTraits } from "@/lib/ai/personality";
import { BUILDINGS } from "@/lib/world/layout";
import type { BuildingView, CitizenView } from "@/lib/world/types";

const full = { food: 400, wood: 19, stone: 400, tools: 400 };

function site(id: string, name: string, kind: BuildingView["kind"]): BuildingView {
  return {
    id,
    kind,
    name,
    x: 1,
    y: 1,
    w: 4,
    h: 4,
    doorX: 1,
    doorY: 2,
    capacity: null,
    jobSlots: 7,
    role: "builder",
    openAir: kind === "farm",
    status: "under_construction",
    constructionProgress: 0,
    batchShifts: null,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: {},
    completedAt: null,
    updatedTick: 1,
  };
}

function worldBuildings(): BuildingView[] {
  return BUILDINGS.map((building) => ({
    id: building.id,
    kind: building.kind,
    name: building.name,
    x: building.rect.x,
    y: building.rect.y,
    w: building.rect.w,
    h: building.rect.h,
    doorX: building.door.x,
    doorY: building.door.y,
    capacity: building.capacity,
    jobSlots: building.jobSlots,
    role: building.role,
    openAir: building.open,
    status: "active" as const,
    constructionProgress: null,
    batchShifts: building.batchShifts,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: building.id === "storehouse" ? full : {},
    completedAt: null,
    updatedTick: 1,
  }));
}

function member(tokenId: string, role: ShiftRosterMember["role"], workId: string): ShiftRosterMember {
  return { tokenId, role, workId };
}

describe("shift changes", () => {
  const buildings = [
    ...worldBuildings(),
    site("house-18", "House 18", "house"),
    site("workshop-06", "Workshop E", "workshop"),
    site("farm-06", "South Meadows Expansion Farm", "farm"),
  ];
  const roster: ShiftRosterMember[] = [
    member("10", "farmer", "north-farm"),
    member("20", "farmer", "north-farm"),
    member("30", "farmer", "north-farm"),
    member("35", "farmer", "riverside-farm"),
    member("40", "woodcutter", "mossy-woods"),
    member("50", "stonecutter", "violet-quarry"),
    member("55", "stonecutter", "violet-quarry"),
    member("60", "crafter", "workshop-a"),
    member("70", "crafter", "workshop-a"),
  ];

  it("sends the first surplus workers onto unfinished buildings and the rest to the short good", () => {
    const first = shiftOfferFor({ tokenId: "20", role: "farmer", stock: full, buildings, roster });
    const second = shiftOfferFor({ tokenId: "30", role: "farmer", stock: full, buildings, roster });
    const third = shiftOfferFor({ tokenId: "55", role: "stonecutter", stock: full, buildings, roster });
    const wood = shiftOfferFor({ tokenId: "70", role: "crafter", stock: full, buildings, roster });
    expect(first).toMatchObject({ role: "builder", buildingId: "farm-06" });
    expect(second).toMatchObject({ role: "builder", buildingId: "house-18" });
    expect(third).toMatchObject({ role: "builder", buildingId: "workshop-06" });
    expect(wood).toMatchObject({ role: "woodcutter", buildingId: "mossy-woods", resource: "wood" });
    expect(wood?.reason).toMatch(/cap of 400/);
    expect(wood?.reason).toMatch(/wood is the short good at 19/);
  });

  it("keeps one worker on a full workplace and does not pull the short good's crew", () => {
    expect(shiftOfferFor({ tokenId: "10", role: "farmer", stock: full, buildings, roster })).toBeNull();
    expect(shiftOfferFor({ tokenId: "40", role: "woodcutter", stock: full, buildings, roster })).toBeNull();
  });

  it("does not leave a full good while that good is still below the cap", () => {
    const below = { food: 120, wood: 19, stone: 400, tools: 400 };
    expect(shiftOfferFor({ tokenId: "20", role: "farmer", stock: below, buildings, roster })).toBeNull();
  });

  it("staffs only as many builders as the storehouse can pay", () => {
    const thin = { food: 400, wood: 4, stone: 400, tools: 400 };
    const builder = shiftOfferFor({ tokenId: "20", role: "farmer", stock: thin, buildings, roster });
    const harvest = shiftOfferFor({ tokenId: "30", role: "farmer", stock: thin, buildings, roster });
    expect(builder).toMatchObject({ role: "builder" });
    expect(harvest).toMatchObject({ role: "woodcutter", resource: "wood" });
  });

  it("harvests instead of building when the storehouse cannot pay a builder shift", () => {
    const poor = { food: 400, wood: 2, stone: 400, tools: 400 };
    const offer = shiftOfferFor({ tokenId: "20", role: "farmer", stock: poor, buildings, roster });
    expect(offer).toMatchObject({ role: "woodcutter", resource: "wood" });
  });

  it("puts the change on the mind menu and refuses a different workplace", () => {
    const who: CitizenView = {
      tokenId: "20",
      name: "CHOG #20",
      origin: "founding",
      role: "farmer",
      homeId: "house-01",
      workId: "north-farm",
      activity: "idle",
      locationId: "north-farm",
      originId: null,
      destinationId: null,
      purpose: null,
      startedAt: "2026-11-07T00:00:00Z",
      endsAt: null,
      worldStartedS: 0,
      worldEndsS: null,
      shiftsToday: 0,
      dayIndex: 1,
      decisionSource: "simulation",
      updatedTick: 1,
    };
    const personality: PersonalityTraits = {
      sociability: 20,
      curiosity: 40,
      industriousness: 80,
      cooperation: 50,
      caution: 30,
      planning: 60,
      resourcefulness: 70,
      preferredActivity: "work",
    };
    const context = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: who,
      buildings,
      worldS: 12 * 3600,
      stock: full,
      personality,
      skills: [],
      goals: [],
      memories: [],
      canBuild: false,
      canBuildKinds: [],
    });
    const menu = buildMindMenu(context, { buildings, roster });
    expect(menu.actions).toContain("change_shift");
    expect(menu.shift?.role).toBe("builder");
    expect(menu.places.some((place) => place.action === "work" && place.buildingId === "north-farm")).toBe(false);
    expect(shiftBrief(who.role, full)).toMatch(/short good at 19/);
    const parsed = parseDecisionOutput(
      JSON.stringify({
        action: "change_shift",
        buildingId: "mossy-woods",
        buildKind: "none",
        summary: "Leave the farm for the woods.",
        rationale: "Food is full and wood is short.",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !menu.shift) return;
    const refused = acceptMindChoice(parsed.decision, context, menu);
    expect(refused.ok).toBe(false);
    const accepted = acceptMindChoice({ ...parsed.decision, buildingId: menu.shift.buildingId }, context, menu);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.decision.action).toBe("change_shift");
    expect(accepted.decision.buildingId).toBe(menu.shift.buildingId);
  });
});
