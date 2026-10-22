import {
  EVENT_CATEGORIES,
  EVENT_SOURCES,
  type EventCategory,
  type EventFilter,
  type EventSource,
  type WorldEventView,
} from "@/lib/world/types";

function oneParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Category `ai` is a discovery alias for `source=ai`. Real AI construction
 * rows are stored with categories such as construction, not category=ai.
 */
export function resolveEventFilter(filter: EventFilter): EventFilter {
  if (filter.category !== "ai") {
    return filter;
  }
  const resolved: EventFilter = { ...filter, source: "ai" };
  delete resolved.category;
  return resolved;
}

/** Latest qualifying AI construction row, or null. Never invents a fallback event. */
export function pickAiConstructionEvent(events: readonly WorldEventView[]): WorldEventView | null {
  return events.find((event) => event.source === "ai" && event.category === "construction") ?? null;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * A wallet row the issuer stored after Monad confirmed AccountCreated.
 * The row stays source=ai and category=ai. History is append-only, so the
 * Onchain category includes it by this check instead of rewriting the row.
 */
export function isConfirmedAiWallet(event: WorldEventView): boolean {
  return (
    event.source === "ai" &&
    event.kind === "wallet.created" &&
    event.chainStatus === "confirmed" &&
    typeof event.txHash === "string" &&
    TX_HASH.test(event.txHash)
  );
}

/**
 * PostgREST `or` filter for the Onchain category.
 * `wallet.created` is quoted because the kind contains a dot.
 */
export const ONCHAIN_CATEGORY_FILTER =
  'category.eq.onchain,and(source.eq.ai,kind.eq."wallet.created",chain_status.eq.confirmed)';

const TOWN_GROWTH_KINDS = new Set(["wallet.created", "wallet.decided"]);

/** Civic acts the mind recorded. Simulation breaches stay on the activity feed. */
const CIVIC_GROWTH_KINDS = new Set([
  "civic.law_proclaimed",
  "civic.fine",
  "civic.fine_unpaid",
  "civic.sentenced",
  "civic.released",
  "civic.law_amended",
  "civic.pardoned",
  "civic.watch",
  "civic.marked",
  "citizen.bank_visit",
]);

/** Roads and buildings, plus AI wallet decisions. A created wallet replaces that token's earlier decision. */
export function townGrowthEvents(events: readonly WorldEventView[], limit = 8): WorldEventView[] {
  const createdTokens = new Set(
    events
      .filter((event) => event.source === "ai" && event.kind === "wallet.created" && event.tokenId)
      .map((event) => event.tokenId as string),
  );
  const kept = events.filter((event) => {
    if (event.source !== "ai") {
      return false;
    }
    const construction = event.category === "construction";
    const wallet = TOWN_GROWTH_KINDS.has(event.kind);
    const civic = CIVIC_GROWTH_KINDS.has(event.kind);
    if (!construction && !wallet && !civic) {
      return false;
    }
    if (event.kind === "wallet.decided" && event.tokenId && createdTokens.has(event.tokenId)) {
      return false;
    }
    return true;
  });
  return mergeEvents(kept, [], limit);
}

/** History/search query → filter. Unknown values are ignored. */
export function eventFilterFromSearch(
  params: Record<string, string | string[] | undefined>,
): EventFilter {
  const filter: EventFilter = {};
  const category = oneParam(params.category);
  const source = oneParam(params.source);
  const citizen = oneParam(params.citizen);
  const building = oneParam(params.building);
  if (category && (EVENT_CATEGORIES as readonly string[]).includes(category)) {
    filter.category = category as EventCategory;
  }
  if (source && (EVENT_SOURCES as readonly string[]).includes(source)) {
    filter.source = source as EventSource;
  }
  if (citizen && /^[0-9]{1,78}$/.test(citizen)) {
    filter.tokenId = citizen;
  }
  if (building && /^[a-z0-9-]{2,40}$/.test(building)) {
    filter.buildingId = building;
  }
  return filter;
}

/** UI filter as History URL query params. Does not apply the AI category alias. */
export function eventFilterSearchParams(filter: EventFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.category) params.set("category", filter.category);
  if (filter.source) params.set("source", filter.source);
  if (filter.tokenId) params.set("citizen", filter.tokenId);
  if (filter.buildingId) params.set("building", filter.buildingId);
  return params;
}

/** Newest first, one row per id. A row seen twice keeps the later copy. */
export function mergeEvents(
  current: readonly WorldEventView[],
  incoming: readonly WorldEventView[],
  cap = Number.POSITIVE_INFINITY,
): WorldEventView[] {
  const byId = new Map<string, WorldEventView>();
  for (const event of current) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  const merged = [...byId.values()].sort((a, b) => b.seq - a.seq);
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

export function latestSeq(events: readonly WorldEventView[], fallback = 0): number {
  return events.reduce((max, event) => Math.max(max, event.seq), fallback);
}

export function oldestSeq(events: readonly WorldEventView[]): number | null {
  if (events.length === 0) {
    return null;
  }
  return events.reduce((min, event) => Math.min(min, event.seq), Number.POSITIVE_INFINITY);
}

export function matchesFilter(event: WorldEventView, filter: EventFilter): boolean {
  const resolved = resolveEventFilter(filter);
  if (resolved.category) {
    const onchainWallet = resolved.category === "onchain" && isConfirmedAiWallet(event);
    if (event.category !== resolved.category && !onchainWallet) {
      return false;
    }
  }
  if (resolved.source && event.source !== resolved.source) {
    return false;
  }
  if (resolved.tokenId && event.tokenId !== resolved.tokenId && event.relatedTokenId !== resolved.tokenId) {
    return false;
  }
  if (resolved.buildingId && event.buildingId !== resolved.buildingId) {
    return false;
  }
  return true;
}

export function filterKey(filter: EventFilter): string {
  return [filter.category ?? "", filter.source ?? "", filter.tokenId ?? "", filter.buildingId ?? ""].join("|");
}

export type FeedState = {
  /** Shown rows, newest first. */
  shown: WorldEventView[];
  /** Live rows held back while the reader is away from the top of the feed. */
  pending: WorldEventView[];
};

/**
 * Adds live rows to the feed. When the reader is at the top they appear
 * directly. Otherwise they wait behind the New activity indicator so the
 * list does not jump under the reader.
 */
export function receiveLive(
  state: FeedState,
  incoming: readonly WorldEventView[],
  filter: EventFilter,
  atTop: boolean,
): FeedState {
  const known = new Set([...state.shown, ...state.pending].map((event) => event.id));
  const fresh = incoming.filter((event) => matchesFilter(event, filter) && !known.has(event.id));
  if (fresh.length === 0) {
    return state;
  }
  if (atTop) {
    return { shown: mergeEvents(state.shown, fresh), pending: state.pending };
  }
  return { shown: state.shown, pending: mergeEvents(state.pending, fresh) };
}

export function revealPending(state: FeedState): FeedState {
  if (state.pending.length === 0) {
    return state;
  }
  return { shown: mergeEvents(state.shown, state.pending), pending: [] };
}
