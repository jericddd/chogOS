import type { PersonalityTraits } from "@/lib/ai/personality";
import { FOOD_SHORTAGE_ACTIVATE } from "@/lib/world/needs";

/**
 * Civic records the tick can enforce. A freeform sentence is stored as a
 * reason and does not change the simulation. Only these codes do.
 */
export const LAW_CODES = [
  "storehouse_night",
  "merchant_only",
  "ration_cap",
  "house_door",
  "ration_fine",
] as const;

export type LawCode = (typeof LAW_CODES)[number];
export type LawStatus = "proclaimed" | "amended" | "pardoned";

export const LAW_TITLE: Record<LawCode, string> = {
  storehouse_night: "Storehouse closed at night",
  merchant_only: "Only the assigned merchant sells",
  ration_cap: "A ration cap while food is under 40",
  house_door: "A house door opens only for the people who live there",
  ration_fine: "A skim draws a ration fine",
};

export const CLEAN_DAYS = 3;
export const SENTENCE_HOURS = 8;
export const JAIL_CAPACITY = 4;

/** Personality gate for proposing a skim, a wrong door, or an unsanctioned sale. */
export function proposesOffense(traits: Pick<PersonalityTraits, "cooperation" | "caution" | "resourcefulness">): boolean {
  return traits.cooperation < 45 && traits.caution < 45 && traits.resourcefulness > 55;
}

/** A cautious citizen skips a meeting when someone already marked is in the room. */
export function skipsMarkedMeeting(caution: number): boolean {
  return caution >= 60;
}

export type CivicLaw = { code: LawCode; status: LawStatus };

export type CivicFacts = {
  bankId: string | null;
  jailId: string | null;
  jailOccupants: number;
  jailCapacity: number;
  breachCount: number;
  repeatedBreach: boolean;
  shortageActive: boolean;
  unpaidFine: boolean;
  hostileCount: number;
  detainedFarmers: number;
  food: number;
  /** Token ids with a stored breach, newest first. The mind names one of these. */
  breachTokens: string[];
  laws: CivicLaw[];
};

export type CivicMenu = {
  visit: boolean;
  proclaim: boolean;
  levy: boolean;
  raiseJail: boolean;
  detain: boolean;
  watch: boolean;
  amend: boolean;
};

export function closedCivic(food = 0): CivicFacts {
  return {
    bankId: null,
    jailId: null,
    jailOccupants: 0,
    jailCapacity: 0,
    breachCount: 0,
    repeatedBreach: false,
    shortageActive: false,
    unpaidFine: false,
    hostileCount: 0,
    detainedFarmers: 0,
    food,
    breachTokens: [],
    laws: [],
  };
}

export function readCivicFacts(value: unknown): CivicFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const laws: CivicLaw[] = [];
  if (Array.isArray(body.laws)) {
    for (const item of body.laws) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const code = (item as { code?: unknown }).code;
      const status = (item as { status?: unknown }).status;
      if (
        typeof code === "string" &&
        isLawCode(code) &&
        (status === "proclaimed" || status === "amended" || status === "pardoned")
      ) {
        laws.push({ code, status });
      }
    }
  }
  const breachTokens = Array.isArray(body.breachTokens)
    ? body.breachTokens.filter((item): item is string => typeof item === "string" && /^[0-9]{1,78}$/.test(item)).slice(0, 8)
    : [];
  const count = (key: string): number => {
    const raw = body[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(0, Math.floor(raw));
    }
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
      return Number(raw);
    }
    return 0;
  };
  const id = (key: string): string | null => (typeof body[key] === "string" && body[key] ? (body[key] as string) : null);
  const breachCount = count("breachCount");
  return {
    bankId: id("bankId"),
    jailId: id("jailId"),
    jailOccupants: count("jailOccupants"),
    jailCapacity: count("jailCapacity"),
    breachCount,
    repeatedBreach: body.repeatedBreach === true || breachCount >= 2,
    shortageActive: body.shortageActive === true,
    unpaidFine: body.unpaidFine === true,
    hostileCount: count("hostileCount"),
    detainedFarmers: count("detainedFarmers"),
    food: count("food"),
    breachTokens,
    laws,
  };
}

export function isLawCode(value: string): value is LawCode {
  return (LAW_CODES as readonly string[]).includes(value);
}

export function proclaimedLaws(facts: CivicFacts): CivicLaw[] {
  return facts.laws.filter((law) => law.status === "proclaimed");
}

/**
 * Each item stays closed until the stored record supports it.
 * Day 1 can raise a park, an amusement, or the bank. It cannot proclaim.
 */
