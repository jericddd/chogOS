import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import {
  BUILDING_COLUMNS,
  CITIZEN_COLUMNS,
  EVENT_COLUMNS,
  ROAD_COLUMNS,
  TOWN_NEED_COLUMNS,
  TOWN_PROJECT_COLUMNS,
  WORLD_STATE_COLUMNS,
  toBuilding,
  toCitizen,
  toClock,
  toEvent,
  toRoad,
  toTownNeed,
  toTownProject,
  type BuildingRow,
  type CitizenRow,
  type EventRow,
  type RoadRow,
  type TownNeedRow,
  type TownProjectRow,
  type WorldStateRow,
} from "@/lib/world/rows";
import { ONCHAIN_CATEGORY_FILTER, resolveEventFilter } from "@/lib/world/sync";
import type {
  CitizenView,
  EventFilter,
  EventPage,
  RoadOverlayView,
  TownNeedView,
  TownProjectView,
  WorldEventView,
  WorldLive,
  WorldLoad,
  WorldSnapshot,
  WorldUnavailable,
} from "@/lib/world/types";

export const SNAPSHOT_EVENTS = 40;
export const LIVE_EVENT_LIMIT = 100;
export const PAGE_LIMIT_MAX = 50;

type DbError = { code?: string; message: string };

function missingTable(error: DbError): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    error.code === "42703" ||
    /schema cache|does not exist|could not find the table|column .* does not exist/i.test(error.message)
  );
}

class WorldReadError extends Error {
  constructor(readonly unavailable: WorldUnavailable) {
    super(unavailable.detail);
  }
}

function fail(error: DbError, what: string): never {
  if (missingTable(error)) {
    throw new WorldReadError({
      status: "migration_pending",
      detail: "The Phase 3 world migration has not been applied to this database yet.",
    });
  }
  throw new WorldReadError({ status: "error", detail: `Could not read ${what}. ${error.message}` });
}

function openClient(): SupabaseClient {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new WorldReadError({
      status: "unconfigured",
      detail: "Supabase is not configured on this server, so the shared world cannot be read.",
    });
  }
  return createServiceRoleClient();
}

async function guard<T>(run: () => Promise<T>): Promise<T | WorldUnavailable> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorldReadError) {
      return error.unavailable;
    }
    return { status: "error", detail: error instanceof Error ? error.message : "The world could not be read." };
  }
}

async function readState(client: SupabaseClient) {
  const { data, error } = await client.from("world_state").select(WORLD_STATE_COLUMNS).maybeSingle();
  if (error) {
    fail(error, "the world clock");
  }
  if (!data) {
    throw new WorldReadError({
      status: "not_initialized",
      detail: "The world tables exist but the world has not been initialized. Run npm run world:init on a trusted machine.",
    });
  }
  return data as WorldStateRow;
}

async function readBuildings(client: SupabaseClient) {
  const { data, error } = await client.from("world_buildings").select(BUILDING_COLUMNS).order("id");
  if (error) {
    fail(error, "buildings");
  }
  return ((data ?? []) as BuildingRow[]).map(toBuilding);
}

async function readCitizens(client: SupabaseClient): Promise<CitizenView[]> {
  const { data, error } = await client.from("citizen_world_state").select(CITIZEN_COLUMNS);
  if (error) {
    fail(error, "citizens");
  }
  return ((data ?? []) as unknown as CitizenRow[])
    .map(toCitizen)
    .filter((citizen): citizen is CitizenView => citizen !== null)
    .sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
}

function applyFilter<Q extends { eq: (column: string, value: string) => Q; or: (filters: string) => Q }>(
  query: Q,
  filter: EventFilter,
): Q {
  const resolved = resolveEventFilter(filter);
  let next = query;
  if (resolved.category === "onchain") {
    next = next.or(ONCHAIN_CATEGORY_FILTER);
  } else if (resolved.category) {
    next = next.eq("category", resolved.category);
  }
  if (resolved.source) {
    next = next.eq("source", resolved.source);
  }
  if (resolved.buildingId) {
    next = next.eq("building_id", resolved.buildingId);
  }
  if (resolved.tokenId) {
    next = next.or(`payload->>tokenId.eq.${resolved.tokenId},payload->>relatedTokenId.eq.${resolved.tokenId}`);
  }
  return next;
}

