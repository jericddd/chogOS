import { createHash } from "node:crypto";
import { type PersonalityTraits, type RankedAction } from "@/lib/ai/personality";
import { precheckAction, WORLD_ACTIONS, type ResourceStock, type WorldAction } from "@/lib/world/actions";
import { worldHour } from "@/lib/world/clock";
import { CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";
import { ROAD_STUB_STONE, ROAD_STUB_WOOD } from "@/lib/world/roads";
import {
  FOOD_SHORTAGE_ACTIVATE,
  TOOLS_SHORTAGE_ACTIVATE,
  activeTownNeeds,
  evaluateTownNeeds,
  preferredBuildKind as preferredBuildKindFromNeeds,
  prioritizeTownActions,
} from "@/lib/world/needs";
import type { BuildingView, CitizenView, TownNeedView } from "@/lib/world/types";

export const FOOD_SHORTAGE = FOOD_SHORTAGE_ACTIVATE;
export const TOOLS_SHORTAGE = TOOLS_SHORTAGE_ACTIVATE;

export type GoalSnippet = {
  id: string;
  kind: string;
  title: string;
  status: string;
  progress: number;
};

export type MemorySnippet = {
  content: string;
  outcome: string | null;
  importance: number;
  relatedBuildingId: string | null;
};

export type SkillSnippet = {
  name: string;
  level: number;
  experience: number;
};

export type FeasibleOption = {
  action: WorldAction;
  buildingId: string;
  name: string;
};

export type ConstructionContext = {
  canBuild: boolean;
  vacantServedLots: number;
  reservedLots: number;
  validKinds: readonly ConstructKind[];
  canBuildKinds: ConstructKind[];
  suggestedBuildKind: ConstructKind | "none";
  counts: Record<ConstructKind, number>;
  underConstruction: Array<{ id: string; kind: string; name: string; progress: number | null }>;
  roads: {
    canBuildRoad: boolean;
    wood: number;
    stone: number;
    eligibleStubs: Array<{ id: string; name: string; servesPlotIds: readonly string[] }>;
    completedStubIds: string[];
  };
};

export type DecisionContext = {
  tokenId: string;
  citizenId: string;
  name: string | null;
  personality: PersonalityTraits;
  skills: SkillSnippet[];
  goals: GoalSnippet[];
  memories: MemorySnippet[];
  activity: CitizenView["activity"];
  role: CitizenView["role"];
  locationId: string | null;
  workId: string | null;
  homeId: string | null;
  worldS: number;
  hour: number;
  stock: ResourceStock & { food: number; tools: number };
  feasible: FeasibleOption[];
  canBuild: boolean;
  suggested: RankedAction;
  ranked: RankedAction[];
  construction: ConstructionContext;
  townNeeds: TownNeedView[];
};

export function preferredBuildKind(
  stock: { food: number; tools: number },
  needs: readonly TownNeedView[] = [],
  canBuildKinds: readonly ConstructKind[] = CONSTRUCT_KINDS,
): ConstructKind | "none" {
  return preferredBuildKindFromNeeds(stock, needs, canBuildKinds);
}

export function listFeasibleActions(
  citizen: CitizenView,
  buildings: readonly BuildingView[],
  worldS: number,
  stock: ResourceStock,
): FeasibleOption[] {
  const byId = new Map(buildings.map((building) => [building.id, building]));
  const options: FeasibleOption[] = [];
  const targets = new Set<string>();
  if (citizen.workId) targets.add(citizen.workId);
  if (citizen.homeId) targets.add(citizen.homeId);
  targets.add("commons-square");
  targets.add("commons-hall");
  targets.add("market");
  for (const building of buildings) {
    if (building.status === "under_construction") {
      targets.add(building.id);
    }
  }

  for (const action of WORLD_ACTIONS) {
    for (const buildingId of targets) {
      const building = byId.get(buildingId);
      const check = precheckAction({ action, buildingId }, citizen, building, worldS, stock);
      if (check.ok && building) {
        options.push({ action, buildingId, name: building.name });
      }
    }
  }
  return options;
}

function constructionFromBuildings(
  buildings: readonly BuildingView[],
  canBuildKinds: readonly ConstructKind[],
  vacantServedLots: number,
  reservedLots: number,
  stock: { food: number; tools: number },
  needs: readonly TownNeedView[],
  eligibleStubs: ConstructionContext["roads"]["eligibleStubs"],
  completedStubIds: string[],
): ConstructionContext {
  const counts: Record<ConstructKind, number> = { house: 0, farm: 0, workshop: 0 };
  const underConstruction: ConstructionContext["underConstruction"] = [];
  for (const building of buildings) {
    if (building.kind === "house" || building.kind === "farm" || building.kind === "workshop") {
      counts[building.kind] += 1;
    }
    if (building.status === "under_construction") {
      underConstruction.push({
        id: building.id,
        kind: building.kind,
        name: building.name,
        progress: building.constructionProgress,
      });
    }
  }
  const kinds = [...canBuildKinds];
  const canBuildRoad = eligibleStubs.length > 0;
  return {
    canBuild: kinds.length > 0 || canBuildRoad,
    vacantServedLots,
    reservedLots,
    validKinds: CONSTRUCT_KINDS,
    canBuildKinds: kinds,
    suggestedBuildKind: preferredBuildKind(stock, needs, kinds),
    counts,
    underConstruction: underConstruction.slice(0, 8),
    roads: {
      canBuildRoad,
      wood: ROAD_STUB_WOOD,
      stone: ROAD_STUB_STONE,
      eligibleStubs: eligibleStubs.slice(0, 8),
      completedStubIds: completedStubIds.slice(0, 8),
    },
  };
}

export function buildDecisionContext(input: {
  citizenId: string;
  citizen: CitizenView;
  buildings: readonly BuildingView[];
  worldS: number;
  stock: ResourceStock & { food: number; tools: number };
  personality: PersonalityTraits;
  skills: SkillSnippet[];
  goals: GoalSnippet[];
  memories: MemorySnippet[];
  canBuild: boolean;
  vacantServedLots?: number;
  reservedLots?: number;
  townNeeds?: TownNeedView[];
  canBuildKinds?: ConstructKind[];
  eligibleRoadStubs?: ConstructionContext["roads"]["eligibleStubs"];
  completedRoadIds?: string[];
}): DecisionContext {
  const feasible = listFeasibleActions(input.citizen, input.buildings, input.worldS, input.stock);
  const canBuildKinds =
    input.canBuildKinds ?? (input.canBuild ? [...CONSTRUCT_KINDS] : []);
  const eligibleStubs = input.eligibleRoadStubs ?? [];
  const canBuild = canBuildKinds.length > 0 || eligibleStubs.length > 0;
  const vacantServedLots = input.vacantServedLots ?? (canBuildKinds.length > 0 ? 1 : 0);
  const reservedLots = input.reservedLots ?? 0;
  const townNeeds =
    input.townNeeds ??
    evaluateTownNeeds({
      food: input.stock.food,
      wood: input.stock.wood,
      stone: input.stock.stone,
      tools: input.stock.tools,
      vacantServedLots,
      reservedLots,
      buildings: input.buildings,
    });
  const rankedSeed: RankedAction[] = [
    ...new Set(feasible.map((option) => option.action)),
    ...(canBuild ? (["build"] as const) : []),
  ];
  const prioritized = prioritizeTownActions({
    personality: input.personality,
    rankedSeed,
    citizen: input.citizen,
    feasible,
    needs: townNeeds,
    canBuildKinds,
  });
  const construction = constructionFromBuildings(
    input.buildings,
    canBuildKinds,
    vacantServedLots,
    reservedLots,
    input.stock,
    townNeeds,
    eligibleStubs,
    input.completedRoadIds ?? [],
  );
  return {
    tokenId: input.citizen.tokenId,
    citizenId: input.citizenId,
    name: input.citizen.name,
    personality: input.personality,
    skills: input.skills.slice(0, 8),
    goals: input.goals.filter((goal) => ["proposed", "active", "blocked"].includes(goal.status)).slice(0, 3),
    memories: [...input.memories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 8),
    activity: input.citizen.activity,
    role: input.citizen.role,
    locationId: input.citizen.locationId,
    workId: input.citizen.workId,
    homeId: input.citizen.homeId,
    worldS: input.worldS,
    hour: worldHour(input.worldS),
    stock: input.stock,
    feasible: feasible.slice(0, 24),
    canBuild,
    suggested: prioritized.suggested,
    ranked: prioritized.ranked,
    construction,
    townNeeds: activeTownNeeds(townNeeds),
  };
}

export function contextCommitment(context: DecisionContext): string {
  const body = {
    tokenId: context.tokenId,
    personality: context.personality,
    skills: context.skills,
    goals: context.goals.map((goal) => ({ id: goal.id, kind: goal.kind, status: goal.status, progress: goal.progress })),
    memories: context.memories.map((memory) => ({
      content: memory.content,
      outcome: memory.outcome,
      building: memory.relatedBuildingId,
    })),
    activity: context.activity,
    role: context.role,
    locationId: context.locationId,
    workId: context.workId,
    homeId: context.homeId,
    worldS: context.worldS,
    stock: context.stock,
    feasible: context.feasible,
    canBuild: context.canBuild,
    suggested: context.suggested,
    construction: context.construction,
    townNeeds: context.townNeeds.map((need) => ({
      needType: need.needType,
      status: need.status,
      priority: need.priority,
      blocker: need.blocker,
      recommendedAction: need.recommendedAction,
      recommendedKind: need.recommendedKind,
      evidence: {
        food: need.evidence.food,
        wood: need.evidence.wood,
        stone: need.evidence.stone,
        tools: need.evidence.tools,
        vacantServedLots: need.evidence.vacantServedLots,
      },
    })),
  };
  return `0x${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function decisionMessages(context: DecisionContext, maxChars: number): { system: string; user: string } {
  const system = [
    "You decide the next supported action for one chogOS citizen.",
    "Return JSON only. Do not write SQL, code, URLs, or contract calls.",
    "Choose only from the feasible actions.",
    "For construction, action=build and buildKind must be house, farm, workshop, or road.",
    "For a road, also set roadStubId to one of the listed eligible stub ids. Do not invent coordinates, tiles, lots, or costs. The server places the segment.",
    "Use the real storehouse stock and the listed town needs. Those needs are engine facts, not suggestions you may invent.",
    "When a listed need is active and a relevant feasible action exists, choose that action instead of an ordinary social visit.",
    "Prefer a farm when food is short and a workshop when tools are short, but only if construction is listed as available. Do not propose a building when materials or lots are missing.",
    "A completed farm is not food. A completed workshop is not tools. Do not mark a need resolved.",
    "A rejected workplace should not be repeated unless conditions changed.",
    "source=ai is applied only if this JSON is later validated. You cannot complete a goal or a building by saying it is complete.",
    "The free Gemini tier may use this prompt to improve Google products. Do not include secrets. None are provided.",
  ].join(" ");

  const user = JSON.stringify({
    citizen: {
      tokenId: context.tokenId,
      name: context.name,
      role: context.role,
      activity: context.activity,
      workId: context.workId,
      homeId: context.homeId,
      locationId: context.locationId,
    },
    personality: context.personality,
    skills: context.skills,
    goals: context.goals,
    memories: context.memories.map((memory) => ({
      content: memory.content,
      outcome: memory.outcome,
      importance: memory.importance,
    })),
    world: { hour: Math.round(context.hour * 10) / 10, stock: context.stock },
    townNeeds: context.townNeeds.map((need) => ({
      needType: need.needType,
      status: need.status,
      priority: need.priority,
      blocker: need.blocker,
      recommendedAction: need.recommendedAction,
      recommendedKind: need.recommendedKind,
      food: need.evidence.food,
      wood: need.evidence.wood,
      stone: need.evidence.stone,
      tools: need.evidence.tools,
    })),
    feasible: context.feasible,
    canBuild: context.canBuild,
    suggested: context.suggested,
    ranked: context.ranked,
    construction: context.construction,
    roads: context.construction.roads,
  });

  if (system.length + user.length <= maxChars) {
    return { system, user };
  }
  const trimmed = {
    ...JSON.parse(user),
    memories: context.memories.slice(0, 3),
    feasible: context.feasible.slice(0, 10),
    construction: {
      ...context.construction,
      underConstruction: context.construction.underConstruction.slice(0, 3),
    },
  };
  return { system, user: JSON.stringify(trimmed).slice(0, Math.max(200, maxChars - system.length - 32)) };
}
