import type { DecisionContext } from "@/lib/ai/context";
import type { ParsedDecision } from "@/lib/ai/schema";
import { CONSTRUCTION_SHIFT_STONE, CONSTRUCTION_SHIFT_WOOD } from "@/lib/world/needs";
import type { ConstructKind } from "@/lib/world/layout";

/**
 * Structured shape for a growth judgment. The enum is the set of structures
 * the land can physically hold, not a list of scenarios to role-play.
 */
export const GROWTH_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["build"] },
    buildKind: { type: "string", enum: ["house", "farm", "workshop", "road"] },
    roadStubId: { type: "string" },
    projectId: { type: "string" },
    summary: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["action", "buildKind", "summary", "rationale"],
};

type Spur = DecisionContext["construction"]["roads"]["eligibleStubs"][number];

export function landCanGrow(context: DecisionContext): boolean {
  return context.construction.canBuildKinds.length > 0 || context.construction.roads.eligibleStubs.length > 0;
}

export function growthBlocker(context: DecisionContext): string {
  const { wood, stone } = context.stock;
  if (wood < CONSTRUCTION_SHIFT_WOOD || stone < CONSTRUCTION_SHIFT_STONE) {
    return `The storehouse cannot pay for growth. It has ${wood} wood and ${stone} stone. Starting work needs ${CONSTRUCTION_SHIFT_WOOD} wood and ${CONSTRUCTION_SHIFT_STONE} stone.`;
  }
  if (context.construction.vacantServedLots <= 0 && context.construction.reservedLots > 0) {
    return "Open road-connected lots are full, and no surveyed road remains that would reach the reserved land.";
  }
  if (context.construction.vacantServedLots <= 0) {
    return "There is no open road-connected lot left, and every surveyed road is already built.";
  }
  if (context.construction.underConstruction.length > 0) {
    return "A site is already under construction for the kinds this land can start, and no surveyed road is waiting.";
  }
  return "The land cannot take a growth step right now.";
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** Match a spur the model named from the description. Ambiguous names are rejected. */
export function matchSurveyedSpur(
  named: string,
  stubs: readonly Spur[],
): { ok: true; id: string } | { ok: false; reason: string } {
  const raw = named.trim();
  if (!raw || norm(raw) === "none") {
    return { ok: false, reason: "a road needs the surveyed spur's label from the description" };
  }
  const key = norm(raw);
  const exact = stubs.filter((stub) => norm(stub.id) === key || norm(stub.name) === key);
  if (exact.length === 1) {
    return { ok: true, id: exact[0]!.id };
  }
  const mentioned = stubs.filter(
    (stub) =>
      key.includes(norm(stub.id)) ||
      key.includes(norm(stub.name)) ||
      stub.servesPlotIds.some((plotId) => key.includes(norm(plotId))),
  );
  if (mentioned.length === 1) {
    return { ok: true, id: mentioned[0]!.id };
  }
  if (mentioned.length > 1) {
    return { ok: false, reason: "more than one surveyed road matches that description" };
  }
  return { ok: false, reason: "that road is not an unbuilt survey on this map" };
}

/**
 * Keep a model judgment only when it is growth the current land can hold.
 * Daily life is refused here. Nothing is substituted on the model's behalf.
 */
export function acceptGrowth(
  decision: ParsedDecision,
  context: DecisionContext,
): { ok: true; decision: ParsedDecision } | { ok: false; reason: string } {
  if (decision.action !== "build") {
    return { ok: false, reason: "daily life is already simulated; this decision has to grow the town" };
  }
  if (decision.buildKind === "road") {
    const matched = matchSurveyedSpur(decision.roadStubId, context.construction.roads.eligibleStubs);
    if (!matched.ok) {
      return matched;
    }
    return { ok: true, decision: { ...decision, buildKind: "road", roadStubId: matched.id } };
  }
  if (decision.buildKind === "house" || decision.buildKind === "farm" || decision.buildKind === "workshop") {
    const kind: ConstructKind = decision.buildKind;
    if (!context.construction.canBuildKinds.includes(kind)) {
      return { ok: false, reason: `a ${kind} cannot be started on the open land right now` };
    }
    return { ok: true, decision: { ...decision, roadStubId: "none" } };
  }
  return { ok: false, reason: "that is not a structure this land can hold" };
}
