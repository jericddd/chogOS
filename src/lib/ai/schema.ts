import { CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";
import { ROAD_STUB_IDS } from "@/lib/world/roads";
import { WORLD_ACTIONS, type WorldAction } from "@/lib/world/actions";

export const DECISION_ACTIONS = [...WORLD_ACTIONS, "build"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
export type DecisionBuildKind = ConstructKind | "road" | "none";

export type ParsedDecision = {
  action: DecisionAction;
  buildingId: string;
  buildKind: DecisionBuildKind;
  roadStubId: string | "none";
  goalId: string | null;
  summary: string;
  rationale: string;
};

export const DECISION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...DECISION_ACTIONS] },
    buildingId: { type: "string" },
    buildKind: { type: "string", enum: [...CONSTRUCT_KINDS, "road", "none"] },
    roadStubId: { type: "string" },
    goalId: { type: "string" },
    summary: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["action", "buildingId", "summary", "rationale"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILDING_RE = /^[a-z0-9-]{2,40}$/;

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isConstructKind(value: unknown): value is ConstructKind {
  return typeof value === "string" && (CONSTRUCT_KINDS as readonly string[]).includes(value);
}

/**
 * Independent of the provider. Structured output is not trusted until this
 * passes. Extra fields (including coordinates) are dropped. SQL, URLs, and
 * code are not accepted as actions. Missing or unknown build kinds are rejected.
 */
export function parseDecisionOutput(text: string): { ok: true; decision: ParsedDecision } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { ok: false, reason: "model output was not JSON" };
    }
    try {
      raw = JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return { ok: false, reason: "model output was not JSON" };
    }
  }

  const body = asRecord(raw);
  if (!body) {
    return { ok: false, reason: "model output was not an object" };
  }

  const action = body.action;
  if (typeof action !== "string" || !DECISION_ACTIONS.includes(action as DecisionAction)) {
    return { ok: false, reason: "unsupported action" };
  }

  const buildingId = typeof body.buildingId === "string" ? body.buildingId.trim() : "";
  if (action !== "build") {
    if (!BUILDING_RE.test(buildingId)) {
      return { ok: false, reason: "invalid building id" };
    }
  } else if (buildingId && !BUILDING_RE.test(buildingId)) {
    return { ok: false, reason: "invalid building id" };
  }

  const summary = typeof body.summary === "string" ? clip(body.summary, 180) : "";
  const rationale = typeof body.rationale === "string" ? clip(body.rationale, 320) : "";
  if (!summary || !rationale) {
    return { ok: false, reason: "summary and rationale are required" };
  }
  if (/https?:\/\//i.test(summary) || /https?:\/\//i.test(rationale)) {
    return { ok: false, reason: "decision text may not include URLs" };
  }

  let buildKind: DecisionBuildKind = "none";
  let roadStubId: string | "none" = "none";
  if (action === "build") {
    if (body.buildKind === "road") {
      const stub = typeof body.roadStubId === "string" ? body.roadStubId.trim() : "";
      if (!ROAD_STUB_IDS.has(stub)) {
        return { ok: false, reason: "unknown road stub" };
      }
      buildKind = "road";
      roadStubId = stub;
    } else if (isConstructKind(body.buildKind)) {
      buildKind = body.buildKind;
    } else {
      return { ok: false, reason: "unsupported build kind" };
    }
  }

  const goalRaw = typeof body.goalId === "string" ? body.goalId.trim() : "";
  const goalId = goalRaw && UUID_RE.test(goalRaw) ? goalRaw : null;

  return {
    ok: true,
    decision: {
      action: action as DecisionAction,
      buildingId: action === "build" ? "" : buildingId,
      buildKind,
      roadStubId,
      goalId,
      summary,
      rationale,
    },
  };
}

export function isWorldAction(action: DecisionAction): action is WorldAction {
  return (WORLD_ACTIONS as readonly string[]).includes(action);
}
