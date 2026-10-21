import "server-only";

import { createServiceRoleClient } from "@/lib/db/client";
import { readAppConfig } from "@/lib/config/env";
import { summarizeStanding, type StandingSourceEvent, type StandingSummary } from "@/lib/civilization/standing-summary";

export type { RelationshipRecord, StandingBand, StandingSourceEvent, StandingSummary } from "@/lib/civilization/standing-summary";
export { homeDetail, socialDetail, standingBand, STANDING_LABEL, summarizeStanding, wealthDetail } from "@/lib/civilization/standing-summary";

export type CitizenStanding =
  | { status: "unconfigured"; detail: string }
  | { status: "unavailable"; detail: string }
  | {
      status: "ready";
      summary: StandingSummary;
      homeName: string | null;
      names: Record<string, string>;
    };

const PAGE = 1000;
const MAX_PAGES = 20;

type RawEvent = {
  seq: number;
  occurred_at: string;
  kind: string;
  payload: unknown;
};

function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function tokenOf(value: unknown): string | null {
  const text = textOf(value);
  if (!text) {
    return null;
  }
  const whole = text.split(".")[0];
  return whole && /^[0-9]+$/.test(whole) ? whole : null;
}

function wholeOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function toSource(row: RawEvent, side: "actor" | "related"): StandingSourceEvent | null {
  if (row.kind !== "social.met" && row.kind !== "citizen.market_visit") {
    return null;
  }
  const payload = payloadOf(row.payload);
  return {
    kind: row.kind,
    side,
    occurredAt: row.occurred_at,
    actorTokenId: tokenOf(payload.tokenId),
    relatedTokenId: tokenOf(payload.relatedTokenId),
    buildingName: textOf(payload.buildingName),
    foodTaken: wholeOf(payload.foodTaken),
  };
}

async function readKind(
  client: ReturnType<typeof createServiceRoleClient>,
  column: "actor_citizen_id" | "related_citizen_id",
  citizenId: string,
  kind: "social.met" | "citizen.market_visit",
): Promise<{ rows: RawEvent[]; truncated: boolean }> {
  const rows: RawEvent[] = [];
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = client
      .from("civilization_events")
      .select("seq, occurred_at, kind, payload")
      .eq(column, citizenId)
      .eq("kind", kind)
      .order("seq", { ascending: false })
      .limit(PAGE);
    if (before !== null) {
      query = query.lt("seq", before);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }
    const batch = (data ?? []) as RawEvent[];
    rows.push(...batch);
    if (batch.length < PAGE) {
      return { rows, truncated: false };
    }
    before = batch[batch.length - 1]?.seq ?? before;
  }
  return { rows, truncated: true };
}

export async function loadCitizenStanding(citizenId: string | null): Promise<CitizenStanding> {
  const config = readAppConfig();
  if (!citizenId) {
    return { status: "unavailable", detail: "This citizen has no database id, so standing cannot be read." };
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return { status: "unconfigured", detail: "Standing is stored with the world history. The database is not configured." };
  }
  try {
    const client = createServiceRoleClient();
    const [metAsActor, metAsRelated, market, homeRow, roster] = await Promise.all([
      readKind(client, "actor_citizen_id", citizenId, "social.met"),
      readKind(client, "related_citizen_id", citizenId, "social.met"),
      readKind(client, "actor_citizen_id", citizenId, "citizen.market_visit"),
      client.from("citizen_world_state").select("home_id").eq("citizen_id", citizenId).maybeSingle(),
      client.from("citizens").select("token_id, metadata_name"),
    ]);
    if (homeRow.error) {
      throw new Error(homeRow.error.message);
    }
    if (roster.error) {
      throw new Error(roster.error.message);
    }
    const events = [
      ...metAsActor.rows.map((row) => toSource(row, "actor")),
      ...metAsRelated.rows.map((row) => toSource(row, "related")),
      ...market.rows.map((row) => toSource(row, "actor")),
    ].filter((event): event is StandingSourceEvent => event !== null);
    const summary = summarizeStanding(events, metAsActor.truncated || metAsRelated.truncated || market.truncated);
    const homeId = (homeRow.data as { home_id?: string | null } | null)?.home_id ?? null;
    let homeName: string | null = null;
    if (homeId) {
      const building = await client.from("world_buildings").select("name").eq("id", homeId).maybeSingle();
      if (building.error) {
        throw new Error(building.error.message);
      }
      homeName = textOf((building.data as { name?: unknown } | null)?.name);
    }
    const names: Record<string, string> = {};
    for (const row of (roster.data ?? []) as Array<{ token_id: unknown; metadata_name: unknown }>) {
      const tokenId = tokenOf(row.token_id);
      const name = textOf(row.metadata_name);
      if (tokenId && name) {
        names[tokenId] = name;
      }
    }
    return { status: "ready", summary, homeName, names };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Standing could not be read.";
    return { status: "unavailable", detail: message };
  }
}
