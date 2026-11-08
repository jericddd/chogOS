import type { BuildingView, CitizenView } from "@/lib/world/types";
import type { WorkRole } from "@/lib/world/layout";
import {
  CONSTRUCTION_SHIFT_STONE,
  CONSTRUCTION_SHIFT_WOOD,
  STOREHOUSE_CAPACITY,
  materialsAllowBuilderShift,
} from "@/lib/world/needs";
import { pressureFor, resourcePressures, type ShortageSeverity } from "@/lib/world/shortage";

export type GatherResource = "food" | "wood" | "stone" | "tools";

export type ShiftRosterMember = {
  tokenId: string;
  role: WorkRole | null;
  workId: string | null;
};

export type ShiftOffer = {
  buildingId: string;
  name: string;
  role: WorkRole;
  resource: GatherResource | "construction";
  reason: string;
};

const PRODUCED: Partial<Record<WorkRole, GatherResource>> = {
  farmer: "food",
  woodcutter: "wood",
  stonecutter: "stone",
  crafter: "tools",
};

const GATHER_ROLE: Record<GatherResource, WorkRole> = {
  food: "farmer",
  wood: "woodcutter",
  stone: "stonecutter",
  tools: "crafter",
};

/** Wood and stone come first when two goods are equally short, because a builder shift spends them. */
const SCARCITY_RANK: Record<GatherResource, number> = {
  wood: 0,
  stone: 1,
  food: 2,
  tools: 3,
};

type Stock = { food: number; wood: number; stone: number; tools: number };

export function producedResource(role: WorkRole | null | undefined): GatherResource | null {
  return role ? (PRODUCED[role] ?? null) : null;
}

export function resourceAtCap(amount: number): boolean {
  return amount >= STOREHOUSE_CAPACITY;
}

function byToken(a: string, b: string): number {
  const left = a.replace(/\D/g, "");
  const right = b.replace(/\D/g, "");
  if (left.length !== right.length) return left.length - right.length;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The gatherable good furthest below the storehouse cap. A full storehouse has no short good. */
export function shortResource(stock: Stock): GatherResource | null {
  const open = (Object.keys(GATHER_ROLE) as GatherResource[])
    .filter((resource) => stock[resource] < STOREHOUSE_CAPACITY)
    .sort((a, b) => stock[a] - stock[b] || SCARCITY_RANK[a] - SCARCITY_RANK[b]);
  return open[0] ?? null;
}

const SEVERITY_RANK: Record<ShortageSeverity, number> = { critical: 0, low: 1, ok: 2 };

/** A good below its recover line. Critical lines come before low lines. */
export function lackingResource(stock: Stock): GatherResource | null {
  const found = [...resourcePressures(stock)].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.stock - b.stock ||
      SCARCITY_RANK[a.resource] - SCARCITY_RANK[b.resource],
  )[0];
  return found && found.severity !== "ok" ? found.resource : null;
}

function focusResource(stock: Stock): GatherResource | null {
  return lackingResource(stock) ?? shortResource(stock);
}

/** A shift can change when this good is full, or when another good is actually short. */
export function canLeaveShift(role: WorkRole | null | undefined, stock: Stock): boolean {
  const mine = producedResource(role);
  if (!mine || !role) return false;
  const pressures = resourcePressures(stock);
  if (pressureFor(pressures, mine).severity !== "ok") return false;
  const focus = focusResource(stock);
  if (!focus || focus === mine) return false;
  if (resourceAtCap(stock[mine])) return true;
  return pressureFor(pressures, focus).severity !== "ok";
}

function lackSentence(resource: GatherResource, stock: Stock): string {
  const pressure = pressureFor(resourcePressures(stock), resource);
  if (pressure.severity === "critical") {
    return `${resource} is lacking at ${stock[resource]}, below ${pressure.activatesBelow}.`;
  }
  if (pressure.severity === "low") {
    return `${resource} is lacking at ${stock[resource]}. It recovers at ${pressure.recoversAt}.`;
  }
  return `${resource} is the short good at ${stock[resource]}.`;
}

