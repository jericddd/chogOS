import { describe, expect, it } from "vitest";
import { BUILDINGS } from "@/lib/world/layout";
import {
  FOOD_SHORTAGE_ACTIVATE,
  FOOD_SHORTAGE_RECOVER,
  TOOLS_SHORTAGE_ACTIVATE,
} from "@/lib/world/needs";
import {
  createProjectDraft,
  eligibleProjectCandidates,
  factsFromWorld,
  housingPressure,
  proposeNewProjects,
  refreshSteps,
  shouldActivateProject,
  townProjectEvidence,
} from "@/lib/world/projects";
import type { BuildingView, CitizenView, TownNeedView, TownProjectView } from "@/lib/world/types";

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

function citizens(unassigned = 11, total = 59): Pick<CitizenView, "homeId" | "activity">[] {
  return Array.from({ length: total }, (_, i) => ({
    homeId: i < total - unassigned ? `house-0${(i % 12) + 1}` : null,
    activity: "idle" as const,
  }));
}

function needs(patch: Partial<Record<TownNeedView["needType"], TownNeedView["status"]>> = {}): TownNeedView[] {
  const types = ["food_shortage", "tools_shortage", "materials_shortage"] as const;
  return types.map((needType) => ({
    needType,
    status: patch[needType] ?? "inactive",
    priority: 0,
    firstDetectedAt: null,
    lastEvaluatedAt: null,
    lastStatusChangedAt: null,
    resolvedAt: null,
    evidence: {
      food: 400,
      wood: 400,
      stone: 400,
      tools: 400,
      vacantServedLots: 20,
      reservedLots: 6,
      farms: 2,
      workshops: 2,
      houses: 15,
      underConstruction: [],
    },
    blocker: null,
    recommendedAction: "none",
    recommendedKind: "none",
    lastEventId: null,
    lastDecisionId: null,
  }));
}

function facts(
  patch: {
    stock?: { food?: number; wood?: number; stone?: number; tools?: number };
    buildings?: BuildingView[];
    citizens?: Pick<CitizenView, "homeId" | "activity">[];
    vacantServedLots?: number;
    reservedLots?: number;
    placedStubIds?: readonly string[];
    servedPlotIds?: readonly string[];
    needs?: TownNeedView[];
  } = {},
) {
  return factsFromWorld({
    stock: {
      food: patch.stock?.food ?? 400,
      wood: patch.stock?.wood ?? 400,
      stone: patch.stock?.stone ?? 400,
      tools: patch.stock?.tools ?? 400,
    },
    buildings: patch.buildings ?? buildings(),
    citizens: patch.citizens ?? citizens(),
    vacantServedLots: patch.vacantServedLots ?? 20,
    reservedLots: patch.reservedLots ?? 6,
    placedStubIds: patch.placedStubIds ?? [],
    servedPlotIds: patch.servedPlotIds ?? [],
    needs: patch.needs ?? needs(),
  });
}

function withId(project: Omit<TownProjectView, "id">, id = "11111111-1111-4111-8111-111111111111"): TownProjectView {
  return { ...project, id };
}

describe("town project activation", () => {
  it("does not force construction when the town is healthy", () => {
    const healthy = facts();
    expect(shouldActivateProject("food_production", healthy)).toBe(false);
    expect(shouldActivateProject("tool_production", healthy)).toBe(false);
    expect(shouldActivateProject("residential", healthy)).toBe(false);
    expect(shouldActivateProject("territorial", healthy)).toBe(true);
    const created = proposeNewProjects(healthy);
    expect(created.map((project) => project.projectType)).toEqual(["territorial"]);
    expect(created[0]?.relatedRoadId).toBe("east-y2-64");
    expect(created[0]?.status).toBe("active");
    expect(created[0]?.recommendedAction).toBe("build");
    expect(created[0]?.recommendedKind).toBe("road");
  });

  it("uses authoritative stock for food and tool projects", () => {
    expect(
      shouldActivateProject(
        "food_production",
        facts({ stock: { food: FOOD_SHORTAGE_ACTIVATE - 1, tools: 20 }, needs: needs({ food_shortage: "active" }) }),
      ),
    ).toBe(true);
    expect(
      shouldActivateProject(
        "tool_production",
        facts({ stock: { food: 80, tools: TOOLS_SHORTAGE_ACTIVATE - 1 }, needs: needs({ tools_shortage: "active" }) }),
      ),
    ).toBe(true);
    expect(housingPressure(facts({ citizens: citizens(11) }))).toBe(false);
    expect(housingPressure(facts({ citizens: citizens(20) }))).toBe(true);
  });

  it("does not activate residential merely because vacant lots exist", () => {
    expect(shouldActivateProject("residential", facts({ vacantServedLots: 20, citizens: citizens(0) }))).toBe(false);
  });

  it("does not duplicate an open objective", () => {
    const first = withId(createProjectDraft("territorial", facts())!);
    expect(shouldActivateProject("territorial", facts(), [first])).toBe(false);
    expect(proposeNewProjects(facts(), [first])).toEqual([]);
  });
});

