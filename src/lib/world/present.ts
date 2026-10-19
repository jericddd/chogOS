import type { BuildingKind, WorkRole } from "@/lib/world/layout";
import type {
  BuildingView,
  CitizenView,
  EventCategory,
  EventSource,
  WorldActivity,
  WorldEventView,
} from "@/lib/world/types";

export const ACTIVITY_LABEL: Record<WorldActivity, string> = {
  walking: "Walking",
  working: "Working",
  gathering: "Gathering",
  building: "Building",
  shopping: "Shopping",
  socializing: "Socializing",
  resting: "Resting",
  sleeping: "Sleeping",
  idle: "Idle",
  unavailable: "Away",
};

export const ROLE_LABEL: Record<WorkRole, string> = {
  farmer: "Farmer",
  woodcutter: "Woodcutter",
  stonecutter: "Stonecutter",
  crafter: "Crafter",
  merchant: "Merchant",
  builder: "Builder",
};

export const KIND_LABEL: Record<BuildingKind, string> = {
  house: "House",
  hall: "Shelter hall",
  commons: "Public square",
  farm: "Farm",
  forest: "Forest",
  quarry: "Quarry",
  workshop: "Workshop",
  storehouse: "Storehouse",
  market: "Market",
};

export const SOURCE_LABEL: Record<EventSource, string> = {
  simulation: "Simulation",
  ai: "AI",
  onchain: "Onchain",
  system: "System",
};

export const SOURCE_DESCRIPTION: Record<EventSource, string> = {
  simulation: "A rule-based world transition. Not an AI decision.",
  ai: "A decision made by the integrated AI mind.",
  onchain: "A Chog Genesis transfer recorded by the watcher. Explorer links appear only for a complete Monad mainnet log. Not an AI decision.",
  system: "Setup, synchronization, or operator action.",
};

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  membership: "Membership",
  citizen: "Citizens",
  movement: "Movement",
  work: "Work",
  resource: "Resources",
  construction: "Construction",
  social: "Social",
  world: "World",
  ai: "AI",
  onchain: "Onchain",
};

const PURPOSE_TEXT: Record<string, string> = {
  work: "to work",
  shop: "to shop",
  socialize: "to meet others",
  rest: "to rest",
  sleep: "to sleep",
  idle: "to wait",
};

export const RESOURCE_LABEL: Record<string, string> = {
  food: "Food",
  wood: "Wood",
  stone: "Stone",
  tools: "Tools",
};

export function citizenLabel(citizen: Pick<CitizenView, "tokenId" | "name">): string {
  const name = citizen.name?.trim();
  return name ? name : `Chog #${citizen.tokenId}`;
}

export function citizenHref(tokenId: string): string {
  return `/?citizen=${encodeURIComponent(tokenId)}`;
}

export function buildingHref(buildingId: string): string {
  return `/?building=${encodeURIComponent(buildingId)}`;
}

export function roadHref(roadId: string): string {
  return `/?road=${encodeURIComponent(roadId)}`;
}

export function profileHref(tokenId: string): string {
  return `/citizens/${encodeURIComponent(tokenId)}`;
}

export function describeCitizenNow(citizen: CitizenView, buildings: ReadonlyMap<string, BuildingView>): string {
  const place = (id: string | null) => (id ? (buildings.get(id)?.name ?? id) : "somewhere");
  switch (citizen.activity) {
    case "walking":
      return `Walking to ${place(citizen.destinationId)} ${PURPOSE_TEXT[citizen.purpose ?? "idle"]}`;
    case "unavailable":
      return "Away from the world. Membership is not active.";
    default:
      return `${ACTIVITY_LABEL[citizen.activity]} at ${place(citizen.locationId)}`;
  }
}

export type Segment = { text: string; href?: string; entity?: "citizen" | "building" };

type Entity = { label: string; href: string; entity: "citizen" | "building" };

/**
 * Splits an event summary into text and links. Only labels that the event
 * itself references are linked, so the text is never rewritten.
 */
export function eventSegments(
  event: WorldEventView,
  citizenName: (tokenId: string) => string | null,
): Segment[] {
  const entities: Entity[] = [];
  const addCitizen = (tokenId: string | null) => {
    if (!tokenId) {
      return;
    }
    const named = citizenName(tokenId);
    for (const label of new Set([named, `Chog #${tokenId}`].filter((value): value is string => Boolean(value)))) {
      entities.push({ label, href: citizenHref(tokenId), entity: "citizen" });
    }
  };
  addCitizen(event.tokenId);
  addCitizen(event.relatedTokenId);
  if (event.buildingId && event.buildingName) {
    entities.push({ label: event.buildingName, href: buildingHref(event.buildingId), entity: "building" });
  }

  const segments: Segment[] = [];
  let rest = event.summary;
  const used = new Set<string>();
  while (rest.length > 0) {
    let best: { index: number; entity: Entity } | null = null;
    for (const entity of entities) {
      if (used.has(entity.href)) {
        continue;
      }
      const index = rest.indexOf(entity.label);
      if (index >= 0 && (!best || index < best.index || (index === best.index && entity.label.length > best.entity.label.length))) {
        best = { index, entity };
      }
    }
    if (!best) {
      segments.push({ text: rest });
      break;
    }
    if (best.index > 0) {
      segments.push({ text: rest.slice(0, best.index) });
    }
    segments.push({ text: best.entity.label, href: best.entity.href, entity: best.entity.entity });
    used.add(best.entity.href);
    rest = rest.slice(best.index + best.entity.label.length);
  }
  return segments;
}
