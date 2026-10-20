import { ACTIVATION_MOTIVES, type ActivationMotive } from "@/lib/chogbank/types";
import type { EconomyDraft } from "@/lib/economy/proposal";
import { parseEconomyDraft } from "@/lib/economy/proposal";
import { CONSTRUCT_KINDS, type ConstructKind } from "@/lib/world/layout";
import { WORLD_ACTIONS, type WorldAction } from "@/lib/world/actions";

export const DECISION_ACTIONS = [...WORLD_ACTIONS, "build", "request_wallet_activation", "propose_economy"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
export type DecisionBuildKind = ConstructKind | "road" | "none";

export type ParsedDecision = {
  action: DecisionAction;
  buildingId: string;
  buildKind: DecisionBuildKind;
  roadStubId: string | "none";
  goalId: string | null;
  projectId: string | null;
  summary: string;
  rationale: string;
  activationMotive: ActivationMotive | null;
  proposedOnchainActions: string | null;
  revenueHypothesis: string | null;
  claimedDeploymentWei: bigint | null;
  claimedGasWei: bigint | null;
  economy: EconomyDraft | null;
};

export const DECISION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...DECISION_ACTIONS] },
    buildingId: { type: "string" },
    buildKind: { type: "string", enum: [...CONSTRUCT_KINDS, "road", "none"] },
    roadStubId: { type: "string" },
    goalId: { type: "string" },
    projectId: { type: "string" },
    summary: { type: "string" },
    rationale: { type: "string" },
    activationMotive: { type: "string", enum: [...ACTIVATION_MOTIVES] },
    proposedOnchainActions: { type: "string" },
    revenueHypothesis: { type: "string" },
    estimatedDeploymentWei: { type: "string" },
    estimatedGasWei: { type: "string" },
    economy: { type: "object" },
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
  if (action === "request_wallet_activation" || action === "propose_economy") {
    if (buildingId && buildingId !== "none" && !BUILDING_RE.test(buildingId)) {
      return { ok: false, reason: "invalid building id" };
    }
  } else if (action !== "build") {
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
      if (!stub || stub.length > 80 || /https?:\/\//i.test(stub)) {
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
  const projectRaw = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const projectId = projectRaw && UUID_RE.test(projectRaw) ? projectRaw : null;

  let activationMotive: ActivationMotive | null = null;
  let proposedOnchainActions: string | null = null;
  let revenueHypothesis: string | null = null;
  let claimedDeploymentWei: bigint | null = null;
  let claimedGasWei: bigint | null = null;
  let economy: EconomyDraft | null = null;
  if (action === "propose_economy") {
    const economyBody = asRecord(body.economy) ?? {};
    const draft = parseEconomyDraft({
      ...economyBody,
      objective: typeof economyBody.objective === "string" ? economyBody.objective : summary,
      rationale: typeof economyBody.rationale === "string" ? economyBody.rationale : rationale,
    });
    if (!draft.ok) {
      return draft;
    }
    economy = draft.draft;
  }
  if (action === "request_wallet_activation") {
    const motive = typeof body.activationMotive === "string" ? body.activationMotive : "";
    if (!(ACTIVATION_MOTIVES as readonly string[]).includes(motive)) {
      return { ok: false, reason: "activation motive is required" };
    }
    const proposed = typeof body.proposedOnchainActions === "string" ? clip(body.proposedOnchainActions, 320) : "";
    if (!proposed) {
      return { ok: false, reason: "proposed onchain actions are required" };
    }
    const deployWei = parseWei(body.estimatedDeploymentWei);
    const gasWei = parseWei(body.estimatedGasWei);
    if (deployWei === null || gasWei === null) {
      return { ok: false, reason: "activation cost estimates must be non-negative integer wei" };
    }
    activationMotive = motive as ActivationMotive;
    proposedOnchainActions = proposed;
    revenueHypothesis = typeof body.revenueHypothesis === "string" ? clip(body.revenueHypothesis, 240) : "";
    claimedDeploymentWei = deployWei;
    claimedGasWei = gasWei;
  }

  return {
    ok: true,
    decision: {
      action: action as DecisionAction,
      buildingId: action === "build" || action === "request_wallet_activation" || action === "propose_economy" ? "" : buildingId,
      buildKind,
      roadStubId,
      goalId,
      projectId,
      summary,
      rationale,
      activationMotive,
      proposedOnchainActions,
      revenueHypothesis,
      claimedDeploymentWei,
      claimedGasWei,
      economy,
    },
  };
}

function parseWei(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      return null;
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

export function isWorldAction(action: DecisionAction): action is WorldAction {
  return (WORLD_ACTIONS as readonly string[]).includes(action);
}

export function isActivationAction(action: DecisionAction): boolean {
  return action === "request_wallet_activation";
}

export function isEconomyAction(action: DecisionAction): boolean {
  return action === "propose_economy";
}

export function jsonSafeDecision(decision: ParsedDecision): Record<string, unknown> {
  return {
    ...decision,
    claimedDeploymentWei: decision.claimedDeploymentWei?.toString() ?? null,
    claimedGasWei: decision.claimedGasWei?.toString() ?? null,
    economy: decision.economy
      ? {
          ...decision.economy,
          amountRaw: decision.economy.amountRaw.toString(10),
          estimatedGasWei: decision.economy.estimatedGasWei.toString(10),
          fundingRequestRaw: decision.economy.fundingRequestRaw.toString(10),
          quotePriceRaw: decision.economy.quotePriceRaw?.toString(10) ?? null,
        }
      : null,
  };
}
