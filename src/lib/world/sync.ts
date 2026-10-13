import type { EventFilter, WorldEventView } from "@/lib/world/types";

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
  if (filter.category && event.category !== filter.category) {
    return false;
  }
  if (filter.source && event.source !== filter.source) {
    return false;
  }
  if (filter.tokenId && event.tokenId !== filter.tokenId && event.relatedTokenId !== filter.tokenId) {
    return false;
  }
  if (filter.buildingId && event.buildingId !== filter.buildingId) {
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
