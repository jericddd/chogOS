import { CONSTRUCT_KINDS, type BuildingKind, type ConstructKind, type WorkRole } from "@/lib/world/layout";
import {
  EVENT_CATEGORIES,
  EVENT_SOURCES,
  type BuildingView,
  type CitizenView,
  type ClockView,
  type EventCategory,
  type EventSource,
  type TownNeedEvidence,
  type TownNeedStatus,
  type TownNeedType,
  type TownNeedView,
  type TownRecommendedAction,
  type WorldActivity,
  type WorldEventView,
  type WorldPurpose,
} from "@/lib/world/types";

type Num = number | string | null;

function num(value: Num): number {
  return value === null ? 0 : Number(value);
}

function numOrNull(value: Num | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function tokenText(value: Num): string {
  return String(value).split(".")[0] ?? String(value);
}

export const WORLD_STATE_COLUMNS =
  "status, speed, anchor_real, anchor_world_s, tick_seq, last_tick_at, last_tick_world_s, last_tick_gap_s, last_tick_failed, last_error_at, max_lag_seconds, walk_world_s_per_tile, layout_version, layout_hash";

export type WorldStateRow = {
  status: "running" | "paused";
  speed: Num;
  anchor_real: string;
  anchor_world_s: Num;
  tick_seq: Num;
  last_tick_at: string;
  last_tick_world_s: Num;
  last_tick_gap_s: Num;
  last_tick_failed: Num;
  last_error_at: string | null;
  max_lag_seconds: Num;
  walk_world_s_per_tile: Num;
  layout_version: string;
  layout_hash: string;
};

export function toClock(row: WorldStateRow, serverNow: Date): ClockView {
  return {
    status: row.status,
    speed: num(row.speed),
    anchorReal: row.anchor_real,
    anchorWorldS: num(row.anchor_world_s),
    tickSeq: num(row.tick_seq),
    lastTickAt: row.last_tick_at,
    lastTickWorldS: num(row.last_tick_world_s),
    lastTickGapS: numOrNull(row.last_tick_gap_s),
    lastTickFailed: num(row.last_tick_failed),
    lastErrorAt: row.last_error_at,
    maxLagSeconds: num(row.max_lag_seconds),
    walkWorldSPerTile: num(row.walk_world_s_per_tile),
    layoutVersion: row.layout_version,
    layoutHash: row.layout_hash,
    serverNow: serverNow.toISOString(),
  };
}

export const BUILDING_COLUMNS =
  "id, kind, name, x, y, w, h, door_x, door_y, capacity, job_slots, role, open_air, status, construction_progress, batch_shifts, production_progress, batches_completed, stock, completed_at, updated_tick";

export type BuildingRow = {
  id: string;
  kind: BuildingKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door_x: number;
  door_y: number;
  capacity: number | null;
  job_slots: number | null;
  role: WorkRole | null;
  open_air: boolean;
  status: "active" | "under_construction";
  construction_progress: number | null;
  batch_shifts: number | null;
  production_progress: number;
  batches_completed: number;
  stock: unknown;
  completed_at: string | null;
  updated_tick: Num;
};

function toStock(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const stock: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    const parsed = Number(amount);
    if (Number.isFinite(parsed)) {
      stock[key] = parsed;
    }
  }
  return stock;
}

export function toBuilding(row: BuildingRow): BuildingView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    doorX: row.door_x,
    doorY: row.door_y,
    capacity: row.capacity,
    jobSlots: row.job_slots,
    role: row.role,
    openAir: row.open_air,
    status: row.status,
    constructionProgress: row.construction_progress,
    batchShifts: row.batch_shifts,
    productionProgress: row.production_progress,
    batchesCompleted: row.batches_completed,
    stock: toStock(row.stock),
    completedAt: row.completed_at,
    updatedTick: num(row.updated_tick),
  };
}

export const CITIZEN_COLUMNS =
  "role, home_id, work_id, activity, location_id, origin_id, destination_id, purpose, started_at, ends_at, world_started_s, world_ends_s, day_index, shifts_today, decision_source, updated_tick, citizens!inner(token_id, metadata_name, origin)";

type CitizenJoin = { token_id: Num; metadata_name: string | null; origin: string };

export type CitizenRow = {
  role: WorkRole | null;
  home_id: string | null;
  work_id: string | null;
  activity: WorldActivity;
  location_id: string | null;
  origin_id: string | null;
  destination_id: string | null;
  purpose: WorldPurpose | null;
  started_at: string;
  ends_at: string | null;
  world_started_s: Num;
  world_ends_s: Num;
  day_index: number;
  shifts_today: number;
  decision_source: "simulation" | "ai" | "system";
  updated_tick: Num;
  citizens: CitizenJoin | CitizenJoin[] | null;
};

