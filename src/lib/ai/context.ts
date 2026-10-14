import { createHash } from "node:crypto";
import { preferredFeasibleAction, rankActions, type PersonalityTraits, type RankedAction } from "@/lib/ai/personality";
import { precheckAction, WORLD_ACTIONS, type ResourceStock, type WorldAction } from "@/lib/world/actions";
import { worldHour } from "@/lib/world/clock";
import type { BuildingView, CitizenView } from "@/lib/world/types";

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
};

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
}): DecisionContext {
  const feasible = listFeasibleActions(input.citizen, input.buildings, input.worldS, input.stock);
  const rankedSeed: RankedAction[] = [
    ...new Set(feasible.map((option) => option.action)),
    ...(input.canBuild ? (["build"] as const) : []),
  ];
  const ranked = rankActions(input.personality, rankedSeed);
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
    canBuild: input.canBuild,
    suggested: preferredFeasibleAction(input.personality, rankedSeed) ?? "rest",
    ranked,
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
  };
  return `0x${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function decisionMessages(context: DecisionContext, maxChars: number): { system: string; user: string } {
  const system = [
    "You decide the next supported action for one chogOS citizen.",
    "Return JSON only. Do not write SQL, code, URLs, or contract calls.",
    "Choose only from the feasible actions. For construction, action=build and buildKind=house; do not invent coordinates.",
    "A rejected workplace should not be repeated unless conditions changed.",
    "source=ai is applied only if this JSON is later validated. You cannot complete a goal by saying it is complete.",
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
    feasible: context.feasible,
    canBuild: context.canBuild,
    suggested: context.suggested,
    ranked: context.ranked,
  });

  if (system.length + user.length <= maxChars) {
    return { system, user };
  }
  const trimmed = {
    ...JSON.parse(user),
    memories: context.memories.slice(0, 3),
    feasible: context.feasible.slice(0, 10),
  };
  return { system, user: JSON.stringify(trimmed).slice(0, Math.max(200, maxChars - system.length - 32)) };
}
