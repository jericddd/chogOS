import { describe, expect, it } from "vitest";
import type { PersonalityTraits } from "@/lib/ai/personality";
import { BUILDINGS } from "@/lib/world/layout";
import {
  FOOD_SHORTAGE_ACTIVATE,
  FOOD_SHORTAGE_RECOVER,
  STOREHOUSE_CAPACITY,
  TOOLS_SHORTAGE_ACTIVATE,
  TOOLS_SHORTAGE_RECOVER,
  WOOD_CONSTRUCTION_RECOVER,
  STONE_CONSTRUCTION_RECOVER,
  activeTownNeeds,
  describeTownNeedsBanner,
  evaluateTownNeeds,
  feasibleConstructKinds,
  preferredBuildKind,
  prioritizeTownActions,
} from "@/lib/world/needs";
import type { BuildingView, CitizenView, TownNeedView } from "@/lib/world/types";

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
    stock: {},
    completedAt: null,
    updatedTick: 0,
  }));
}

function stock(patch: { food?: number; wood?: number; stone?: number; tools?: number }) {
  return {
    food: patch.food ?? 80,
    wood: patch.wood ?? 60,
    stone: patch.stone ?? 40,
    tools: patch.tools ?? 20,
    vacantServedLots: 20,
    reservedLots: 6,
    buildings: buildings(),
  };
}

function farmer(): Pick<CitizenView, "role"> {
  return { role: "farmer" };
}

function merchant(): Pick<CitizenView, "role"> {
  return { role: "merchant" };
}

describe("town need detection", () => {
  it("activates food below 40 and tools below 4 from actual stock", () => {
    const hungry = evaluateTownNeeds(stock({ food: 12, tools: 20 }));
    const food = hungry.find((need) => need.needType === "food_shortage")!;
    expect(food.status).toBe("active");
    expect(food.evidence.food).toBe(12);
    expect(food.recommendedAction).toBe("work");
    const tools = evaluateTownNeeds(stock({ tools: 2 })).find((need) => need.needType === "tools_shortage")!;
    expect(tools.status).toBe("active");
    expect(tools.evidence.tools).toBe(2);
    expect(FOOD_SHORTAGE_ACTIVATE).toBe(40);
    expect(TOOLS_SHORTAGE_ACTIVATE).toBe(4);
    expect(FOOD_SHORTAGE_RECOVER).toBeLessThanOrEqual(STOREHOUSE_CAPACITY);
    expect(TOOLS_SHORTAGE_RECOVER).toBeLessThanOrEqual(STOREHOUSE_CAPACITY);
  });

  it("does not create a second active row for the same need type", () => {
    const first = evaluateTownNeeds(stock({ food: 10 }));
    const second = evaluateTownNeeds(stock({ food: 8 }), first);
    expect(activeTownNeeds(first)).toHaveLength(1);
    expect(activeTownNeeds(second)).toHaveLength(1);
    expect(second.filter((need) => need.needType === "food_shortage")).toHaveLength(1);
  });

  it("uses hysteresis so a bounce around the activate line does not resolve", () => {
    const active = evaluateTownNeeds(stock({ food: 10 }));
    const still = evaluateTownNeeds(stock({ food: 50 }), active);
    expect(still.find((need) => need.needType === "food_shortage")?.status).toBe("active");
    const recovered = evaluateTownNeeds(stock({ food: FOOD_SHORTAGE_RECOVER }), still);
    expect(recovered.find((need) => need.needType === "food_shortage")?.status).toBe("resolved");
    const bounce = evaluateTownNeeds(stock({ food: 50 }), recovered);
    expect(bounce.find((need) => need.needType === "food_shortage")?.status).toBe("resolved");
  });

  it("healthy stocks do not force construction", () => {
    const healthy = evaluateTownNeeds(stock({ food: 200, tools: 40, wood: 80, stone: 80 }));
    expect(activeTownNeeds(healthy)).toEqual([]);
    expect(preferredBuildKind({ food: 200, tools: 40 }, healthy, ["house", "farm", "workshop"])).toBe("none");
    const banner = describeTownNeedsBanner(healthy, true);
    expect(banner.tone).toBe("ok");
    expect(banner.title).toMatch(/no critical shortage/i);
  });

  it("marks missing construction materials as a real shortage without inventing stock", () => {
    const short = evaluateTownNeeds(stock({ wood: 1, stone: 0, food: 80, tools: 20 }));
    const materials = short.find((need) => need.needType === "materials_shortage")!;
    expect(materials.status).toBe("active");
    expect(materials.evidence.wood).toBe(1);
    expect(materials.evidence.stone).toBe(0);
    expect(preferredBuildKind({ food: 12, tools: 20 }, short, ["farm"])).toBe("none");
    const recovered = evaluateTownNeeds(
      stock({ wood: WOOD_CONSTRUCTION_RECOVER, stone: STONE_CONSTRUCTION_RECOVER, food: 80, tools: 20 }),
      short,
    );
    expect(recovered.find((need) => need.needType === "materials_shortage")?.status).toBe("resolved");
  });
});