function eventQuery(
  client: SupabaseClient,
  columns: string,
  options: { after?: number; before?: number; limit: number; filter?: EventFilter },
) {
  let query = client.from("civilization_events").select(columns);
  if (options.after !== undefined) {
    query = query.gt("seq", options.after);
  }
  if (options.before !== undefined) {
    query = query.lt("seq", options.before);
  }
  if (options.filter) {
    query = applyFilter(query, options.filter);
  }
  return query.order("seq", { ascending: false }).limit(options.limit);
}

function missingCanonical(error: DbError): boolean {
  return /canonical/i.test(error.message) && /does not exist|schema cache|42703/i.test(error.message);
}

async function readEvents(
  client: SupabaseClient,
  options: { after?: number; before?: number; limit: number; filter?: EventFilter },
): Promise<WorldEventView[]> {
  let result = await eventQuery(client, `${EVENT_COLUMNS}, canonical`, options);
  if (result.error && missingCanonical(result.error)) {
    result = await eventQuery(client, EVENT_COLUMNS, options);
  }
  if (result.error) {
    fail(result.error, "history");
  }
  const events = ((result.data ?? []) as unknown as EventRow[]).filter((row) => row.canonical !== false).map(toEvent);
  return attachMind(client, events);
}

function mindText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text.slice(0, 400) : null;
}

