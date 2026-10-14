import type { WorldAction } from "@/lib/world/actions";

export type PersonalityTraits = {
  sociability: number;
  curiosity: number;
  industriousness: number;
  cooperation: number;
  caution: number;
  planning: number;
  resourcefulness: number;
  preferredActivity: "work" | "shop" | "socialize" | "rest";
};

export type RankedAction = WorldAction | "build";

const WEIGHTS: Record<RankedAction, (t: PersonalityTraits) => number> = {
  work: (t) => t.industriousness + t.resourcefulness * 0.25,
  shop: (t) => t.curiosity * 0.85 + (100 - t.resourcefulness) * 0.15,
  socialize: (t) => t.sociability + t.cooperation * 0.35,
  rest: (t) => t.caution + (100 - t.industriousness) * 0.15,
  sleep: (t) => t.caution * 0.7,
  build: (t) => t.planning * 0.7 + t.industriousness * 0.45,
};

/** Higher score wins. Ties break by action name so the ranking is reproducible. */
export function scoreAction(traits: PersonalityTraits, action: RankedAction): number {
  return WEIGHTS[action](traits);
}

export function rankActions(
  traits: PersonalityTraits,
  feasible: readonly RankedAction[],
): RankedAction[] {
  return [...feasible].sort((a, b) => {
    const diff = scoreAction(traits, b) - scoreAction(traits, a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

export function preferredFeasibleAction(
  traits: PersonalityTraits,
  feasible: readonly RankedAction[],
): RankedAction | undefined {
  return rankActions(traits, feasible)[0];
}

export const TRAIT_LABELS: Record<keyof Omit<PersonalityTraits, "preferredActivity">, string> = {
  sociability: "Sociability",
  curiosity: "Curiosity",
  industriousness: "Industriousness",
  cooperation: "Cooperation",
  caution: "Caution",
  planning: "Planning",
  resourcefulness: "Resourcefulness",
};
