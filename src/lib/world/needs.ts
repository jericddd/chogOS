/**
 * Phase 5c town needs. The engine decides whether a shortage exists from
 * persisted Storehouse stock and layout facts. The model only chooses among
 * actions that already pass world_check_action / precheckAction.
 *
 * Thresholds are the single TypeScript source of truth. The additive SQL
 * migration copies the same numbers and must stay in lockstep.
 */
import type { PersonalityTraits, RankedAction } from "@/lib/ai/personality";
import { preferredFeasibleAction, rankActions } from "@/lib/ai/personality";
import { CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";
import { planConstruction } from "@/lib/world/placement";
import type {
  BuildingView,
  CitizenView,
  TownNeedEvidence,
  TownNeedStatus,
  TownNeedType,
  TownNeedView,
  TownRecommendedAction,
} from "@/lib/world/types";

/** Storehouse clamp from world_store(). Recovery thresholds stay at or below this. */
export const STOREHOUSE_CAPACITY = 400;

/** One builder shift in world_check_action. */
export const CONSTRUCTION_SHIFT_WOOD = 3;
export const CONSTRUCTION_SHIFT_STONE = 2;

/** One crafter shift in world_check_action. */
export const CRAFTER_SHIFT_WOOD = 2;

export const FOOD_SHORTAGE_ACTIVATE = 40;
/** Genesis initial food. Twice the activate line, well under the 400 cap. */
export const FOOD_SHORTAGE_RECOVER = 80;

export const TOOLS_SHORTAGE_ACTIVATE = 4;
/** Three workshop batches of 4 tools. */
export const TOOLS_SHORTAGE_RECOVER = 12;

export const WOOD_CONSTRUCTION_ACTIVATE = CONSTRUCTION_SHIFT_WOOD;
export const STONE_CONSTRUCTION_ACTIVATE = CONSTRUCTION_SHIFT_STONE;
/** Five builder shifts of wood, so one gather batch does not flap the need. */
export const WOOD_CONSTRUCTION_RECOVER = 15;
export const STONE_CONSTRUCTION_RECOVER = 10;

/** @deprecated Use FOOD_SHORTAGE_ACTIVATE. Kept so Phase 5a call sites keep compiling. */
export const FOOD_SHORTAGE = FOOD_SHORTAGE_ACTIVATE;
/** @deprecated Use TOOLS_SHORTAGE_ACTIVATE. */
export const TOOLS_SHORTAGE = TOOLS_SHORTAGE_ACTIVATE;

export const TOWN_NEED_TYPES = ["food_shortage", "tools_shortage", "materials_shortage"] as const;

export const TOWN_NEED_PRIORITY: Record<TownNeedType, number> = {
  food_shortage: 100,
  tools_shortage: 80,
  materials_shortage: 60,
};

export type { TownNeedEvidence, TownNeedStatus, TownNeedType, TownNeedView, TownRecommendedAction };

export type TownNeedSnapshot = {
  food: number;
  wood: number;
  stone: number;
  tools: number;
  vacantServedLots: number;
  reservedLots: number;
  buildings: readonly Pick<BuildingView, "id" | "kind" | "status" | "constructionProgress">[];
};

function asStock(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

export function townNeedEvidence(input: TownNeedSnapshot): TownNeedEvidence {
  const underConstruction: TownNeedEvidence["underConstruction"] = [];
  let farms = 0;
  let workshops = 0;
  let houses = 0;
  for (const building of input.buildings) {
    if (building.kind === "farm") farms += 1;
    if (building.kind === "workshop") workshops += 1;
    if (building.kind === "house") houses += 1;
    if (building.status === "under_construction") {
      underConstruction.push({
        id: building.id,
        kind: building.kind,
        progress: building.constructionProgress,
      });
    }
  }
  return {
    food: asStock(input.food),
    wood: asStock(input.wood),
    stone: asStock(input.stone),
    tools: asStock(input.tools),
    vacantServedLots: Math.max(0, Math.floor(input.vacantServedLots)),
    reservedLots: Math.max(0, Math.floor(input.reservedLots)),
    farms,
    workshops,
    houses,
    underConstruction: underConstruction.slice(0, 8),
  };
}

function kindUnderConstruction(evidence: TownNeedEvidence, kind: ConstructKind): boolean {
  return evidence.underConstruction.some((site) => site.kind === kind);
}

function materialsAllowConstruction(evidence: TownNeedEvidence): boolean {
  return evidence.wood >= WOOD_CONSTRUCTION_ACTIVATE && evidence.stone >= STONE_CONSTRUCTION_ACTIVATE;
}

function foodShortageCondition(evidence: TownNeedEvidence): boolean {
  return evidence.food < FOOD_SHORTAGE_ACTIVATE;
}

function foodRecovered(evidence: TownNeedEvidence): boolean {
  return evidence.food >= FOOD_SHORTAGE_RECOVER;
}

function toolsShortageCondition(evidence: TownNeedEvidence): boolean {
  return evidence.tools < TOOLS_SHORTAGE_ACTIVATE;
}

function toolsRecovered(evidence: TownNeedEvidence): boolean {
  return evidence.tools >= TOOLS_SHORTAGE_RECOVER;
}

function materialsShortageCondition(evidence: TownNeedEvidence): boolean {
  return evidence.wood < WOOD_CONSTRUCTION_ACTIVATE || evidence.stone < STONE_CONSTRUCTION_ACTIVATE;
}

function materialsRecovered(evidence: TownNeedEvidence): boolean {
  return evidence.wood >= WOOD_CONSTRUCTION_RECOVER && evidence.stone >= STONE_CONSTRUCTION_RECOVER;
}

function foodBlocker(evidence: TownNeedEvidence): string | null {
  const farmReady = evidence.farms > 0 || kindUnderConstruction(evidence, "farm");
  if (farmReady) {
    return null;
  }
  if (evidence.vacantServedLots <= 0) {
    return "no vacant road-served lot for a farm";
  }
  if (!materialsAllowConstruction(evidence)) {
    return "not enough wood and stone for a construction shift";
  }
  return null;
}

function toolsBlocker(evidence: TownNeedEvidence): string | null {
  const shopReady = evidence.workshops > 0 || kindUnderConstruction(evidence, "workshop");
  if (shopReady) {
    return null;
  }
  if (evidence.vacantServedLots <= 0) {
    return "no vacant road-served lot for a workshop";
  }
  if (!materialsAllowConstruction(evidence)) {
    return "not enough wood and stone for a construction shift";
  }
  return null;
}

function materialsBlocker(): string | null {
  // Founding always has Mossy Woods and Violet Quarry. Gathering remains a
  // legal action while those workplaces exist, so this need stays active
  // rather than blocked when stock is short.
  return null;
}

function nextStatus(args: {
  previous: TownNeedStatus | undefined;
  activate: boolean;
  recover: boolean;
  blocker: string | null;
}): TownNeedStatus {
  const previous = args.previous ?? "inactive";
  const open = previous === "active" || previous === "blocked";
  if (open) {
    if (args.recover) {
      return "resolved";
    }
    return args.blocker ? "blocked" : "active";
  }
  if (args.activate) {
    return args.blocker ? "blocked" : "active";
  }
  return previous === "resolved" ? "resolved" : "inactive";
}

function recommend(
  type: TownNeedType,
  status: TownNeedStatus,
  evidence: TownNeedEvidence,
): { action: TownRecommendedAction; kind: ConstructKind | "none" } {
  if (status === "inactive" || status === "resolved") {
    return { action: "none", kind: "none" };
  }
  if (type === "food_shortage") {
    if (evidence.farms > 0 || kindUnderConstruction(evidence, "farm")) {
      return { action: "work", kind: kindUnderConstruction(evidence, "farm") ? "farm" : "none" };
    }
    if (evidence.vacantServedLots > 0 && materialsAllowConstruction(evidence)) {
      return { action: "build", kind: "farm" };
    }
    if (materialsShortageCondition(evidence)) {
      return { action: "work", kind: "none" };
    }
    return { action: "none", kind: "none" };
  }
  if (type === "tools_shortage") {
    if (evidence.workshops > 0 || kindUnderConstruction(evidence, "workshop")) {
      return { action: "work", kind: kindUnderConstruction(evidence, "workshop") ? "workshop" : "none" };
    }
    if (evidence.vacantServedLots > 0 && materialsAllowConstruction(evidence)) {
      return { action: "build", kind: "workshop" };
    }
    if (evidence.wood < CRAFTER_SHIFT_WOOD) {
      return { action: "work", kind: "none" };
    }
    return { action: "none", kind: "none" };
  }
  return { action: "work", kind: "none" };
}

export function evaluateTownNeeds(
  input: TownNeedSnapshot,
  previous: readonly Pick<TownNeedView, "needType" | "status">[] = [],
  evaluatedAt: string | null = null,
): TownNeedView[] {
  const evidence = townNeedEvidence(input);
  const prev = new Map(previous.map((need) => [need.needType, need.status]));
  const specs: Array<{
    type: TownNeedType;
    activate: boolean;
    recover: boolean;
    blocker: string | null;
  }> = [
    {
      type: "food_shortage",
      activate: foodShortageCondition(evidence),
      recover: foodRecovered(evidence),
      blocker: foodBlocker(evidence),
    },
    {
      type: "tools_shortage",
      activate: toolsShortageCondition(evidence),
      recover: toolsRecovered(evidence),
      blocker: toolsBlocker(evidence),
    },
    {
      type: "materials_shortage",
      activate: materialsShortageCondition(evidence),
      recover: materialsRecovered(evidence),
      blocker: materialsBlocker(),
    },
  ];

  return specs.map((spec) => {
    const status = nextStatus({
      previous: prev.get(spec.type),
      activate: spec.activate,
      recover: spec.recover,
      blocker: spec.blocker,
    });
    const rec = recommend(spec.type, status, evidence);
    const open = status === "active" || status === "blocked";
    return {
      needType: spec.type,
      status,
      priority: TOWN_NEED_PRIORITY[spec.type],
      firstDetectedAt: open ? evaluatedAt : null,
      lastEvaluatedAt: evaluatedAt,
      lastStatusChangedAt: evaluatedAt,
      resolvedAt: status === "resolved" ? evaluatedAt : null,
      evidence,
      blocker: status === "blocked" ? spec.blocker : null,
      recommendedAction: rec.action,
      recommendedKind: rec.kind,
      lastEventId: null,
      lastDecisionId: null,
    };
  });
}

export function activeTownNeeds(needs: readonly TownNeedView[]): TownNeedView[] {
  return needs
    .filter((need) => need.status === "active" || need.status === "blocked")
    .sort((a, b) => b.priority - a.priority || a.needType.localeCompare(b.needType));
}

export function constructKindForNeed(need: TownNeedView): ConstructKind | null {
  if (need.needType === "food_shortage") {
    return "farm";
  }
  if (need.needType === "tools_shortage") {
    return "workshop";
  }
  return null;
}

export function jobAddressesNeed(role: CitizenView["role"], needType: TownNeedType): boolean {
  if (needType === "food_shortage") {
    return role === "farmer";
  }
  if (needType === "tools_shortage") {
    return role === "crafter";
  }
  if (needType === "materials_shortage") {
    return role === "woodcutter" || role === "stonecutter";
  }
  return false;
}

export function materialsAllowBuilderShift(stock: { wood: number; stone: number }): boolean {
  return stock.wood >= CONSTRUCTION_SHIFT_WOOD && stock.stone >= CONSTRUCTION_SHIFT_STONE;
}

/**
 * Kinds that may start now: vacant served lot, materials for one builder shift,
 * and no site of that kind already under construction.
 */
export function feasibleConstructKinds(
  buildings: readonly Pick<BuildingView, "id" | "kind" | "name" | "x" | "y" | "w" | "h" | "doorX" | "doorY" | "status">[],
  occupiedPlotIds: ReadonlySet<string>,
  stock: { wood: number; stone: number },
): ConstructKind[] {
  if (!materialsAllowBuilderShift(stock)) {
    return [];
  }
  const under = new Set(
    buildings.filter((building) => building.status === "under_construction").map((building) => building.kind),
  );
  return CONSTRUCT_KINDS.filter((kind) => {
    if (under.has(kind)) {
      return false;
    }
    return planConstruction(buildings, occupiedPlotIds, kind).ok;
  });
}

export function preferredBuildKind(
  stock: { food: number; tools: number; wood?: number; stone?: number },
  needs: readonly TownNeedView[] = [],
  canBuildKinds: readonly ConstructKind[] = CONSTRUCT_KINDS,
): ConstructKind | "none" {
  const open = activeTownNeeds(needs);
  for (const need of open) {
    const kind = constructKindForNeed(need);
    if (kind && canBuildKinds.includes(kind)) {
      return kind;
    }
  }
  if (open.length > 0) {
    return "none";
  }
  if (stock.food < FOOD_SHORTAGE_ACTIVATE && canBuildKinds.includes("farm")) {
    return "farm";
  }
  if (stock.tools < TOOLS_SHORTAGE_ACTIVATE && canBuildKinds.includes("workshop")) {
    return "workshop";
  }
  return "none";
}

function workIsFeasible(feasible: readonly { action: string }[]): boolean {
  return feasible.some((option) => option.action === "work");
}

/**
 * Shortage-aware ranking. Personality still orders the leftover actions.
 * Assigned work is not abandoned so every citizen does not pile onto one site.
 * Off-shift and unemployed citizens may take construction when it addresses a need.
 */
export function prioritizeTownActions(input: {
  personality: PersonalityTraits;
  rankedSeed: readonly RankedAction[];
  citizen: Pick<CitizenView, "role">;
  feasible: readonly { action: string }[];
  needs: readonly TownNeedView[];
  canBuildKinds: readonly ConstructKind[];
}): { ranked: RankedAction[]; suggested: RankedAction } {
  const personalityRanked = rankActions(input.personality, input.rankedSeed);
  const personalitySuggested =
    preferredFeasibleAction(input.personality, input.rankedSeed) ?? personalityRanked[0] ?? "rest";
  const open = activeTownNeeds(input.needs);
  if (open.length === 0) {
    return { ranked: personalityRanked, suggested: personalitySuggested };
  }

  const canWork = workIsFeasible(input.feasible) && Boolean(input.citizen.role);
  for (const need of open) {
    if (canWork && jobAddressesNeed(input.citizen.role, need.needType)) {
      return { ranked: bumpAction(personalityRanked, "work"), suggested: "work" };
    }
  }

  if (canWork) {
    return { ranked: bumpAction(personalityRanked, "work"), suggested: "work" };
  }

  for (const need of open) {
    const kind = constructKindForNeed(need);
    if (kind && input.canBuildKinds.includes(kind) && input.rankedSeed.includes("build")) {
      return { ranked: bumpAction(personalityRanked, "build"), suggested: "build" };
    }
    if (need.needType === "materials_shortage" && input.rankedSeed.includes("work") && jobAddressesNeed(input.citizen.role, "materials_shortage")) {
      return { ranked: bumpAction(personalityRanked, "work"), suggested: "work" };
    }
  }

  return { ranked: personalityRanked, suggested: personalitySuggested };
}

function bumpAction(ranked: RankedAction[], action: RankedAction): RankedAction[] {
  if (!ranked.includes(action)) {
    return ranked;
  }
  return [action, ...ranked.filter((item) => item !== action)];
}

export function describeTownNeed(need: TownNeedView): { title: string; detail: string } {
  const stock = need.evidence;
  if (need.needType === "food_shortage") {
    return {
      title: "Food supply is running low",
      detail: `Storehouse food is ${stock.food} (shortage below ${FOOD_SHORTAGE_ACTIVATE}, recovers at ${FOOD_SHORTAGE_RECOVER}).`,
    };
  }
  if (need.needType === "tools_shortage") {
    return {
      title: "Tools are below the preferred reserve",
      detail: `Storehouse tools are ${stock.tools} (shortage below ${TOOLS_SHORTAGE_ACTIVATE}, recovers at ${TOOLS_SHORTAGE_RECOVER}).`,
    };
  }
  return {
    title: "Construction is waiting for materials",
    detail: `A builder shift needs ${CONSTRUCTION_SHIFT_WOOD} wood and ${CONSTRUCTION_SHIFT_STONE} stone. Storehouse has wood ${stock.wood}, stone ${stock.stone}.`,
  };
}

export function describeTownNeedsBanner(needs: readonly TownNeedView[], ready: boolean): {
  title: string;
  detail: string;
  tone: "ok" | "need" | "blocked" | "pending";
} {
  if (!ready) {
    return {
      title: "Town needs are not in this database yet",
      detail: "The Phase 5c migration has not been applied. The simulation is still running.",
      tone: "pending",
    };
  }
  const open = activeTownNeeds(needs);
  if (open.length === 0) {
    return {
      title: "No critical shortage is currently detected",
      detail: "Citizens may work, shop, socialize, or rest. Construction is optional.",
      tone: "ok",
    };
  }
  const top = open[0]!;
  const copy = describeTownNeed(top);
  return {
    title: copy.title,
    detail: top.blocker ? `${copy.detail} Blocked: ${top.blocker}.` : copy.detail,
    tone: top.status === "blocked" ? "blocked" : "need",
  };
}
