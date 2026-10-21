/**
 * Social standing and wealth are summaries of rows the simulation already
 * wrote. They are not assigned ranks or coin balances.
 *
 * A meeting counts only when a social.met event names both citizens.
 * Acquainted is 1–2 distinct partners, familiar is 3–9, known is 10 or more.
 * Food rations are market visits whose payload says food was taken. The
 * ration was consumed. It is not a balance still held. Town stock stays in
 * the Storehouse.
 */

export type StandingBand = "none" | "acquainted" | "familiar" | "known";

export const STANDING_LABEL: Record<StandingBand, string> = {
  none: "No meetings recorded",
  acquainted: "Acquainted",
  familiar: "Familiar",
  known: "Known",
};

export function standingBand(acquaintances: number): StandingBand {
  if (acquaintances <= 0) {
    return "none";
  }
  if (acquaintances < 3) {
    return "acquainted";
  }
  if (acquaintances < 10) {
    return "familiar";
  }
  return "known";
}

export type StandingSourceEvent = {
  kind: "social.met" | "citizen.market_visit";
  /** This citizen was the actor, or the other party named on the event. */
  side: "actor" | "related";
  occurredAt: string;
  actorTokenId: string | null;
  relatedTokenId: string | null;
  buildingName: string | null;
  foodTaken: number;
};

export type RelationshipRecord = {
  tokenId: string;
  meetings: number;
  lastMetAt: string;
  place: string | null;
};

export type StandingSummary = {
  band: StandingBand;
  label: string;
  acquaintances: number;
  meetings: number;
  lastMetAt: string | null;
  relationships: RelationshipRecord[];
  rationsDrawn: number;
  /** True when a page cap stopped the read before the full history. */
  truncated: boolean;
};

export function summarizeStanding(events: readonly StandingSourceEvent[], truncated = false): StandingSummary {
  const partners = new Map<string, RelationshipRecord>();
  let meetings = 0;
  let lastMetAt: string | null = null;
  let rationsDrawn = 0;

  for (const event of events) {
    if (event.kind === "citizen.market_visit") {
      rationsDrawn += event.foodTaken;
      continue;
    }
    const partner = event.side === "actor" ? event.relatedTokenId : event.actorTokenId;
    if (!partner || (event.actorTokenId && event.relatedTokenId && event.actorTokenId === event.relatedTokenId)) {
      continue;
    }
    meetings += 1;
    if (!lastMetAt || event.occurredAt > lastMetAt) {
      lastMetAt = event.occurredAt;
    }
    const current = partners.get(partner);
    if (!current) {
      partners.set(partner, {
        tokenId: partner,
        meetings: 1,
        lastMetAt: event.occurredAt,
        place: event.buildingName,
      });
      continue;
    }
    current.meetings += 1;
    if (event.occurredAt >= current.lastMetAt) {
      current.lastMetAt = event.occurredAt;
      current.place = event.buildingName ?? current.place;
    }
  }

  const relationships = [...partners.values()].sort((a, b) => {
    if (b.meetings !== a.meetings) {
      return b.meetings - a.meetings;
    }
    if (a.lastMetAt !== b.lastMetAt) {
      return a.lastMetAt < b.lastMetAt ? 1 : -1;
    }
    return a.tokenId.localeCompare(b.tokenId, "en", { numeric: true });
  });
  const acquaintances = relationships.length;
  const band = standingBand(acquaintances);
  return {
    band,
    label: STANDING_LABEL[band],
    acquaintances,
    meetings,
    lastMetAt,
    relationships,
    rationsDrawn,
    truncated,
  };
}

export function socialDetail(summary: Pick<StandingSummary, "band" | "acquaintances" | "meetings" | "truncated">): string {
  if (summary.band === "none") {
    return summary.truncated
      ? "The read stopped early, and no meeting was in the rows that were read."
      : "No meeting with another citizen is recorded.";
  }
  const people = summary.acquaintances === 1 ? "1 citizen" : `${summary.acquaintances} citizens`;
  const times = summary.meetings === 1 ? "1 recorded meeting" : `${summary.meetings} recorded meetings`;
  const prefix = summary.truncated ? "From the rows read so far, met " : "Met ";
  return `${prefix}${people} in ${times}.`;
}

export function wealthDetail(rationsDrawn: number): string {
  const ration =
    rationsDrawn === 0
      ? "No food ration has been drawn from the Storehouse."
      : rationsDrawn === 1
        ? "Drew 1 food ration from the Storehouse. It was consumed on that visit and is not a balance still held."
        : `Drew ${rationsDrawn} food rations from the Storehouse. Each ration was consumed on that visit and is not a balance still held.`;
  return `${ration} Food, wood, stone, and tools produced by work stay in the Storehouse.`;
}

export function homeDetail(homeName: string | null): string {
  if (!homeName) {
    return "No private home is assigned.";
  }
  return `Assigned home: ${homeName}.`;
}