describe("town project steps", () => {
  it("keeps a territorial project on the road step until the overlay exists", () => {
    const draft = withId(createProjectDraft("territorial", facts())!);
    const still = refreshSteps(draft, facts(), "t1").project;
    expect(still.currentStepId).toBe("place_road");
    expect(still.steps.find((step) => step.id === "unlock_plot")?.status).toBe("pending");
    const afterRoad = refreshSteps(still, facts({ placedStubIds: ["east-y2-64"] }), "t2").project;
    expect(afterRoad.steps.find((step) => step.id === "place_road")?.status).toBe("completed");
    expect(afterRoad.steps.find((step) => step.id === "unlock_plot")?.status).toBe("blocked");
    expect(afterRoad.status).toBe("blocked");
    const unlocked = refreshSteps(
      afterRoad,
      facts({ placedStubIds: ["east-y2-64"], servedPlotIds: ["plot-64-2"], reservedLots: 5 }),
      "t3",
    ).project;
    expect(unlocked.status).toBe("completed");
    expect(unlocked.steps.every((step) => step.status === "completed" || step.status === "skipped")).toBe(true);
  });

  it("does not treat a queued intent as a placed road or finished building", () => {
    const territorial = withId(createProjectDraft("territorial", facts())!);
    expect(refreshSteps(territorial, facts(), "t1").project.currentStepId).toBe("place_road");
    const food = withId(
      createProjectDraft(
        "food_production",
        facts({ stock: { food: 12 }, needs: needs({ food_shortage: "active" }) }),
      )!,
    );
    expect(food.steps.find((step) => step.id === "place_building")?.status).toBe("skipped");
    expect(food.currentStepId).toBe("observe_production");
    expect(food.status).toBe("active");
    const still = refreshSteps(food, facts({ stock: { food: 12 }, needs: needs({ food_shortage: "active" }) }), "t2").project;
    expect(still.status).toBe("active");
    expect(still.currentStepId).toBe("observe_production");
  });

  it("completes an existing-farm food project only after stock recovers", () => {
    const food = withId(
      createProjectDraft(
        "food_production",
        facts({ stock: { food: 12 }, needs: needs({ food_shortage: "active" }) }),
      )!,
    );
    const recovered = refreshSteps(
      food,
      facts({ stock: { food: FOOD_SHORTAGE_RECOVER }, needs: needs({ food_shortage: "resolved" }) }),
      "t3",
    ).project;
    expect(recovered.status).toBe("completed");
  });

  it("requires a real production batch when a new workplace was started", () => {
    const hungry = facts({
      stock: { food: 12, wood: 60, stone: 40 },
      needs: needs({ food_shortage: "active" }),
      buildings: buildings().filter((building) => building.kind !== "farm"),
    });
    const food = withId(createProjectDraft("food_production", hungry)!);
    expect(food.steps.find((step) => step.id === "place_building")?.status).toBe("eligible");
    const started = refreshSteps(
      food,
      {
        ...hungry,
        buildings: [
          ...hungry.buildings,
          { id: "farm-1", kind: "farm", status: "under_construction", batchesCompleted: 0, completedAt: null },
        ],
      },
      "t2",
    ).project;
    expect(started.steps.find((step) => step.id === "place_building")?.status).toBe("completed");
    expect(started.currentStepId).toBe("complete_building");
    const active = refreshSteps(
      started,
      {
        ...hungry,
        buildings: [{ id: "farm-1", kind: "farm", status: "active", batchesCompleted: 0, completedAt: "t3" }],
      },
      "t3",
    ).project;
    expect(active.currentStepId).toBe("observe_production");
    expect(active.status).toBe("blocked");
    const produced = refreshSteps(
      active,
      {
        ...hungry,
        food: 12,
        buildings: [{ id: "farm-1", kind: "farm", status: "active", batchesCompleted: 1, completedAt: "t3" }],
      },
      "t4",
    ).project;
    expect(produced.status).toBe("completed");
  });

  it("exposes only eligible actions as AI candidates", () => {
    const project = withId(createProjectDraft("territorial", facts())!);
    const candidates = eligibleProjectCandidates([project]);
    expect(candidates).toEqual([
      expect.objectContaining({
        action: "build",
        buildKind: "road",
        roadStubId: "east-y2-64",
        stepId: "place_road",
      }),
    ]);
    const blocked = refreshSteps(project, facts({ stock: { wood: 0, stone: 0 } }), "t1").project;
    expect(eligibleProjectCandidates([blocked])).toEqual([]);
  });

  it("keeps evidence numeric and does not invent a shortage", () => {
    const evidence = townProjectEvidence(facts());
    expect(evidence.food).toBe(400);
    expect(evidence.reservedLots).toBe(6);
    expect(evidence.placedStubIds).toEqual([]);
  });
});
