import { createHash } from "node:crypto";
import { describePlace } from "@/lib/ai/place";
import { type PersonalityTraits, type RankedAction } from "@/lib/ai/personality";
import { considerWalletActivation } from "@/lib/chogbank/authorization";
import type { ActivationState } from "@/lib/chogbank/types";
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
import { openTownProjects, prioritizeProjectActions } from "@/lib/world/projects";
import type { BuildingView, CitizenView, TownNeedView, TownProjectView } from "@/lib/world/types";

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

export type WalletActivationContext = {
  state: ActivationState;
  hasActiveWallet: boolean;
  eligibleToRequest: boolean;
};

export type StandingPlace = {
  name: string;
  kind: string;
  status: string;
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
  standing: StandingPlace[];
  feasible: FeasibleOption[];
  canBuild: boolean;
  suggested: RankedAction;
  ranked: RankedAction[];
  construction: ConstructionContext;
  townNeeds: TownNeedView[];
  townProjects: TownProjectView[];
  walletActivation: WalletActivationContext;
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

export function goalLooksOnchain(goals: readonly GoalSnippet[], memories: readonly MemorySnippet[] = []): boolean {
  const text = [
    ...goals.map((goal) => `${goal.kind} ${goal.title}`),
    ...memories.map((memory) => memory.content),
  ]
    .join(" ")
    .toLowerCase();
  return /onchain|on-chain|start a business|trade an asset|make a payment|receive payment/.test(text);
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
  townProjects?: TownProjectView[];
  canBuildKinds?: ConstructKind[];
  eligibleRoadStubs?: ConstructionContext["roads"]["eligibleStubs"];
  completedRoadIds?: string[];
  walletActivation?: WalletActivationContext;
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
  const townProjects = input.townProjects ?? [];
  const needRanked = prioritizeTownActions({
    personality: input.personality,
    rankedSeed,
    citizen: input.citizen,
    feasible,
    needs: townNeeds,
    canBuildKinds,
  });
  const prioritized = prioritizeProjectActions({
    personality: input.personality,
    ranked: needRanked.ranked,
    suggested: needRanked.suggested,
    citizen: input.citizen,
    projects: townProjects,
    needs: townNeeds,
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
  const walletActivation = input.walletActivation ?? {
    state: "unassigned",
    hasActiveWallet: false,
    eligibleToRequest: considerWalletActivation({
      hasActiveWallet: false,
      motive: goalLooksOnchain(input.goals, input.memories) ? "start_business" : null,
      hasConcreteOnchainPlan: goalLooksOnchain(input.goals, input.memories),
    }) === "eligible_to_request",
  };
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
    standing: input.buildings.slice(0, 48).map((building) => ({
      name: building.name,
      kind: building.kind,
      status: building.status,
    })),
    feasible: feasible.slice(0, 24),
    canBuild,
    suggested: prioritized.suggested,
    ranked: prioritized.ranked,
    construction,
    townNeeds: activeTownNeeds(townNeeds),
    townProjects: openTownProjects(townProjects).slice(0, 4),
    walletActivation,
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
    standing: context.standing,
    place: describePlace(context),
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
    townProjects: context.townProjects.map((project) => ({
      id: project.id,
      type: project.projectType,
      status: project.status,
      step: project.currentStepId,
      recommendedAction: project.recommendedAction,
      recommendedKind: project.recommendedKind,
      recommendedStubId: project.recommendedStubId,
      blocker: project.blocker,
    })),
    walletActivation: context.walletActivation,
  };
  return `0x${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function decisionMessages(context: DecisionContext, maxChars: number): { system: string; user: string } {
  const system = [
    "You decide how this town grows.",
    "Read the description of the land: what already stands, what each place is for, the named country, the water, and what the storehouse holds. Judge the growth from that place.",
    "Daily life is already simulated: sleep, work, shopping, rest, and visiting. Do not spend this decision on those.",
    "Return JSON only. Do not write SQL, code, URLs, or contract calls.",
    "This ground can stand a new shelter, recorded as house; a new field for food, recorded as farm; a new place for tools, recorded as workshop; or a surveyed road the description says is not built yet. It cannot stand any other kind of building. You do not choose the lot, the door, or any coordinate.",
    "action is build. buildKind is the structure this place needs.",
    "When you raise a house, farm, or workshop, placeName is the name you give it from the land you read. That name is what gets built and what people will see. A road already has a survey name: set roadStubId to that label from the description, and set placeName to none.",
    "summary is the growth in one sentence, in your own words. rationale is why this place needs it.",
    "You cannot finish a building, invent a shortage, or complete a project by saying so.",
    "Do not return propose_economy or request_wallet_activation. This decision cannot move money, approve funding, or deploy a wallet.",
    "The free Gemini tier may use this prompt to improve Google products. Do not include secrets. None are provided.",
  ].join(" ");

  const place = describePlace(context);
  const user = JSON.stringify({
    place,
    you: {
      tokenId: context.tokenId,
      name: context.name,
      role: context.role,
      locationId: context.locationId,
    },
  });

  if (system.length + user.length <= maxChars) {
    return { system, user };
  }
  return { system, user: JSON.stringify({ place: place.slice(0, Math.max(200, maxChars - system.length - 80)) }) };
}
