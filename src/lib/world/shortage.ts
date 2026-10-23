import type { ConstructKind } from "@/lib/world/layout";
import {
  FOOD_SHORTAGE_ACTIVATE,
  FOOD_SHORTAGE_RECOVER,
  STONE_CONSTRUCTION_ACTIVATE,
  STONE_CONSTRUCTION_RECOVER,
  TOOLS_SHORTAGE_ACTIVATE,
  TOOLS_SHORTAGE_RECOVER,
  WOOD_CONSTRUCTION_ACTIVATE,
  WOOD_CONSTRUCTION_RECOVER,
} from "@/lib/world/needs";

export type StockResource = "food" | "wood" | "stone" | "tools";
export type ShortageSeverity = "ok" | "low" | "critical";

export type ResourcePressure = {
  resource: StockResource;
  stock: number;
  severity: ShortageSeverity;
  activatesBelow: number;
  recoversAt: number;
  /** Role whose existing work shift restores this resource. Null when construction is the recovery. */
  gatherRole: "farmer" | "woodcutter" | "stonecutter" | "crafter" | null;
};

const OPTIONAL_WOOD_KINDS = new Set<ConstructKind>(["house", "park", "amusement", "bank", "jail"]);

function severity(stock: number, activate: number, recover: number): ShortageSeverity {
  if (stock < activate) return "critical";
  if (stock < recover) return "low";
  return "ok";
}

/** Stock pressure for every simulated resource. Thresholds match the town-need engine. */
export function resourcePressures(stock: {
  food: number;
  wood: number;
  stone: number;
  tools: number;
}): ResourcePressure[] {
  return [
    {
      resource: "food",
      stock: stock.food,
      severity: severity(stock.food, FOOD_SHORTAGE_ACTIVATE, FOOD_SHORTAGE_RECOVER),
      activatesBelow: FOOD_SHORTAGE_ACTIVATE,
      recoversAt: FOOD_SHORTAGE_RECOVER,
      gatherRole: "farmer",
    },
    {
      resource: "wood",
      stock: stock.wood,
      severity: severity(stock.wood, WOOD_CONSTRUCTION_ACTIVATE, WOOD_CONSTRUCTION_RECOVER),
      activatesBelow: WOOD_CONSTRUCTION_ACTIVATE,
      recoversAt: WOOD_CONSTRUCTION_RECOVER,
      gatherRole: "woodcutter",
    },
    {
      resource: "stone",
      stock: stock.stone,
      severity: severity(stock.stone, STONE_CONSTRUCTION_ACTIVATE, STONE_CONSTRUCTION_RECOVER),
      activatesBelow: STONE_CONSTRUCTION_ACTIVATE,
      recoversAt: STONE_CONSTRUCTION_RECOVER,
      gatherRole: "stonecutter",
    },
    {
      resource: "tools",
      stock: stock.tools,
      severity: severity(stock.tools, TOOLS_SHORTAGE_ACTIVATE, TOOLS_SHORTAGE_RECOVER),
      activatesBelow: TOOLS_SHORTAGE_ACTIVATE,
      recoversAt: TOOLS_SHORTAGE_RECOVER,
      gatherRole: "crafter",
    },
  ];
}

export function pressureFor(pressures: readonly ResourcePressure[], resource: StockResource): ResourcePressure {
  return pressures.find((item) => item.resource === resource) ?? pressures[0]!;
}

/**
 * Drop optional wood-consuming construction while wood or stone is short.
 * A critical material line already cannot start a builder shift. A low line
 * keeps farms and workshops, which are the recovery buildings, and drops
 * leisure, houses, and the bank until the storehouse recovers.
 */
export function constructionKindsForShortage(
  kinds: readonly ConstructKind[],
  stock: { food: number; wood: number; stone: number; tools: number },
): ConstructKind[] {
  const pressures = resourcePressures(stock);
  const wood = pressureFor(pressures, "wood");
  const stone = pressureFor(pressures, "stone");
  const open = kinds.filter((kind) => kind !== "jail");
  if (wood.severity === "critical" || stone.severity === "critical") {
    return [];
  }
  if (wood.severity === "low" || stone.severity === "low") {
    return open.filter((kind) => !OPTIONAL_WOOD_KINDS.has(kind));
  }
  return open;
}

export function roadsDeferredForShortage(stock: { wood: number; stone: number }): boolean {
  const pressures = resourcePressures({ food: 0, tools: 0, wood: stock.wood, stone: stock.stone });
  return pressureFor(pressures, "wood").severity !== "ok" || pressureFor(pressures, "stone").severity !== "ok";
}

export function shortageLines(stock: { food: number; wood: number; stone: number; tools: number }): string[] {
  return resourcePressures(stock)
    .filter((item) => item.severity !== "ok")
    .map((item) => {
      const who = item.gatherRole ? ` A ${item.gatherRole} shift is the supported way to restore it.` : "";
      if (item.severity === "critical") {
        return `${item.resource} is critical at ${item.stock} (below ${item.activatesBelow}). Optional construction that spends it waits.${who}`;
      }
      return `${item.resource} is low at ${item.stock}. It recovers at ${item.recoversAt}. Leisure and extra houses wait.${who}`;
    });
}
