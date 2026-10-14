import type { BuildingKind, WorkRole } from "@/lib/world/layout";

export type WorldActivity =
  | "walking"
  | "working"
  | "gathering"
  | "building"
  | "shopping"
  | "socializing"
  | "resting"
  | "sleeping"
  | "idle"
  | "unavailable";

export type WorldPurpose = "work" | "shop" | "socialize" | "rest" | "sleep" | "idle";

export type EventSource = "simulation" | "ai" | "onchain" | "system";

export type EventCategory =
  | "membership"
  | "citizen"
  | "movement"
  | "work"
  | "resource"
  | "construction"
  | "social"
  | "world"
  | "ai"
  | "onchain";

export const EVENT_SOURCES: readonly EventSource[] = ["simulation", "ai", "onchain", "system"];
export const EVENT_CATEGORIES: readonly EventCategory[] = [
  "membership",
  "citizen",
  "movement",
  "work",
  "resource",
  "construction",
  "social",
  "world",
  "ai",
  "onchain",
];

/** The shared world clock as stored by the server. Real times are ISO UTC strings. */
export type ClockView = {
  status: "running" | "paused";
  speed: number;
  anchorReal: string;
  anchorWorldS: number;
  tickSeq: number;
  lastTickAt: string;
  lastTickWorldS: number;
  lastTickGapS: number | null;
  lastTickFailed: number;
  lastErrorAt: string | null;
  maxLagSeconds: number;
  walkWorldSPerTile: number;
  layoutVersion: string;
  layoutHash: string;
  /** Server time when this view was read. Lets browsers correct for clock skew. */
  serverNow: string;
};

export type CitizenView = {
  tokenId: string;
  name: string | null;
  origin: "founding" | "community";
  role: WorkRole | null;
  homeId: string | null;
  workId: string | null;
  activity: WorldActivity;
  locationId: string | null;
  originId: string | null;
  destinationId: string | null;
  purpose: WorldPurpose | null;
  startedAt: string;
  endsAt: string | null;
  worldStartedS: number;
  worldEndsS: number | null;
  shiftsToday: number;
  dayIndex: number;
  decisionSource: "simulation" | "ai" | "system";
  updatedTick: number;
};

export type BuildingView = {
  id: string;
  kind: BuildingKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  doorX: number;
  doorY: number;
  capacity: number | null;
  jobSlots: number | null;
  role: WorkRole | null;
  openAir: boolean;
  status: "active" | "under_construction";
  constructionProgress: number | null;
  batchShifts: number | null;
  productionProgress: number;
  batchesCompleted: number;
  /** Simulated stock. Not a token balance. */
  stock: Record<string, number>;
  completedAt: string | null;
  updatedTick: number;
};

export type WorldEventView = {
  id: string;
  seq: number;
  kind: string;
  category: EventCategory;
  source: EventSource;
  summary: string;
  occurredAt: string;
  worldS: number | null;
  tickSeq: number | null;
  tokenId: string | null;
  relatedTokenId: string | null;
  buildingId: string | null;
  buildingName: string | null;
  chainStatus: "offchain" | "submitted" | "confirmed";
  txHash: string | null;
  intentId?: string | null;
  decisionId?: string | null;
};

export type RealtimeConfig = { url: string; anonKey: string; channel: string };

export type WorldUnavailable = {
  status: "unconfigured" | "migration_pending" | "not_initialized" | "error";
  detail: string;
};

export type WorldSnapshot = {
  status: "ok";
  clock: ClockView;
  buildings: BuildingView[];
  citizens: CitizenView[];
  /** Newest first. */
  events: WorldEventView[];
  latestSeq: number;
};

export type WorldLoad = WorldSnapshot | WorldUnavailable;

/** A live refresh. Citizens and buildings are complete lists. Events are only those after `since`. */
export type WorldLive = WorldSnapshot & {
  since: number;
  /** True when more events arrived than were returned, so the client must reload its feed. */
  gap: boolean;
};

export type EventFilter = {
  category?: EventCategory;
  source?: EventSource;
  tokenId?: string;
  buildingId?: string;
};

export type EventPage =
  | { status: "ok"; events: WorldEventView[]; nextBefore: number | null }
  | WorldUnavailable;
