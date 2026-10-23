import type { DecisionContext } from "@/lib/ai/context";
import { acceptGrowth } from "@/lib/ai/growth";
import type { ParsedDecision } from "@/lib/ai/schema";
import { civicMenu } from "@/lib/world/civic";
import { constructionKindsForShortage, roadsDeferredForShortage } from "@/lib/world/shortage";

export const PUNITIVE_ACTIONS = ["detain", "levy", "watch"] as const;

export type MindMenu = {
  actions: string[];
  buildKinds: string[];
  places: Array<{ action: string; buildingId: string; name: string }>;
  rejections: string[];
};

const PLACE_ACTIONS = new Set(["work", "socialize", "rest", "sleep", "visit"]);

export function mindResponseSchema(menu: MindMenu): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: menu.actions },
      buildKind: { type: "string", enum: menu.buildKinds },
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
}

export function buildMindMenu(
  context: DecisionContext,
  input: { blockedKinds?: readonly string[]; rejections?: readonly string[] } = {},
): MindMenu {
  const blocked = new Set(input.blockedKinds ?? []);
  const kinds = constructionKindsForShortage(context.construction.canBuildKinds, context.stock).filter(
    (kind) => !blocked.has(kind),
  );
  const buildKinds: string[] = [...kinds];
  if (!roadsDeferredForShortage(context.stock) && context.construction.roads.eligibleStubs.length > 0 && !blocked.has("road")) {
    buildKinds.push("road");
  }
  const places = context.feasible
    .filter((option) => PLACE_ACTIONS.has(option.action))
    .slice(0, 12)
    .map((option) => ({ action: option.action, buildingId: option.buildingId, name: option.name }));
  const actions = new Set<string>(["wait"]);
  if (buildKinds.length > 0) actions.add("build");
  for (const place of places) actions.add(place.action);
  const menu = civicMenu(context.civic);
  if (menu.proclaim) actions.add("proclaim");
  if (menu.amend) {
    actions.add("amend");
    actions.add("pardon");
  }
  const ordered = [...actions];
  return {
    actions: ordered,
    buildKinds: buildKinds.length > 0 ? [...buildKinds, "none"] : ["none"],
    places,
    rejections: (input.rejections ?? []).slice(-6),
  };
}

export function menuHasUsefulChoice(menu: MindMenu): boolean {
  return menu.actions.some((action) => action !== "wait");
}

/** A feasibility rejection will not change if the same citizen is asked again immediately. */
export function isStickyRejection(reason: string): boolean {
  return /cannot be started|unsupported|not open|not a structure|disabled|not currently feasible|no vacant|not enough|jail|detention|punitive|not in the allowed|wait is the only/.test(
    reason,
  );
}

function placeMatches(menu: MindMenu, action: string, buildingId: string): MindMenu["places"][number] | undefined {
  return menu.places.find((place) => place.action === action && place.buildingId === buildingId);
}

/**
 * Keep a model choice only when it is in the menu built from the current world.
 * Jail, detention, and fines are refused here even if a model names them.
 */
export function acceptMindChoice(
  decision: ParsedDecision,
  context: DecisionContext,
  menu: MindMenu,
): { ok: true; decision: ParsedDecision } | { ok: false; reason: string } {
  if (
    decision.buildKind === "jail" ||
    decision.action === "detain" ||
    decision.action === "levy" ||
    decision.action === "watch"
  ) {
    return { ok: false, reason: "jail, detention, fines, and watch are disabled" };
  }
  if (!menu.actions.includes(decision.action)) {
    const open = menu.actions.join(", ");
    return { ok: false, reason: `${decision.action} is not in the allowed actions (${open})` };
  }
  if (decision.action === "wait") {
    return {
      ok: true,
      decision: { ...decision, buildKind: "none", buildingId: "", placeName: null, roadStubId: "none" },
    };
  }
  if (PLACE_ACTIONS.has(decision.action)) {
    const place = placeMatches(menu, decision.action, decision.buildingId);
    if (!place) {
      const sample = menu.places
        .filter((item) => item.action === decision.action)
        .map((item) => item.buildingId)
        .slice(0, 4)
        .join(", ");
      return {
        ok: false,
        reason: sample
          ? `${decision.action} is not open at ${decision.buildingId || "that place"}. Open targets: ${sample}.`
          : `${decision.action} is not open for this citizen right now`,
      };
    }
    return {
      ok: true,
      decision: {
        ...decision,
        buildingId: place.buildingId,
        buildKind: "none",
        placeName: null,
        roadStubId: "none",
      },
    };
  }
  if (decision.action === "build") {
    if (decision.buildKind !== "road" && decision.buildKind !== "none" && !menu.buildKinds.includes(decision.buildKind)) {
      const open = menu.buildKinds.filter((kind) => kind !== "none").join(", ") || "none";
      return { ok: false, reason: `a ${decision.buildKind} cannot be started on the open land right now. Open kinds: ${open}.` };
    }
    const accepted = acceptGrowth(decision, context);
    if (!accepted.ok) return accepted;
    if (accepted.decision.buildKind !== "road" && accepted.decision.buildKind !== "none" && !menu.buildKinds.includes(accepted.decision.buildKind)) {
      return { ok: false, reason: `a ${accepted.decision.buildKind} cannot be started on the open land right now` };
    }
    return accepted;
  }
  return acceptGrowth(decision, context);
}