export function civicMenu(facts: CivicFacts): CivicMenu {
  const proclaimed = proclaimedLaws(facts);
  const evidence = facts.shortageActive || facts.repeatedBreach;
  const fineNamed = proclaimed.some((law) => law.code === "ration_fine");
  const room = facts.jailId !== null && facts.jailOccupants < Math.max(facts.jailCapacity, JAIL_CAPACITY);
  const crowding = facts.detainedFarmers > 0 && facts.food < FOOD_SHORTAGE_ACTIVATE && proclaimed.length > 0;
  return {
    visit: facts.bankId !== null,
    proclaim: evidence && LAW_CODES.some((code) => !facts.laws.some((law) => law.code === code)),
    levy: fineNamed && facts.breachCount > 0,
    raiseJail: proclaimed.length > 0 && facts.unpaidFine && facts.jailId === null,
    detain: proclaimed.length > 0 && facts.unpaidFine && room,
    watch: facts.hostileCount > 0,
    amend: crowding,
  };
}

export function menuOpen(menu: CivicMenu): boolean {
  return Object.values(menu).some(Boolean);
}

/**
 * Hostile is standing derived from stored breaches. Nobody starts marked.
 * The mark fades after a sentence and a run of clean world days.
 */
export function hostileFromRecord(input: {
  breaches: number;
  releasedWorldS: number | null;
  latestBreachWorldS: number | null;
  worldS: number;
}): boolean {
  if (input.breaches < 2) {
    return false;
  }
  if (input.releasedWorldS === null) {
    return true;
  }
  if (input.latestBreachWorldS !== null && input.latestBreachWorldS > input.releasedWorldS) {
    return true;
  }
  return input.worldS < input.releasedWorldS + CLEAN_DAYS * 86_400;
}

export function civicLines(facts: CivicFacts): string[] {
  const menu = civicMenu(facts);
  const lines: string[] = [];
  const proclaimed = proclaimedLaws(facts);
  if (proclaimed.length === 0) {
    lines.push(
      "No statute is stored. Work runs from 05:00 to 18:00 for two shifts, the market from 07:00 to 20:00, people gather after 07:00, and a house door opens for the people who live there. Those are customs.",
    );
  } else {
    lines.push(
      `Proclaimed at Commons Hall: ${proclaimed.map((law) => `${LAW_TITLE[law.code]} (${law.code})`).join("; ")}.`,
    );
  }
  const loosened = facts.laws.filter((law) => law.status !== "proclaimed");
  if (loosened.length > 0) {
    lines.push(`Amended or pardoned: ${loosened.map((law) => `${law.code} is ${law.status}`).join("; ")}.`);
  }
  if (menu.visit && facts.bankId) {
    lines.push(
      `ChogBank stands (${facts.bankId}). A visit during market hours reads the public books. It does not move MON or $CHOG.`,
    );
  }
  if (facts.breachCount > 0) {
    const who = facts.breachTokens.length > 0 ? ` Tokens with a stored breach: ${facts.breachTokens.join(", ")}.` : "";
    lines.push(
      `${facts.breachCount} breach${facts.breachCount === 1 ? " is" : "s are"} stored.${facts.repeatedBreach ? " That is a repeated breach." : ""}${who}`,
    );
  }
  if (facts.shortageActive) {
    lines.push("A food shortage has stayed active.");
  }
  if (menu.proclaim) {
    const open = LAW_CODES.filter((code) => !facts.laws.some((law) => law.code === code));
    lines.push(`One law from the catalog can be proclaimed: ${open.join(", ")}.`);
  }
  if (menu.levy) {
    lines.push("A proclaimed law names a ration fine. That fine can be levied against a citizen who has a stored breach.");
  }
  if (facts.unpaidFine) {
    lines.push("A fine could not be taken because the storehouse had no food.");
  }
  if (menu.raiseJail) {
    lines.push("A sentence needs a room. The jail can be raised on an open road-connected lot. It has no job.");
  }
  if (facts.jailId) {
    lines.push(
      `The jail (${facts.jailId}) holds ${facts.jailOccupants} of ${Math.max(facts.jailCapacity, JAIL_CAPACITY)}.`,
    );
  }
  if (menu.detain) {
    lines.push("A sentenced citizen can be detained. Release is its own record when the hours end.");
  }
  if (facts.hostileCount > 0) {
    lines.push(
      `${facts.hostileCount} citizen${facts.hostileCount === 1 ? " is" : "s are"} marked from stored conduct. They can still farm. A watch is an ordinary shift at the storehouse door or the square.`,
    );
  }
  if (menu.watch) {
    lines.push("One watch shift can be posted.");
  }
  if (menu.amend) {
    lines.push(
      `${facts.detainedFarmers} farmer${facts.detainedFarmers === 1 ? " is" : "s are"} detained while food is under ${FOOD_SHORTAGE_ACTIVATE}. A proclaimed law can be amended or pardoned.`,
    );
  }
  return lines;
}