/** Join stored model words onto events that already point at an AI decision. Never invents a row. */
async function attachMind(client: SupabaseClient, events: WorldEventView[]): Promise<WorldEventView[]> {
  const ids = [
    ...new Set(
      events.flatMap((event) =>
        event.decisionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.decisionId)
          ? [event.decisionId]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) {
    return events;
  }
  const { data, error } = await client.from("ai_decisions").select("id, rationale, output").in("id", ids);
  if (error || !data) {
    return events;
  }
  const byId = new Map<string, NonNullable<WorldEventView["mind"]>>();
  for (const row of data as Array<{ id?: string; rationale?: unknown; output?: unknown }>) {
    if (!row.id) {
      continue;
    }
    const output =
      row.output && typeof row.output === "object" && !Array.isArray(row.output)
        ? (row.output as Record<string, unknown>)
        : null;
    const mind = {
      summary: mindText(output?.summary),
      rationale: mindText(row.rationale) ?? mindText(output?.rationale) ?? mindText(output?.reason),
    };
    if (mind.summary || mind.rationale) {
      byId.set(row.id, mind);
    }
  }
  return events.map((event) => {
    const mind = event.decisionId ? byId.get(event.decisionId) : undefined;
    return mind ? { ...event, mind } : event;
  });
}

async function readTownNeeds(client: SupabaseClient): Promise<{ ready: boolean; needs: TownNeedView[] }> {
  const { data, error } = await client.from("town_needs").select(TOWN_NEED_COLUMNS).order("priority", { ascending: false });
  if (error) {
    if (missingTable(error)) {
      return { ready: false, needs: [] };
    }
    fail(error, "town needs");
  }
  return {
    ready: true,
    needs: ((data ?? []) as TownNeedRow[]).map(toTownNeed).filter((need): need is TownNeedView => need !== null),
  };
}

async function readRoads(client: SupabaseClient): Promise<{ ready: boolean; roads: RoadOverlayView[] }> {
  const { data, error } = await client.from("world_roads").select(ROAD_COLUMNS).order("id");
  if (error) {
    if (missingTable(error)) {
      return { ready: false, roads: [] };
    }
    fail(error, "roads");
  }
  return {
    ready: true,
    roads: ((data ?? []) as RoadRow[]).map(toRoad).filter((road): road is RoadOverlayView => road !== null),
  };
}

async function readTownProjects(client: SupabaseClient): Promise<{ ready: boolean; projects: TownProjectView[] }> {
  const { data, error } = await client
    .from("town_projects")
    .select(TOWN_PROJECT_COLUMNS)
    .order("priority", { ascending: false });
  if (error) {
    if (missingTable(error)) {
      return { ready: false, projects: [] };
    }
    fail(error, "town projects");
  }
  return {
    ready: true,
    projects: ((data ?? []) as TownProjectRow[])
      .map(toTownProject)
      .filter((project): project is TownProjectView => project !== null),
  };
}

async function readSnapshot(client: SupabaseClient, events: Promise<WorldEventView[]>): Promise<WorldSnapshot> {
  const [state, buildings, citizens, list, townNeeds, roads, townProjects] = await Promise.all([
    readState(client),
    readBuildings(client),
    readCitizens(client),
    events,
    readTownNeeds(client),
    readRoads(client),
    readTownProjects(client),
  ]);
  return {
    status: "ok",
    clock: toClock(state, new Date()),
    buildings,
    citizens,
    events: list,
    latestSeq: list[0]?.seq ?? 0,
    townNeeds: townNeeds.needs,
    townNeedsReady: townNeeds.ready,
    roads: roads.roads,
    roadsReady: roads.ready,
    townProjects: townProjects.projects,
    townProjectsReady: townProjects.ready,
  };
}

/** Full public world view. Read with the service role on the server, never in the browser. */
export function loadWorld(): Promise<WorldLoad> {
  return guard(async () => {
    const client = openClient();
    return readSnapshot(client, readEvents(client, { limit: SNAPSHOT_EVENTS }));
  });
}

/**
 * Current state plus events newer than `since`. Citizens and buildings are
 * always complete, so a client that missed updates reconciles on its next read.
 */
export function loadLive(since: number | null): Promise<WorldLive | WorldUnavailable> {
  return guard(async () => {
    const client = openClient();
    const fresh = since === null;
    const snapshot = await readSnapshot(
      client,
      readEvents(client, fresh ? { limit: SNAPSHOT_EVENTS } : { after: since, limit: LIVE_EVENT_LIMIT + 1 }),
    );
    const gap = fresh || snapshot.events.length > LIVE_EVENT_LIMIT;
    const events = snapshot.events.slice(0, fresh ? SNAPSHOT_EVENTS : LIVE_EVENT_LIMIT);
    return {
      ...snapshot,
      events,
      latestSeq: Math.max(events[0]?.seq ?? 0, since ?? 0),
      since: since ?? 0,
      gap,
    };
  });
}

export function loadEventPage(filter: EventFilter, before: number | null, limit: number): Promise<EventPage> {
  return guard(async () => {
    const client = openClient();
    const size = Math.max(1, Math.min(PAGE_LIMIT_MAX, limit));
    const rows = await readEvents(client, {
      before: before ?? undefined,
      limit: size + 1,
      filter,
    });
    const events = rows.slice(0, size);
    const last = events.at(-1);
    return {
      status: "ok" as const,
      events,
      nextBefore: rows.length > size && last ? last.seq : null,
    };
  });
}

/** One citizen's place in the world, for profile pages. */
export async function loadCitizenWorld(tokenId: string): Promise<
  | { status: "ok"; citizen: CitizenView | null; snapshot: WorldSnapshot }
  | WorldUnavailable
> {
  const world = await loadWorld();
  if (world.status !== "ok") {
    return world;
  }
  return {
    status: "ok",
    citizen: world.citizens.find((citizen) => citizen.tokenId === tokenId) ?? null,
    snapshot: world,
  };
}

export function realtimeConfig(): { url: string; anonKey: string; channel: string } | null {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }
  return { url: config.supabaseUrl, anonKey: config.supabaseAnonKey, channel: "chogos-world" };
}