describe("town need prioritization", () => {
  it("ranks farmer work over socializing when food is short", () => {
    const needs = evaluateTownNeeds(stock({ food: 12 }));
    const result = prioritizeTownActions({
      personality: sociable,
      rankedSeed: ["work", "socialize", "rest", "build"],
      citizen: farmer(),
      feasible: [{ action: "work" }, { action: "socialize" }],
      needs,
      canBuildKinds: ["farm"],
    });
    expect(result.suggested).toBe("work");
    expect(result.ranked[0]).toBe("work");
  });

  it("does not abandon an assigned merchant shift to build a farm", () => {
    const needs = evaluateTownNeeds(stock({ food: 12 }));
    const result = prioritizeTownActions({
      personality: sociable,
      rankedSeed: ["work", "socialize", "build"],
      citizen: merchant(),
      feasible: [{ action: "work" }, { action: "socialize" }],
      needs,
      canBuildKinds: ["farm"],
    });
    expect(result.suggested).toBe("work");
  });

  it("lets an off-shift citizen build a farm when food is short and construction is legal", () => {
    const needs = evaluateTownNeeds(stock({ food: 12 }));
    const result = prioritizeTownActions({
      personality: sociable,
      rankedSeed: ["socialize", "rest", "build"],
      citizen: merchant(),
      feasible: [{ action: "socialize" }, { action: "rest" }],
      needs,
      canBuildKinds: ["farm"],
    });
    expect(result.suggested).toBe("build");
    expect(preferredBuildKind({ food: 12, tools: 20 }, needs, ["farm", "workshop"])).toBe("farm");
  });

  it("does not suggest an unsupported action or a build that lacks materials", () => {
    const needs = evaluateTownNeeds(stock({ food: 12, wood: 0, stone: 0 }));
    const result = prioritizeTownActions({
      personality: sociable,
      rankedSeed: ["socialize", "rest"],
      citizen: { role: null },
      feasible: [{ action: "socialize" }],
      needs,
      canBuildKinds: [],
    });
    expect(result.suggested).toBe("socialize");
    expect(result.ranked.includes("transfer" as never)).toBe(false);
    expect(feasibleConstructKinds(buildings(), new Set(), { wood: 0, stone: 0 })).toEqual([]);
  });

  it("does not treat a proposal, queued intent, or completed farm as food", () => {
    const before = evaluateTownNeeds(stock({ food: 12 }));
    expect(before.find((need) => need.needType === "food_shortage")?.status).toBe("active");
    const afterProposal = evaluateTownNeeds(stock({ food: 12 }), before);
    expect(afterProposal.find((need) => need.needType === "food_shortage")?.status).toBe("active");
    const withFarm: TownNeedView[] = evaluateTownNeeds(
      {
        ...stock({ food: 12 }),
        buildings: [
          ...buildings(),
          {
            ...buildings()[0]!,
            id: "farm-03",
            kind: "farm",
            status: "active",
            constructionProgress: 100,
          },
        ],
      },
      before,
    );
    expect(withFarm.find((need) => need.needType === "food_shortage")?.status).toBe("active");
    expect(withFarm.find((need) => need.needType === "food_shortage")?.evidence.food).toBe(12);
  });
});