export function toCitizen(row: CitizenRow): CitizenView | null {
  const joined = Array.isArray(row.citizens) ? row.citizens[0] : row.citizens;
  if (!joined) {
    return null;
  }
  const name = joined.metadata_name?.trim();
  return {
    tokenId: tokenText(joined.token_id),
    name: name ? name : null,
    origin: joined.origin === "community" ? "community" : "founding",
    role: row.role,
    homeId: row.home_id,
    workId: row.work_id,
    activity: row.activity,
    locationId: row.location_id,
    originId: row.origin_id,
    destinationId: row.destination_id,
    purpose: row.purpose,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    worldStartedS: num(row.world_started_s),
    worldEndsS: numOrNull(row.world_ends_s),
    shiftsToday: row.shifts_today,
    dayIndex: row.day_index,
    decisionSource: row.decision_source,
    updatedTick: num(row.updated_tick),
  };
}

export const EVENT_COLUMNS =
  "id, seq, kind, category, source, summary, occurred_at, world_s, tick_seq, building_id, chain_status, tx_hash, payload, intent_id, decision_id";

export type EventRow = {
  id: string;
  seq: Num;
  kind: string;
  category: string | null;
  source: string | null;
  summary: string;
  occurred_at: string;
  world_s: Num;
  tick_seq: Num;
  building_id: string | null;
  chain_status: "offchain" | "submitted" | "confirmed";
  tx_hash: string | null;
  payload: unknown;
  intent_id?: string | null;
  decision_id?: string | null;
};

function payloadText(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asSource(value: string | null): EventSource {
  return EVENT_SOURCES.includes(value as EventSource) ? (value as EventSource) : "system";
}

function asCategory(value: string | null): EventCategory {
  return EVENT_CATEGORIES.includes(value as EventCategory) ? (value as EventCategory) : "membership";
}

export function toEvent(row: EventRow): WorldEventView {
  return {
    id: row.id,
    seq: num(row.seq),
    kind: row.kind,
    category: asCategory(row.category),
    source: asSource(row.source),
    summary: row.summary,
    occurredAt: row.occurred_at,
    worldS: numOrNull(row.world_s),
    tickSeq: numOrNull(row.tick_seq),
    tokenId: payloadText(row.payload, "tokenId"),
    relatedTokenId: payloadText(row.payload, "relatedTokenId"),
    buildingId: row.building_id,
    buildingName: payloadText(row.payload, "buildingName"),
    chainStatus: row.chain_status,
    txHash: row.tx_hash,
    intentId: row.intent_id ?? payloadText(row.payload, "intentId"),
    decisionId: row.decision_id ?? payloadText(row.payload, "decisionId"),
  };
}

export const TOWN_NEED_COLUMNS =
  "need_type, status, priority, first_detected_at, last_evaluated_at, last_status_changed_at, resolved_at, evidence, blocker, recommended_action, recommended_kind, last_event_id, last_decision_id";

export type TownNeedRow = {
  need_type: string;
  status: string;
  priority: Num;
  first_detected_at: string | null;
  last_evaluated_at: string | null;
  last_status_changed_at: string | null;
  resolved_at: string | null;
  evidence: unknown;
  blocker: string | null;
  recommended_action: string | null;
  recommended_kind: string | null;
  last_event_id: string | null;
  last_decision_id: string | null;
};

function asNeedType(value: string): TownNeedType | null {
  return value === "food_shortage" || value === "tools_shortage" || value === "materials_shortage"
    ? value
    : null;
}

function asNeedStatus(value: string): TownNeedStatus {
  return value === "active" || value === "blocked" || value === "resolved" || value === "inactive"
    ? value
    : "inactive";
}

function asRecommendedAction(value: string | null): TownRecommendedAction {
  return value === "work" || value === "build" ? value : "none";
}

function asRecommendedKind(value: string | null): ConstructKind | "none" {
  return value && (CONSTRUCT_KINDS as readonly string[]).includes(value) ? (value as ConstructKind) : "none";
}

function asEvidence(value: unknown): TownNeedEvidence {
  const body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const underRaw = Array.isArray(body.underConstruction) ? body.underConstruction : [];
  return {
    food: num((body.food as Num) ?? 0),
    wood: num((body.wood as Num) ?? 0),
    stone: num((body.stone as Num) ?? 0),
    tools: num((body.tools as Num) ?? 0),
    vacantServedLots: num((body.vacantServedLots as Num) ?? 0),
    reservedLots: num((body.reservedLots as Num) ?? 0),
    farms: num((body.farms as Num) ?? 0),
    workshops: num((body.workshops as Num) ?? 0),
    houses: num((body.houses as Num) ?? 0),
    underConstruction: underRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .slice(0, 8)
      .map((item) => ({
        id: String(item.id ?? ""),
        kind: String(item.kind ?? ""),
        progress: numOrNull(item.progress as Num | undefined),
      })),
  };
}

export function toTownNeed(row: TownNeedRow): TownNeedView | null {
  const needType = asNeedType(row.need_type);
  if (!needType) {
    return null;
  }
  return {
    needType,
    status: asNeedStatus(row.status),
    priority: num(row.priority),
    firstDetectedAt: row.first_detected_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastStatusChangedAt: row.last_status_changed_at,
    resolvedAt: row.resolved_at,
    evidence: asEvidence(row.evidence),
    blocker: row.blocker,
    recommendedAction: asRecommendedAction(row.recommended_action),
    recommendedKind: asRecommendedKind(row.recommended_kind),
    lastEventId: row.last_event_id,
    lastDecisionId: row.last_decision_id,
  };
}
