import type { BuildingView, CitizenView } from "@/lib/world/types";
import type { WorkRole } from "@/lib/world/layout";
import {
  CONSTRUCTION_SHIFT_STONE,
  CONSTRUCTION_SHIFT_WOOD,
  STOREHOUSE_CAPACITY,
  materialsAllowBuilderShift,
} from "@/lib/world/needs";

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

export function shiftBrief(role: CitizenView["role"], stock: Stock): string | null {
  const short = shortResource(stock);
  if (!short) return null;
  const full = (Object.keys(GATHER_ROLE) as GatherResource[]).filter((resource) => resourceAtCap(stock[resource]));
  if (full.length === 0) return null;
  const mine = producedResource(role);
  const fullText = full.join(", ");
  const cap = `${fullText} ${full.length === 1 ? "is" : "are"} at the storehouse cap of ${STOREHOUSE_CAPACITY}.`;
  const shortText = `${short} is the short good at ${stock[short]}.`;
  if (mine && resourceAtCap(stock[mine])) {
    return `${cap} ${shortText} This ${role} shift is on a full good, so the useful change is a ${GATHER_ROLE[short]} shift, or a builder shift on an unfinished building when the storehouse can pay for one.`;
  }
  return `${cap} ${shortText}`;
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
 * One citizen, one next shift.
 * Someone whose good is already full can leave it. The first of those citizens
 * take the unfinished buildings that have no builder. The rest harvest the short good.
 * One worker stays on each full workplace so the job is not abandoned.
 */
export function shiftOfferFor(input: {
  tokenId: string;
  role: WorkRole | null;
  stock: Stock;
  buildings: readonly BuildingView[];
  roster: readonly ShiftRosterMember[];
}): ShiftOffer | null {
  const mine = producedResource(input.role);
  if (!mine || !resourceAtCap(input.stock[mine])) return null;

  const stayers = new Set<string>();
  const byWorkplace = new Map<string, ShiftRosterMember[]>();
  for (const member of input.roster) {
    const produced = producedResource(member.role);
    if (!member.workId || !produced || !resourceAtCap(input.stock[produced])) continue;
    const group = byWorkplace.get(member.workId) ?? [];
    group.push(member);
    byWorkplace.set(member.workId, group);
  }
  for (const group of byWorkplace.values()) {
    const keeper = [...group].sort((a, b) => byToken(a.tokenId, b.tokenId))[0];
    if (keeper) stayers.add(keeper.tokenId);
  }
  if (stayers.has(input.tokenId)) return null;

  const movers = input.roster
    .filter((member) => {
      const produced = producedResource(member.role);
      return Boolean(produced && resourceAtCap(input.stock[produced]) && !stayers.has(member.tokenId));
    })
    .sort((a, b) => byToken(a.tokenId, b.tokenId));
  const index = movers.findIndex((member) => member.tokenId === input.tokenId);
  if (index < 0) return null;

  const payableShifts = materialsAllowBuilderShift(input.stock)
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
      reason: `${site.name} is under construction with no builder. The storehouse can pay a builder shift, and this citizen's current good is already full.`,
    };
  }

  const short = shortResource(input.stock);
  if (!short || short === mine) return null;
  const place = workplaceFor(short, input.buildings, input.roster);
  if (!place) return null;
  return {
    buildingId: place.id,
    name: place.name,
    role: GATHER_ROLE[short],
    resource: short,
    reason: `${mine} is at the storehouse cap of ${STOREHOUSE_CAPACITY} and ${short} is the short good at ${input.stock[short]}. This shift moves to ${place.name}.`,
  };
}