export function shiftBrief(role: CitizenView["role"], stock: Stock): string | null {
  if (!canLeaveShift(role, stock)) return null;
  const mine = producedResource(role);
  const focus = focusResource(stock);
  if (!mine || !focus || !role) return null;
  const own = resourceAtCap(stock[mine])
    ? `${mine} is at the storehouse cap of ${STOREHOUSE_CAPACITY}.`
    : `${mine} is at ${stock[mine]}, above its recover line.`;
  const next = lackingResource(stock)
    ? `The useful change is a ${GATHER_ROLE[focus]} shift.`
    : `The useful change is a ${GATHER_ROLE[focus]} shift, or a builder shift on an unfinished building when the storehouse can pay for one.`;
  return `${lackSentence(focus, stock)} ${own} This ${role} shift is not permanent. ${next}`;
}

function workplaceFor(resource: GatherResource, buildings: readonly BuildingView[], roster: readonly ShiftRosterMember[]): BuildingView | null {
  const role = GATHER_ROLE[resource];
  const open = buildings.filter((building) => building.status === "active" && building.role === role);
  if (open.length === 0) return null;
  const load = (id: string) => roster.filter((member) => member.workId === id && member.role === role).length;
  return [...open].sort((a, b) => load(a.id) - load(b.id) || a.id.localeCompare(b.id))[0] ?? null;
}

function unstaffedSites(buildings: readonly BuildingView[], roster: readonly ShiftRosterMember[]): BuildingView[] {
  return buildings
    .filter(
      (building) =>
        building.status === "under_construction" &&
        !roster.some((member) => member.role === "builder" && member.workId === building.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One citizen, one next shift. A job is not permanent.
 * Someone can leave when their good is full, or when another good is below its recover line.
 * Someone whose own good is the one in lack stays on it.
 * While no good is actually short, the first of those citizens staff unfinished buildings
 * the storehouse can pay for. A real shortage is harvested instead of spent on construction.
 */
export function shiftOfferFor(input: {
  tokenId: string;
  role: WorkRole | null;
  stock: Stock;
  buildings: readonly BuildingView[];
  roster: readonly ShiftRosterMember[];
}): ShiftOffer | null {
  const mine = producedResource(input.role);
  if (!mine || !canLeaveShift(input.role, input.stock)) return null;

  const movers = input.roster
    .filter((member) => canLeaveShift(member.role, input.stock))
    .sort((a, b) => byToken(a.tokenId, b.tokenId));
  const index = movers.findIndex((member) => member.tokenId === input.tokenId);
  if (index < 0) return null;

  const lacking = lackingResource(input.stock);
  const payableShifts =
    lacking === null && materialsAllowBuilderShift(input.stock)
      ? Math.min(
          Math.floor(input.stock.wood / CONSTRUCTION_SHIFT_WOOD),
          Math.floor(input.stock.stone / CONSTRUCTION_SHIFT_STONE),
        )
      : 0;
  const sites = unstaffedSites(input.buildings, input.roster).slice(0, payableShifts);
  if (index < sites.length) {
    const site = sites[index]!;
    return {
      buildingId: site.id,
      name: site.name,
      role: "builder",
      resource: "construction",
      reason: `${site.name} is under construction with no builder. ${mine} is at the storehouse cap of ${STOREHOUSE_CAPACITY}, and the storehouse can pay a builder shift. This ${input.role} leaves that work for a builder shift.`,
    };
  }

  const short = focusResource(input.stock);
  if (!short || short === mine) return null;
  const place = workplaceFor(short, input.buildings, input.roster);
  if (!place) return null;
  const own = resourceAtCap(input.stock[mine])
    ? `${mine} is at the storehouse cap of ${STOREHOUSE_CAPACITY}.`
    : `${mine} is at ${input.stock[mine]}, above its recover line.`;
  return {
    buildingId: place.id,
    name: place.name,
    role: GATHER_ROLE[short],
    resource: short,
    reason: `${lackSentence(short, input.stock)} ${own} This ${input.role} leaves the current shift for ${place.name}.`,
  };
}
