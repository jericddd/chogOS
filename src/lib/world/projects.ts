/**
 * Phase 5d town development projects. The engine decides whether a project
 * exists, which step is eligible, and when a step is complete. The model may
 * choose among eligible next actions. It cannot invent types, coordinates, or
 * completion.
 *
 * Thresholds and activation rules stay in lockstep with
 * supabase/migrations/20261016220000_phase5d_town_projects.sql.
 */
import type { PersonalityTraits, RankedAction } from "@/lib/ai/personality";
import { CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";
import {
  CONSTRUCTION_SHIFT_STONE,
  CONSTRUCTION_SHIFT_WOOD,
  FOOD_SHORTAGE_ACTIVATE,
  FOOD_SHORTAGE_RECOVER,
  TOOLS_SHORTAGE_ACTIVATE,
  TOOLS_SHORTAGE_RECOVER,
  activeTownNeeds,
  materialsAllowBuilderShift,
} from "@/lib/world/needs";
import { ROAD_STUBS, ROAD_STUB_STONE, ROAD_STUB_WOOD } from "@/lib/world/roads";
import type {
  BuildingView,
  CitizenView,
  TownNeedStatus,
  TownNeedType,
  TownNeedView,
  TownProjectBuildKind,
  TownProjectEvidence,
  TownProjectStatus,
  TownProjectStepStatus,
  TownProjectStepView,
  TownProjectType,
  TownProjectView,
  TownRecommendedAction,
} from "@/lib/world/types";

export const MAX_OPEN_TOWN_PROJECTS = 2;

export const TOWN_PROJECT_TYPES = [
  "food_production",
  "tool_production",
  "residential",
  "territorial",
] as const;

export const TOWN_PROJECT_STATUSES = [
  "proposed",
  "active",
  "blocked",
  "completed",
  "abandoned",
  "cancelled",
] as const;

export const OPEN_TOWN_PROJECT_STATUSES: readonly TownProjectStatus[] = ["proposed", "active", "blocked"];

export const TOWN_PROJECT_PRIORITY: Record<TownProjectType, number> = {
  food_production: 100,
  tool_production: 80,
  residential: 50,
  territorial: 30,
};

export type TownProjectFacts = {
  food: number;
  wood: number;
  stone: number;
  tools: number;
  vacantServedLots: number;
  reservedLots: number;
  farms: number;
  workshops: number;
  houses: number;
  houseBeds: number;
  pendingHouseBeds: number;
  assignedResidents: number;
  unassignedCitizens: number;
  farmBatches: number;
  workshopBatches: number;
  underConstruction: Array<{ id: string; kind: string; progress: number | null }>;
  placedStubIds: readonly string[];
  servedPlotIds: readonly string[];
  needStatus: Partial<Record<TownNeedType, TownNeedStatus>>;
  buildings: readonly Pick<BuildingView, "id" | "kind" | "status" | "batchesCompleted" | "completedAt">[];
};

function asStock(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function countKind(
  buildings: readonly Pick<BuildingView, "kind">[],
  kind: ConstructKind,
): number {
  return buildings.filter((building) => building.kind === kind).length;
}

export function townProjectEvidence(facts: TownProjectFacts): TownProjectEvidence {
  return {
    food: asStock(facts.food),
    wood: asStock(facts.wood),
    stone: asStock(facts.stone),
    tools: asStock(facts.tools),
    vacantServedLots: Math.max(0, Math.floor(facts.vacantServedLots)),
    reservedLots: Math.max(0, Math.floor(facts.reservedLots)),
    farms: Math.max(0, Math.floor(facts.farms)),
    workshops: Math.max(0, Math.floor(facts.workshops)),
    houses: Math.max(0, Math.floor(facts.houses)),
    underConstruction: facts.underConstruction.slice(0, 8),
    houseBeds: Math.max(0, Math.floor(facts.houseBeds)),
    pendingHouseBeds: Math.max(0, Math.floor(facts.pendingHouseBeds)),
    assignedResidents: Math.max(0, Math.floor(facts.assignedResidents)),
    unassignedCitizens: Math.max(0, Math.floor(facts.unassignedCitizens)),
    farmBatches: Math.max(0, Math.floor(facts.farmBatches)),
    workshopBatches: Math.max(0, Math.floor(facts.workshopBatches)),
    placedStubIds: [...facts.placedStubIds].slice(0, 12),
  };
}

export function factsFromWorld(input: {
  stock: { food: number; wood: number; stone: number; tools: number };
  buildings: readonly BuildingView[];
  citizens: readonly Pick<CitizenView, "homeId" | "activity">[];
  vacantServedLots: number;
  reservedLots: number;
  placedStubIds?: readonly string[];
  servedPlotIds?: readonly string[];
  needs?: readonly Pick<TownNeedView, "needType" | "status">[];
}): TownProjectFacts {
  const houses = input.buildings.filter((building) => building.kind === "house");
  const activeHouses = houses.filter((building) => building.status === "active");
  const pendingHouses = houses.filter((building) => building.status === "under_construction");
  const present = input.citizens.filter((citizen) => citizen.activity !== "unavailable");
  const needStatus: Partial<Record<TownNeedType, TownNeedStatus>> = {};
  for (const need of input.needs ?? []) {
    needStatus[need.needType] = need.status;
  }
  return {
    food: input.stock.food,
    wood: input.stock.wood,
    stone: input.stock.stone,
    tools: input.stock.tools,
    vacantServedLots: input.vacantServedLots,
    reservedLots: input.reservedLots,
    farms: countKind(input.buildings, "farm"),
    workshops: countKind(input.buildings, "workshop"),
    houses: houses.length,
    houseBeds: activeHouses.reduce((sum, house) => sum + (house.capacity ?? 0), 0),
    pendingHouseBeds: pendingHouses.reduce((sum, house) => sum + (house.capacity ?? 0), 0),
    assignedResidents: present.filter((citizen) => Boolean(citizen.homeId)).length,
    unassignedCitizens: present.filter((citizen) => !citizen.homeId).length,
    farmBatches: input.buildings
      .filter((building) => building.kind === "farm")
      .reduce((sum, farm) => sum + farm.batchesCompleted, 0),
    workshopBatches: input.buildings
      .filter((building) => building.kind === "workshop")
      .reduce((sum, shop) => sum + shop.batchesCompleted, 0),
    underConstruction: input.buildings
      .filter((building) => building.status === "under_construction")
      .slice(0, 8)
      .map((building) => ({
        id: building.id,
        kind: building.kind,
        progress: building.constructionProgress,
      })),
    placedStubIds: input.placedStubIds ?? [],
    servedPlotIds: input.servedPlotIds ?? [],
    needStatus,
    buildings: input.buildings.map((building) => ({
      id: building.id,
      kind: building.kind,
      status: building.status,
      batchesCompleted: building.batchesCompleted,
      completedAt: building.completedAt,
    })),
  };
}

function needOpen(facts: TownProjectFacts, type: TownNeedType): boolean {
  const status = facts.needStatus[type];
  if (status === "active" || status === "blocked") {
    return true;
  }
  if (type === "food_shortage") {
    return facts.food < FOOD_SHORTAGE_ACTIVATE;
  }
  if (type === "tools_shortage") {
    return facts.tools < TOOLS_SHORTAGE_ACTIVATE;
  }
  return false;
}

function needRecovered(facts: TownProjectFacts, type: TownNeedType): boolean {
  if (type === "food_shortage") {
    return facts.food >= FOOD_SHORTAGE_RECOVER;
  }
  if (type === "tools_shortage") {
    return facts.tools >= TOOLS_SHORTAGE_RECOVER;
  }
  return false;
}

function materialsOk(facts: TownProjectFacts): boolean {
  return facts.wood >= CONSTRUCTION_SHIFT_WOOD && facts.stone >= CONSTRUCTION_SHIFT_STONE;
}

function roadMaterialsOk(facts: TownProjectFacts): boolean {
  return facts.wood >= ROAD_STUB_WOOD && facts.stone >= ROAD_STUB_STONE;
}

function kindReady(facts: TownProjectFacts, kind: ConstructKind): boolean {
  if (kind === "farm") {
    return facts.farms > 0 || facts.underConstruction.some((site) => site.kind === "farm");
  }
  if (kind === "workshop") {
    return facts.workshops > 0 || facts.underConstruction.some((site) => site.kind === "workshop");
  }
  return facts.underConstruction.some((site) => site.kind === kind);
}

function nextTerritorialStub(facts: TownProjectFacts, existing: readonly TownProjectView[]): {
  stubId: string;
  plotId: string;
  name: string;
} | null {
  const used = new Set(
    existing
      .filter(
        (project) =>
          project.projectType === "territorial" &&
          (OPEN_TOWN_PROJECT_STATUSES.includes(project.status) || project.status === "completed"),
      )
      .map((project) => project.relatedRoadId ?? project.objectiveKey.replace(/^territorial:/, "")),
  );
  for (const stub of ROAD_STUBS) {
    if (facts.placedStubIds.includes(stub.id) || used.has(stub.id)) {
      continue;
    }
    const plotId = stub.servesPlotIds[0];
    if (!plotId) {
      continue;
    }
    if (facts.servedPlotIds.includes(plotId)) {
      continue;
    }
    return { stubId: stub.id, plotId, name: stub.name };
  }
  return null;
}

function openProjects(existing: readonly TownProjectView[]): TownProjectView[] {
  return existing.filter((project) => OPEN_TOWN_PROJECT_STATUSES.includes(project.status));
}

function hasOpenType(existing: readonly TownProjectView[], type: TownProjectType): boolean {
  return openProjects(existing).some((project) => project.projectType === type);
}

export function housingPressure(facts: TownProjectFacts): boolean {
  return facts.unassignedCitizens > facts.pendingHouseBeds;
}

export function shouldActivateProject(
  type: TownProjectType,
  facts: TownProjectFacts,
  existing: readonly TownProjectView[] = [],
): boolean {
  if (hasOpenType(existing, type)) {
    return false;
  }
  if (openProjects(existing).length >= MAX_OPEN_TOWN_PROJECTS) {
    return false;
  }
  if (type === "food_production") {
    return needOpen(facts, "food_shortage");
  }
  if (type === "tool_production") {
    return needOpen(facts, "tools_shortage");
  }
  if (type === "residential") {
    return housingPressure(facts) && (facts.vacantServedLots > 0 || facts.reservedLots > 0);
  }
  if (facts.reservedLots <= 0) {
    return false;
  }
  return nextTerritorialStub(facts, existing) !== null;
}

function step(input: {
  id: string;
  title: string;
  status?: TownProjectStepStatus;
  action?: TownRecommendedAction;
  buildKind?: TownProjectBuildKind;
  roadStubId?: string | null;
  plotId?: string | null;
  buildingId?: string | null;
  skipped?: boolean;
  blocker?: string | null;
}): TownProjectStepView {
  const skipped = input.skipped ?? false;
  return {
    id: input.id,
    title: input.title,
    status: input.status ?? (skipped ? "skipped" : "pending"),
    action: input.action ?? "none",
    buildKind: input.buildKind ?? "none",
    roadStubId: input.roadStubId ?? null,
    plotId: input.plotId ?? null,
    buildingId: input.buildingId ?? null,
    blocker: input.blocker ?? null,
    skipped,
    completedAt: null,
    eventId: null,
  };
}

export function planProjectSteps(
  type: TownProjectType,
  facts: TownProjectFacts,
  extra: { stubId?: string; plotId?: string } = {},
): TownProjectStepView[] {
  if (type === "territorial") {
    const stubId = extra.stubId ?? nextTerritorialStub(facts, [])?.stubId ?? "east-y2-64";
    const plotId = extra.plotId ?? ROAD_STUBS.find((stub) => stub.id === stubId)?.servesPlotIds[0] ?? null;
    return [
      step({
        id: "place_road",
        title: `Place catalog road ${stubId}`,
        action: "build",
        buildKind: "road",
        roadStubId: stubId,
        plotId,
      }),
      step({
        id: "verify_connection",
        title: "Verify the overlay is persisted and connected",
        roadStubId: stubId,
        plotId,
      }),
      step({
        id: "unlock_plot",
        title: plotId ? `Wait until ${plotId} is road-served` : "Wait until the lot is road-served",
        plotId,
        roadStubId: stubId,
      }),
    ];
  }

  if (type === "food_production" || type === "tool_production") {
    const kind: ConstructKind = type === "food_production" ? "farm" : "workshop";
    const ready = kindReady(facts, kind);
    return [
      step({
        id: "confirm_need",
        title: type === "food_production" ? "Confirm the food shortage from Storehouse stock" : "Confirm the tool shortage from Storehouse stock",
        status: "completed",
        skipped: false,
      }),
      step({
        id: "ensure_lot",
        title: ready ? "Existing workplaces cover this need" : "Wait for a vacant road-served lot",
        skipped: ready,
        status: ready ? "skipped" : "pending",
      }),
      step({
        id: "place_building",
        title: ready ? `${kind} capacity already exists` : `Start a ${kind} on a served lot`,
        action: ready ? "none" : "build",
        buildKind: ready ? "none" : kind,
        skipped: ready,
        status: ready ? "skipped" : "pending",
      }),
      step({
        id: "complete_building",
        title: ready ? "No new building is required" : `Finish the ${kind}`,
        skipped: ready,
        status: ready ? "skipped" : "pending",
      }),
      step({
        id: "observe_production",
        title: type === "food_production" ? "Wait for a real food batch or recovered stock" : "Wait for a real tool batch or recovered stock",
        action: "work",
      }),
    ];
  }

  return [
    step({
      id: "confirm_housing",
      title: "Confirm citizens without a house assignment exceed unfinished house beds",
      status: "completed",
    }),
    step({
      id: "ensure_lot",
      title: "Wait for a vacant road-served lot",
    }),
    step({
      id: "place_building",
      title: "Start a house on a served lot",
      action: "build",
      buildKind: "house",
    }),
    step({
      id: "complete_building",
      title: "Finish the house",
    }),
    step({
      id: "assign_residents",
      title: "Wait until a citizen is assigned to the new house",
    }),
  ];
}

function describeProject(type: TownProjectType, facts: TownProjectFacts, extra: { stubId?: string; plotId?: string }): {
  name: string;
  description: string;
  justification: string;
  needType: TownNeedType | null;
  objectiveKey: string;
} {
  if (type === "food_production") {
    return {
      name: "Expand food production",
      description: "Improve food capacity only while Storehouse food is actually short. A finished farm is not food.",
      justification: `Storehouse food is ${facts.food} (shortage below ${FOOD_SHORTAGE_ACTIVATE}, recovers at ${FOOD_SHORTAGE_RECOVER}).`,
      needType: "food_shortage",
      objectiveKey: "food_production",
    };
  }
  if (type === "tool_production") {
    return {
      name: "Expand tool production",
      description: "Improve tool capacity only while Storehouse tools are actually short. A finished workshop is not tools.",
      justification: `Storehouse tools are ${facts.tools} (shortage below ${TOOLS_SHORTAGE_ACTIVATE}, recovers at ${TOOLS_SHORTAGE_RECOVER}).`,
      needType: "tools_shortage",
      objectiveKey: "tool_production",
    };
  }
  if (type === "residential") {
    return {
      name: "Expand housing assignments",
      description: "Add a house only when citizens without a house assignment exceed unfinished house beds. Commons Hall remains a valid shelter.",
      justification: `${facts.unassignedCitizens} citizens have no house assignment and ${facts.pendingHouseBeds} beds are already under construction.`,
      needType: null,
      objectiveKey: "residential",
    };
  }
  const stubId = extra.stubId ?? "east-y2-64";
  const plotId = extra.plotId ?? "plot-64-2";
  return {
    name: `Open ${plotId}`,
    description: "Place a catalog road stub so a reserved surveyed lot can be served. Forest and meadow stay scenery.",
    justification: `${facts.reservedLots} reserved lots remain. Catalog stub ${stubId} is the next unused spur.`,
    needType: null,
    objectiveKey: `territorial:${stubId}`,
  };
}

export function createProjectDraft(
  type: TownProjectType,
  facts: TownProjectFacts,
  existing: readonly TownProjectView[] = [],
  now: string | null = null,
): Omit<TownProjectView, "id"> | null {
  if (!shouldActivateProject(type, facts, existing)) {
    return null;
  }
  const extra: { stubId?: string; plotId?: string } =
    type === "territorial" ? (nextTerritorialStub(facts, existing) ?? {}) : {};
  const copy = describeProject(type, facts, extra);
  const steps = planProjectSteps(type, facts, extra);
  const advanced = refreshSteps(
    {
      id: "draft",
      projectType: type,
      objectiveKey: copy.objectiveKey,
      name: copy.name,
      description: copy.description,
      status: "proposed",
      priority: TOWN_PROJECT_PRIORITY[type],
      needType: copy.needType,
      justification: copy.justification,
      steps,
      currentStepId: steps[0]?.id ?? null,
      currentStepIndex: 0,
      blocker: null,
      recommendedAction: "none",
      recommendedKind: "none",
      recommendedStubId: extra.stubId ?? null,
      relatedBuildingId: null,
      relatedPlotId: extra.plotId ?? null,
      relatedRoadId: extra.stubId ?? null,
      relatedCitizenId: null,
      evidence: townProjectEvidence(facts),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastEvaluatedAt: now,
      lastEventId: null,
      lastDecisionId: null,
    },
    facts,
    now,
  );
  return advanced.project;
}

const CONSTRUCTION_ORDER: TownProjectType[] = [
  "food_production",
  "tool_production",
  "residential",
  "territorial",
];

export function proposeNewProjects(
  facts: TownProjectFacts,
  existing: readonly TownProjectView[] = [],
  now: string | null = null,
): Array<Omit<TownProjectView, "id">> {
  const created: Array<Omit<TownProjectView, "id">> = [];
  let current = [...existing];
  for (const type of CONSTRUCTION_ORDER) {
    const draft = createProjectDraft(type, facts, current, now);
    if (!draft) {
      continue;
    }
    created.push(draft);
    current = [...current, { ...draft, id: `draft-${type}-${created.length}` }];
  }
  return created;
}

function firstIncomplete(steps: readonly TownProjectStepView[]): number {
  return steps.findIndex((item) => item.status !== "completed" && item.status !== "skipped");
}

function materialsBlocker(facts: TownProjectFacts, road: boolean): string | null {
  if (road) {
    return roadMaterialsOk(facts) ? null : "not enough wood and stone for a catalog road";
  }
  return materialsOk(facts) ? null : "not enough wood and stone for a construction shift";
}

function lotBlocker(facts: TownProjectFacts): string | null {
  if (facts.vacantServedLots > 0) {
    return null;
  }
  if (facts.reservedLots > 0) {
    return "waiting for a road-served lot";
  }
  return "no vacant road-served lot";
}

function relatedBuilding(
  project: TownProjectView,
  facts: TownProjectFacts,
  kind: ConstructKind,
): (typeof facts.buildings)[number] | undefined {
  if (project.relatedBuildingId) {
    return facts.buildings.find((building) => building.id === project.relatedBuildingId);
  }
  return facts.buildings.find(
    (building) =>
      building.kind === kind &&
      (building.status === "under_construction" || Boolean(building.completedAt)) &&
      !["north-farm", "riverside-farm", "workshop-a", "workshop-b", "house-01", "house-02", "house-03", "house-04", "house-05", "house-06", "house-07", "house-08", "house-09", "house-10", "house-11", "house-12", "house-13", "house-14", "house-15"].includes(
        building.id,
      ),
  );
}

function evaluateStep(
  project: TownProjectView,
  stepView: TownProjectStepView,
  facts: TownProjectFacts,
): { status: TownProjectStepStatus; blocker: string | null; buildingId: string | null } {
  if (stepView.status === "completed" || stepView.status === "skipped") {
    return { status: stepView.status, blocker: null, buildingId: stepView.buildingId };
  }

  if (stepView.id === "confirm_need" || stepView.id === "confirm_housing") {
    return { status: "completed", blocker: null, buildingId: null };
  }

  if (stepView.id === "ensure_lot") {
    const blocker = lotBlocker(facts);
    if (!blocker) {
      return { status: "completed", blocker: null, buildingId: null };
    }
    return { status: "blocked", blocker, buildingId: null };
  }

  if (stepView.id === "place_road") {
    const stubId = stepView.roadStubId ?? project.relatedRoadId;
    if (stubId && facts.placedStubIds.includes(stubId)) {
      return { status: "completed", blocker: null, buildingId: null };
    }
    const blocker = materialsBlocker(facts, true) ?? (stubId ? null : "no catalog road stub remains");
    if (blocker) {
      return { status: "blocked", blocker, buildingId: null };
    }
    return { status: "eligible", blocker: null, buildingId: null };
  }

  if (stepView.id === "verify_connection") {
    const stubId = stepView.roadStubId ?? project.relatedRoadId;
    if (stubId && facts.placedStubIds.includes(stubId)) {
      return { status: "completed", blocker: null, buildingId: null };
    }
    return { status: "blocked", blocker: "road overlay is not persisted yet", buildingId: null };
  }

  if (stepView.id === "unlock_plot") {
    const stubId = stepView.roadStubId ?? project.relatedRoadId;
    if (!stubId || !facts.placedStubIds.includes(stubId)) {
      return { status: "blocked", blocker: "a proposed road is not a placed road", buildingId: null };
    }
    const plotId = stepView.plotId ?? project.relatedPlotId;
    if (plotId && facts.servedPlotIds.includes(plotId)) {
      return { status: "completed", blocker: null, buildingId: null };
    }
    return { status: "blocked", blocker: "the lot door does not yet touch a connected road", buildingId: null };
  }

  if (stepView.id === "place_building") {
    const kind = stepView.buildKind;
    if (kind === "none" || kind === "road" || !(CONSTRUCT_KINDS as readonly string[]).includes(kind)) {
      return { status: "skipped", blocker: null, buildingId: null };
    }
    const building = relatedBuilding(project, facts, kind);
    if (building) {
      return { status: "completed", blocker: null, buildingId: building.id };
    }
    const lot = lotBlocker(facts);
    if (lot) {
      return { status: "blocked", blocker: lot, buildingId: null };
    }
    const materials = materialsBlocker(facts, false);
    if (materials) {
      return { status: "blocked", blocker: materials, buildingId: null };
    }
    return { status: "eligible", blocker: null, buildingId: null };
  }

  if (stepView.id === "complete_building") {
    const kind = (project.steps.find((item) => item.id === "place_building")?.buildKind ?? "none") as TownProjectBuildKind;
    if (kind === "none" || kind === "road" || !(CONSTRUCT_KINDS as readonly string[]).includes(kind)) {
      return { status: "skipped", blocker: null, buildingId: project.relatedBuildingId };
    }
    const building = relatedBuilding(project, facts, kind);
    if (building?.status === "active") {
      return { status: "completed", blocker: null, buildingId: building.id };
    }
    if (building) {
      return { status: "blocked", blocker: "construction is still in progress", buildingId: building.id };
    }
    return { status: "blocked", blocker: "no building has started", buildingId: null };
  }

  if (stepView.id === "observe_production") {
    const kind = project.projectType === "tool_production" ? "workshop" : "farm";
    const built = relatedBuilding(project, facts, kind);
    const recovered = needRecovered(facts, kind === "farm" ? "food_shortage" : "tools_shortage");
    if (built) {
      if (built.status !== "active") {
        return { status: "blocked", blocker: "the new workplace is not complete", buildingId: built.id };
      }
      if (built.batchesCompleted > 0) {
        return { status: "completed", blocker: null, buildingId: built.id };
      }
      return { status: "blocked", blocker: "waiting for a real production batch", buildingId: built.id };
    }
    if (recovered) {
      return { status: "completed", blocker: null, buildingId: null };
    }
    return { status: "eligible", blocker: null, buildingId: null };
  }

  if (stepView.id === "assign_residents") {
    const house = relatedBuilding(project, facts, "house");
    if (!house || house.status !== "active") {
      return { status: "blocked", blocker: "the house is not complete", buildingId: house?.id ?? null };
    }
    if (!housingPressure(facts) || facts.assignedResidents > 0) {
      return { status: "completed", blocker: null, buildingId: house.id };
    }
    return { status: "blocked", blocker: "waiting for a house assignment", buildingId: house.id };
  }

  return { status: stepView.status, blocker: stepView.blocker, buildingId: stepView.buildingId };
}

function recommendedFromStep(stepView: TownProjectStepView | undefined): {
  action: TownRecommendedAction;
  kind: TownProjectBuildKind;
  stubId: string | null;
} {
  if (!stepView || stepView.status !== "eligible") {
    return { action: "none", kind: "none", stubId: null };
  }
  return {
    action: stepView.action,
    kind: stepView.buildKind,
    stubId: stepView.roadStubId,
  };
}

function projectStatusFromStep(
  stepView: TownProjectStepView | undefined,
  allDone: boolean,
): TownProjectStatus {
  if (allDone) {
    return "completed";
  }
  if (!stepView) {
    return "proposed";
  }
  if (stepView.status === "blocked" || stepView.status === "failed") {
    return "blocked";
  }
  if (stepView.status === "eligible") {
    return "active";
  }
  return "proposed";
}

function waitingToStartConstruction(project: TownProjectView): boolean {
  const place = project.steps.find((item) => item.id === "place_building" || item.id === "place_road");
  if (!place || place.skipped || place.status === "skipped" || place.status === "completed") {
    return false;
  }
  return !project.relatedBuildingId;
}

function objectiveGone(project: TownProjectView, facts: TownProjectFacts): boolean {
  const roadStarted =
    Boolean(project.relatedRoadId && facts.placedStubIds.includes(project.relatedRoadId)) ||
    project.steps.some((item) => item.id === "place_road" && item.status === "completed");
  if (
    project.projectType === "food_production" &&
    waitingToStartConstruction(project) &&
    needRecovered(facts, "food_shortage") &&
    !needOpen(facts, "food_shortage")
  ) {
    return true;
  }
  if (
    project.projectType === "tool_production" &&
    waitingToStartConstruction(project) &&
    needRecovered(facts, "tools_shortage") &&
    !needOpen(facts, "tools_shortage")
  ) {
    return true;
  }
  if (project.projectType === "residential" && waitingToStartConstruction(project) && facts.unassignedCitizens === 0) {
    return true;
  }
  if (project.projectType === "territorial" && !roadStarted && facts.reservedLots <= 0) {
    return true;
  }
  return false;
}

export function refreshSteps(
  project: TownProjectView,
  facts: TownProjectFacts,
  now: string | null,
): { project: TownProjectView; completedStepIds: string[]; abandoned: boolean } {
  if (project.status === "completed" || project.status === "cancelled") {
    return { project, completedStepIds: [], abandoned: false };
  }
  if (objectiveGone(project, facts)) {
    return {
      project: {
        ...project,
        status: "abandoned",
        blocker: "the original condition recovered before this project started work",
        recommendedAction: "none",
        recommendedKind: "none",
        lastEvaluatedAt: now,
        evidence: townProjectEvidence(facts),
      },
      completedStepIds: [],
      abandoned: true,
    };
  }

  const completedStepIds: string[] = [];
  const steps = project.steps.map((item) => ({ ...item }));
  let relatedBuildingId = project.relatedBuildingId;

  for (let i = 0; i < steps.length; i += 1) {
    const current = steps[i]!;
    if (current.status === "completed" || current.status === "skipped") {
      continue;
    }
    const result = evaluateStep({ ...project, relatedBuildingId, steps }, current, facts);
    if (result.buildingId) {
      relatedBuildingId = result.buildingId;
    }
    if (result.status === "completed") {
      completedStepIds.push(current.id);
      steps[i] = {
        ...current,
        status: "completed",
        blocker: null,
        buildingId: result.buildingId ?? current.buildingId,
        completedAt: now,
      };
      continue;
    }
    if (result.status === "skipped") {
      steps[i] = {
        ...current,
        status: "skipped",
        skipped: true,
        blocker: null,
        completedAt: now,
      };
      continue;
    }
    steps[i] = {
      ...current,
      status: result.status,
      blocker: result.status === "blocked" || result.status === "failed" ? result.blocker : null,
      buildingId: result.buildingId ?? current.buildingId,
    };
    break;
  }

  const index = firstIncomplete(steps);
  const allDone = index < 0;
  const current = allDone ? undefined : steps[index];
  const rec = recommendedFromStep(current);
  return {
    project: {
      ...project,
      steps,
      currentStepId: current?.id ?? null,
      currentStepIndex: allDone ? steps.length : Math.max(0, index),
      status: projectStatusFromStep(current, allDone),
      blocker: current?.status === "blocked" || current?.status === "failed" ? current.blocker : null,
      recommendedAction: rec.action,
      recommendedKind: rec.kind,
      recommendedStubId: rec.stubId,
      relatedBuildingId,
      completedAt: allDone ? now : null,
      lastEvaluatedAt: now,
      evidence: townProjectEvidence(facts),
    },
    completedStepIds,
    abandoned: false,
  };
}

export function openTownProjects(projects: readonly TownProjectView[]): TownProjectView[] {
  return openProjects(projects).sort(
    (a, b) => b.priority - a.priority || a.objectiveKey.localeCompare(b.objectiveKey),
  );
}

export type ProjectCandidate = {
  projectId: string;
  projectType: TownProjectType;
  name: string;
  stepId: string;
  action: TownRecommendedAction;
  buildKind: TownProjectBuildKind;
  roadStubId: string | null;
  reason: string;
};

export function eligibleProjectCandidates(projects: readonly TownProjectView[]): ProjectCandidate[] {
  const out: ProjectCandidate[] = [];
  for (const project of openTownProjects(projects)) {
    const stepView = project.steps.find((item) => item.id === project.currentStepId);
    if (!stepView || stepView.status !== "eligible" || stepView.action === "none") {
      continue;
    }
    out.push({
      projectId: project.id,
      projectType: project.projectType,
      name: project.name,
      stepId: stepView.id,
      action: stepView.action,
      buildKind: stepView.buildKind,
      roadStubId: stepView.roadStubId,
      reason: project.justification,
    });
  }
  return out.slice(0, 4);
}

export function projectMatchesDecision(
  project: TownProjectView,
  decision: {
    action: string;
    buildKind?: string;
    roadStubId?: string;
  },
): boolean {
  if (project.recommendedAction === "none") {
    return false;
  }
  if (decision.action !== project.recommendedAction) {
    return false;
  }
  if (decision.action === "build") {
    if (project.recommendedKind === "road") {
      return decision.buildKind === "road" && decision.roadStubId === (project.recommendedStubId ?? "");
    }
    return decision.buildKind === project.recommendedKind;
  }
  return decision.action === "work";
}

/**
 * Shortage ranking still wins. When the town is healthy, an eligible project
 * step may outrank an ordinary social visit. Assigned workers keep their jobs.
 */
export function prioritizeProjectActions(input: {
  personality: PersonalityTraits;
  ranked: RankedAction[];
  suggested: RankedAction;
  citizen: Pick<CitizenView, "role">;
  projects: readonly TownProjectView[];
  needs: readonly TownNeedView[];
}): { ranked: RankedAction[]; suggested: RankedAction } {
  if (activeTownNeeds(input.needs).length > 0) {
    return { ranked: input.ranked, suggested: input.suggested };
  }
  const candidates = eligibleProjectCandidates(input.projects);
  for (const candidate of candidates) {
    if (candidate.action === "build" && input.ranked.includes("build")) {
      return { ranked: bumpAction(input.ranked, "build"), suggested: "build" };
    }
    if (candidate.action === "work" && input.ranked.includes("work") && !input.citizen.role) {
      return { ranked: bumpAction(input.ranked, "work"), suggested: "work" };
    }
  }
  return { ranked: input.ranked, suggested: input.suggested };
}

function bumpAction(ranked: RankedAction[], action: RankedAction): RankedAction[] {
  if (!ranked.includes(action)) {
    return ranked;
  }
  return [action, ...ranked.filter((item) => item !== action)];
}

export function describeTownProject(project: TownProjectView): { title: string; detail: string } {
  const stepView = project.steps.find((item) => item.id === project.currentStepId);
  const stepLabel = stepView ? stepView.title : "No remaining step";
  const blocker = project.blocker ? ` Blocked: ${project.blocker}.` : "";
  return {
    title: `${project.name} · ${project.status}`,
    detail: `${project.justification} Current step: ${stepLabel}.${blocker}`,
  };
}

export function describeTownProjectsBanner(
  projects: readonly TownProjectView[],
  ready: boolean,
): { title: string; detail: string; tone: "ok" | "need" | "blocked" | "pending" } {
  if (!ready) {
    return {
      title: "Town projects are not in this database yet",
      detail: "The Phase 5d migration has not been applied. The simulation is still running.",
      tone: "pending",
    };
  }
  const open = openTownProjects(projects);
  if (open.length === 0) {
    return {
      title: "No active development project",
      detail: "The planner creates a project only from actual stock, housing, lots, or reserved land. It does not invent an emergency.",
      tone: "ok",
    };
  }
  const top = open[0]!;
  const copy = describeTownProject(top);
  return {
    title: copy.title,
    detail: copy.detail,
    tone: top.status === "blocked" ? "blocked" : "need",
  };
}

export function materialsAllowRoad(stock: { wood: number; stone: number }): boolean {
  return materialsAllowBuilderShift(stock) && stock.wood >= ROAD_STUB_WOOD && stock.stone >= ROAD_STUB_STONE;
}
