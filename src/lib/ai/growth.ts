import type { DecisionContext } from "@/lib/ai/context";
import type { ParsedDecision } from "@/lib/ai/schema";
import { civicMenu, isLawCode, menuOpen } from "@/lib/world/civic";
import { CONSTRUCTION_SHIFT_STONE, CONSTRUCTION_SHIFT_WOOD } from "@/lib/world/needs";
import { OPEN_CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";

/**
 * Structured shape for a growth judgment. The enum is the set of structures
 * the land can physically hold, not a list of scenarios to role-play.
 */
export const GROWTH_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["build", "visit", "proclaim", "amend", "pardon", "wait", "work", "socialize", "rest"] },
    buildKind: { type: "string", enum: [...OPEN_CONSTRUCT_KINDS, "road", "none"] },
    roadStubId: { type: "string" },
    projectId: { type: "string" },
    placeName: { type: "string" },
    buildingId: { type: "string" },
    lawCode: {
      type: "string",
      enum: ["storehouse_night", "merchant_only", "ration_cap", "house_door", "ration_fine", "none"],
    },
    subjectTokenId: { type: "string" },
    summary: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["action", "buildKind", "placeName", "summary", "rationale"],
};

type Spur = DecisionContext["construction"]["roads"]["eligibleStubs"][number];

export function landCanGrow(context: DecisionContext): boolean {
  return (
    context.construction.canBuildKinds.length > 0 ||
    context.construction.roads.eligibleStubs.length > 0 ||
    menuOpen(civicMenu(context.civic))
  );
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

/** A short title the map can store. Empty, links, and "none" are not names. */
export function placeTitle(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const title = raw.trim().replace(/\s+/g, " ");
  if (title.length < 2 || title.length > 40 || norm(title) === "none") {
    return null;
  }
  if (/https?:\/\//i.test(title) || /[<>]/.test(title)) {
    return null;
  }
  if (!/^[A-Za-z][A-Za-z0-9 '&-]*$/.test(title)) {
    return null;
  }
  return title;
}

const NAMED_KINDS = [...OPEN_CONSTRUCT_KINDS, "jail"] as const;

function acceptCivic(
  decision: ParsedDecision,
  context: DecisionContext,
): { ok: true; decision: ParsedDecision } | { ok: false; reason: string } {
  const menu = civicMenu(context.civic);
  const code = decision.lawCode;
  if (decision.action === "visit") {
    if (!menu.visit || !context.civic.bankId) {
      return { ok: false, reason: "the bank is not open for a visit" };
    }
    return {
      ok: true,
      decision: { ...decision, buildingId: context.civic.bankId, buildKind: "none", placeName: null, lawCode: null },
    };
  }
  if (decision.action === "proclaim" || decision.action === "amend" || decision.action === "pardon") {
    const open = decision.action === "proclaim" ? menu.proclaim : menu.amend;
    if (!open) {
      return { ok: false, reason: "that record is not stored yet" };
    }
    if (!code || !isLawCode(code) || (decision.action === "proclaim" && context.civic.laws.some((law) => law.code === code))) {
      return { ok: false, reason: "that is not an open law in the catalog" };
    }
    if (decision.action !== "proclaim" && !context.civic.laws.some((law) => law.code === code && law.status === "proclaimed")) {
      return { ok: false, reason: "that law is not proclaimed" };
    }
    return { ok: true, decision: { ...decision, lawCode: code, buildKind: "none", placeName: null } };
  }
  if (decision.action === "levy") {
    if (!menu.levy) {
      return { ok: false, reason: "no proclaimed law names a fine" };
    }
    return { ok: true, decision: { ...decision, buildKind: "none", placeName: null, lawCode: "ration_fine" } };
  }
  if (decision.action === "detain") {
    if (!menu.detain || !context.civic.jailId) {
      return { ok: false, reason: "a sentence needs a room that is not open yet" };
    }
    return {
      ok: true,
      decision: { ...decision, buildingId: context.civic.jailId, buildKind: "none", placeName: null },
    };
  }
  if (decision.action === "watch") {
    if (!menu.watch) {
      return { ok: false, reason: "no repeated offense is stored" };
    }
    const door = decision.buildingId === "commons-square" ? "commons-square" : "storehouse";
    return { ok: true, decision: { ...decision, buildingId: door, buildKind: "none", placeName: null } };
  }
  return { ok: false, reason: "that is not a decision this record can hold" };
}

/**
 * Keep a model judgment only when it is growth the current land can hold.
 * Daily life is refused here. Nothing is substituted on the model's behalf.
 */
export function acceptGrowth(
  decision: ParsedDecision,
  context: DecisionContext,
): { ok: true; decision: ParsedDecision } | { ok: false; reason: string } {
  if (decision.buildKind === "jail" || decision.action === "detain" || decision.action === "levy" || decision.action === "watch") {
    return { ok: false, reason: "jail, detention, fines, and watch are disabled" };
  }
  if (decision.action !== "build") {
    if (
      decision.action === "visit" ||
      decision.action === "proclaim" ||
      decision.action === "amend" ||
      decision.action === "pardon"
    ) {
      return acceptCivic(decision, context);
    }
    return { ok: false, reason: "daily life is already simulated; this decision has to grow the town" };
  }
  if (decision.buildKind === "road") {
    const matched = matchSurveyedSpur(decision.roadStubId, context.construction.roads.eligibleStubs);
    if (!matched.ok) {
      return matched;
    }
    return { ok: true, decision: { ...decision, buildKind: "road", roadStubId: matched.id, placeName: null } };
  }
  if ((NAMED_KINDS as readonly string[]).includes(decision.buildKind)) {
    const kind = decision.buildKind as ConstructKind;
    if (!context.construction.canBuildKinds.includes(kind)) {
      return { ok: false, reason: `a ${kind} cannot be started on the open land right now` };
    }
    const title = placeTitle(decision.placeName);
    if (!title) {
      return { ok: false, reason: "name the place you are raising, as a short title taken from this land" };
    }
    return { ok: true, decision: { ...decision, roadStubId: "none", placeName: title } };
  }
  return { ok: false, reason: "that is not a structure this land can hold" };
}
