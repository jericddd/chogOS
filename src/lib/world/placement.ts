import {
  BUILDINGS,
  CONSTRUCT_KINDS,
  GRID_H,
  GRID_W,
  PLOTS,
  ROADS,
  inBounds,
  inRect,
  isWaterTile,
  pathOn,
  rectsOverlap,
  walkableOn,
  type ConstructKind,
  type PathBuilding,
  type Rect,
  type RouteRow,
  type Tile,
} from "@/lib/world/layout";
import { isRoadAt } from "@/lib/world/roads";
import type { BuildingView } from "@/lib/world/types";

export type { ConstructKind };

export type SurveyedPlot = {
  id: string;
  rect: Rect;
  served: boolean;
};

function plotId(rect: Rect): string {
  return `plot-${rect.x}-${rect.y}`;
}

/** Lots whose door can touch a road. East y=2 lots are reserved until overlay roads reach them. */
export function surveyedPlots(overlay: readonly Tile[] = []): SurveyedPlot[] {
  return PLOTS.map((rect) => ({
    id: plotId(rect),
    rect,
    served: doorsTouchingRoad(rect, overlay).length > 0,
  }));
}

export function doorsTouchingRoad(rect: Rect, overlay: readonly Tile[] = []): Tile[] {
  const doors: Tile[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const neighbors: Tile[] = [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
      ];
      if (
        neighbors.some(
          (tile) => inBounds(tile.x, tile.y) && isRoadAt(tile.x, tile.y, overlay) && !inRect(rect, tile.x, tile.y),
        )
      ) {
        doors.push({ x, y });
      }
    }
  }
  return doors;
}

export function chooseDoor(rect: Rect, overlay: readonly Tile[] = []): Tile | null {
  const doors = doorsTouchingRoad(rect, overlay);
  if (doors.length === 0) {
    return null;
  }
  const midX = rect.x + Math.floor(rect.w / 2);
  const midY = rect.y + Math.floor(rect.h / 2);
  return [...doors].sort((a, b) => {
    const da = Math.abs(a.x - midX) + Math.abs(a.y - midY);
    const db = Math.abs(b.x - midX) + Math.abs(b.y - midY);
    return da - db || a.y - b.y || a.x - b.x;
  })[0]!;
}

export function toPathBuilding(building: Pick<BuildingView, "id" | "kind" | "x" | "y" | "w" | "h" | "doorX" | "doorY">): PathBuilding {
  return {
    id: building.id,
    kind: building.kind,
    rect: { x: building.x, y: building.y, w: building.w, h: building.h },
    door: { x: building.doorX, y: building.doorY },
  };
}

export function nextConstructionId(kind: ConstructKind, existingIds: readonly string[]): string {
  let max = 0;
  const pattern = new RegExp(`^${kind}-(\\d+)$`);
  for (const id of existingIds) {
    const match = pattern.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  const seeded = BUILDINGS.filter((building) => building.kind === kind).length;
  return `${kind}-${String(Math.max(max, seeded) + 1).padStart(2, "0")}`;
}

export function nextHouseId(existingIds: readonly string[]): string {
  return nextConstructionId("house", existingIds);
}

export function constructionName(kind: ConstructKind, buildingId: string): string {
  const index = /^[a-z]+-(\d+)$/.exec(buildingId)?.[1] ?? "01";
  if (kind === "house") {
    return `House ${index}`;
  }
  if (kind === "farm") {
    return `Farm ${index}`;
  }
  return `Workshop ${index}`;
}

export type PlacementPlan = {
  plotId: string;
  buildingId: string;
  name: string;
  kind: ConstructKind;
  rect: Rect;
  door: Tile;
  routes: RouteRow[];
};

function plotBlocked(
  plot: SurveyedPlot,
  occupiedRects: readonly Rect[],
  overlay: readonly Tile[] = [],
): boolean {
  if (occupiedRects.some((rect) => rectsOverlap(rect, plot.rect))) {
    return true;
  }
  for (let index = 0; index < plot.rect.w * plot.rect.h; index += 1) {
    const x = plot.rect.x + (index % plot.rect.w);
    const y = plot.rect.y + Math.floor(index / plot.rect.w);
    if (isWaterTile(x, y) || isRoadAt(x, y, overlay)) {
      return true;
    }
  }
  return false;
}

/**
 * Chooses the next vacant road-served lot, a door on that road, and a complete
 * route table. Kind comes from the caller. Coordinates never come from the model.
 */
export function planConstruction(
  buildings: readonly Pick<BuildingView, "id" | "kind" | "name" | "x" | "y" | "w" | "h" | "doorX" | "doorY">[],
  occupiedPlotIds: ReadonlySet<string> = new Set(),
  kind: ConstructKind = "house",
  overlay: readonly Tile[] = [],
): { ok: true; plan: PlacementPlan } | { ok: false; reason: string } {
  if (!CONSTRUCT_KINDS.includes(kind)) {
    return { ok: false, reason: "unsupported construction kind" };
  }
  const existing = buildings.map(toPathBuilding);
  const occupiedRects = buildings.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const plots = surveyedPlots(overlay).filter((plot) => plot.served && !occupiedPlotIds.has(plot.id));

  for (const plot of plots) {
    if (plotBlocked(plot, occupiedRects, overlay)) {
      continue;
    }
    const door = chooseDoor(plot.rect, overlay);
    if (!door) {
      continue;
    }
    const buildingId = nextConstructionId(
      kind,
      buildings.map((building) => building.id),
    );
    const added: PathBuilding = {
      id: buildingId,
      kind,
      rect: plot.rect,
      door,
    };
    const all = [...existing, added];
    const grid = walkableOn(GRID_W, GRID_H, ROADS, all, overlay);
    const routes: RouteRow[] = [];
    let connected = true;
    for (const other of existing) {
      const outbound = pathOn(added, other, GRID_W, GRID_H, grid);
      const inbound = pathOn(other, added, GRID_W, GRID_H, grid);
      if (!outbound || !inbound) {
        connected = false;
        break;
      }
      routes.push({ from: added.id, to: other.id, steps: Math.max(1, outbound.length - 1) });
      routes.push({ from: other.id, to: added.id, steps: Math.max(1, inbound.length - 1) });
    }
    if (!connected) {
      continue;
    }
    return {
      ok: true,
      plan: {
        plotId: plot.id,
        buildingId,
        name: constructionName(kind, buildingId),
        kind,
        rect: plot.rect,
        door,
        routes,
      },
    };
  }

  return { ok: false, reason: "no vacant road-served plot is available" };
}

export function planHousePlacement(
  buildings: readonly Pick<BuildingView, "id" | "kind" | "name" | "x" | "y" | "w" | "h" | "doorX" | "doorY">[],
  occupiedPlotIds: ReadonlySet<string> = new Set(),
  overlay: readonly Tile[] = [],
): { ok: true; plan: PlacementPlan } | { ok: false; reason: string } {
  return planConstruction(buildings, occupiedPlotIds, "house", overlay);
}
