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
  if (resolved.category && event.category !== resolved.category) {
    return false;
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
