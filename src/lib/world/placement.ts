import {
  BUILDINGS,
  GRID_H,
  GRID_W,
  PLOTS,
  ROADS,
  inBounds,
  inRect,
  isRoad,
  isWaterTile,
  pathOn,
  rectsOverlap,
  walkableOn,
  type PathBuilding,
  type Rect,
  type RouteRow,
  type Tile,
} from "@/lib/world/layout";
import type { BuildingView } from "@/lib/world/types";

export type SurveyedPlot = {
  id: string;
  rect: Rect;
  served: boolean;
};

function plotId(rect: Rect): string {
  return `plot-${rect.x}-${rect.y}`;
}

/** Lots whose door can touch a road. East y=2 lots are reserved until roads reach them. */
export function surveyedPlots(): SurveyedPlot[] {
  return PLOTS.map((rect) => ({
    id: plotId(rect),
    rect,
    served: doorsTouchingRoad(rect).length > 0,
  }));
}

export function doorsTouchingRoad(rect: Rect): Tile[] {
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
          (tile) => inBounds(tile.x, tile.y) && isRoad(tile.x, tile.y) && !inRect(rect, tile.x, tile.y),
        )
      ) {
        doors.push({ x, y });
      }
    }
  }
  return doors;
}

export function chooseDoor(rect: Rect): Tile | null {
  const doors = doorsTouchingRoad(rect);
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

export function nextHouseId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const match = /^house-(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `house-${String(Math.max(max, BUILDINGS.filter((b) => b.kind === "house").length) + 1).padStart(2, "0")}`;
}

export type PlacementPlan = {
  plotId: string;
  buildingId: string;
  name: string;
  rect: Rect;
  door: Tile;
  routes: RouteRow[];
};

export function planHousePlacement(
  buildings: readonly Pick<BuildingView, "id" | "kind" | "name" | "x" | "y" | "w" | "h" | "doorX" | "doorY">[],
  occupiedPlotIds: ReadonlySet<string> = new Set(),
): { ok: true; plan: PlacementPlan } | { ok: false; reason: string } {
  const existing = buildings.map(toPathBuilding);
  const occupiedRects = buildings.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const plots = surveyedPlots().filter((plot) => plot.served && !occupiedPlotIds.has(plot.id));

  for (const plot of plots) {
    if (occupiedRects.some((rect) => rectsOverlap(rect, plot.rect))) {
      continue;
    }
    if (
      [...Array(plot.rect.w * plot.rect.h).keys()].some((index) => {
        const x = plot.rect.x + (index % plot.rect.w);
        const y = plot.rect.y + Math.floor(index / plot.rect.w);
        return isWaterTile(x, y) || isRoad(x, y);
      })
    ) {
      continue;
    }
    const door = chooseDoor(plot.rect);
    if (!door) {
      continue;
    }
    const buildingId = nextHouseId(buildings.map((b) => b.id));
    const added: PathBuilding = {
      id: buildingId,
      kind: "house",
      rect: plot.rect,
      door,
    };
    const all = [...existing, added];
    const grid = walkableOn(GRID_W, GRID_H, ROADS, all);
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
    const index = Number(/^house-(\d+)$/.exec(buildingId)?.[1] ?? 0);
    return {
      ok: true,
      plan: {
        plotId: plot.id,
        buildingId,
        name: `House ${String(index).padStart(2, "0")}`,
        rect: plot.rect,
        door,
        routes,
      },
    };
  }

  return { ok: false, reason: "no vacant road-served plot is available" };
}
