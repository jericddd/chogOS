/**
 * Phase 5b catalog road stubs. The model may pick an id. Coordinates come
 * only from this file (and the matching SQL seed). Overlay tiles merge into
 * the existing walkable graph; they do not replace genesis roads.
 */
import {
  BUILDINGS,
  GRID_H,
  GRID_W,
  ROADS,
  inBounds,
  inRect,
  isRoad,
  isWaterTile,
  walkableOn,
  type Tile,
} from "@/lib/world/layout";
import type { RoadOverlayView } from "@/lib/world/types";

/** Same cost as one builder shift in world_check_action. Paid once, atomically. */
export const ROAD_STUB_WOOD = 3;
export const ROAD_STUB_STONE = 2;

export type RoadStubDef = {
  id: string;
  name: string;
  /** Tiles that bridge the y=10 highway to the reserved y=2 lots, skipping the existing y=7 strip. */
  tiles: Tile[];
  servesPlotIds: readonly string[];
};

function eastY2Spur(plotX: number): RoadStubDef {
  const x = plotX + 1;
  return {
    id: `east-y2-${plotX}`,
    name: `East spur to plot ${plotX},2`,
    tiles: [
      { x, y: 9 },
      { x, y: 8 },
      { x, y: 6 },
      { x, y: 5 },
    ],
    servesPlotIds: [`plot-${plotX}-2`],
  };
}

/** Six spurs from the connected y=10 east road up to the reserved y=2 lots. */
export const ROAD_STUBS: readonly RoadStubDef[] = [64, 68, 72, 76, 80, 84].map(eastY2Spur);

export const ROAD_STUB_IDS: ReadonlySet<string> = new Set(ROAD_STUBS.map((stub) => stub.id));

export function roadStubById(id: string): RoadStubDef | undefined {
  return ROAD_STUBS.find((stub) => stub.id === id);
}

export function tileKey(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}

export function overlayTileSet(tiles: readonly Tile[]): Set<string> {
  return new Set(tiles.map(tileKey));
}

export function completeOverlayTiles(roads: readonly Pick<RoadOverlayView, "tiles" | "status">[]): Tile[] {
  return roads.filter((road) => road.status === "complete").flatMap((road) => road.tiles);
}

export function isRoadAt(x: number, y: number, overlay: Set<string> | readonly Tile[] = []): boolean {
  if (isRoad(x, y)) {
    return true;
  }
  if (overlay instanceof Set) {
    return overlay.has(`${x},${y}`);
  }
  return overlay.some((tile) => tile.x === x && tile.y === y);
}

function cellsReachedFromTown(extra: readonly Tile[]): Set<string> {
  const width = GRID_W;
  const grid = walkableOn(width, GRID_H, ROADS, BUILDINGS, extra);
  const start = BUILDINGS.find((building) => building.id === "house-01");
  if (!start) {
    return new Set();
  }
  const origin = start.door.y * width + start.door.x;
  const seen = new Uint8Array(width * GRID_H);
  if (grid[origin] !== 1) {
    return new Set();
  }
  seen[origin] = 1;
  const queue = [origin];
  const keys = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const cx = current % width;
    const cy = Math.floor(current / width);
    keys.add(`${cx},${cy}`);
    const nx = [cx + 1, cx - 1, cx, cx];
    const ny = [cy, cy, cy + 1, cy - 1];
    for (let i = 0; i < 4; i += 1) {
      const x = nx[i]!;
      const y = ny[i]!;
      if (x < 0 || y < 0 || x >= width || y >= GRID_H) {
        continue;
      }
      const next = y * width + x;
      if (grid[next] !== 1 || seen[next] === 1) {
        continue;
      }
      seen[next] = 1;
      queue.push(next);
    }
  }
  return keys;
}

function coversBuilding(tile: Tile, buildings: readonly { x: number; y: number; w: number; h: number }[]): boolean {
  return buildings.some((building) => inRect({ x: building.x, y: building.y, w: building.w, h: building.h }, tile.x, tile.y));
}

export function validateRoadStubPlacement(input: {
  stubId: string;
  placedStubIds: ReadonlySet<string>;
  overlayTiles: readonly Tile[];
  buildings?: readonly { x: number; y: number; w: number; h: number }[];
}): { ok: true; stub: RoadStubDef } | { ok: false; reason: string } {
  const stub = roadStubById(input.stubId);
  if (!stub) {
    return { ok: false, reason: "unknown road stub" };
  }
  if (input.placedStubIds.has(stub.id)) {
    return { ok: false, reason: "road stub already placed" };
  }
  const overlay = overlayTileSet(input.overlayTiles);
  const buildings = input.buildings ?? BUILDINGS.map((building) => building.rect);
  if (stub.tiles.length === 0) {
    return { ok: false, reason: "road stub is disconnected" };
  }
  for (const tile of stub.tiles) {
    if (!inBounds(tile.x, tile.y, GRID_W, GRID_H)) {
      return { ok: false, reason: "road stub leaves the map" };
    }
    if (isRoad(tile.x, tile.y)) {
      return { ok: false, reason: "road stub overlaps an existing road" };
    }
    if (overlay.has(tileKey(tile))) {
      return { ok: false, reason: "road stub overlaps a constructed road" };
    }
    if (isWaterTile(tile.x, tile.y)) {
      return { ok: false, reason: "road stub overlaps water" };
    }
    if (coversBuilding(tile, buildings)) {
      return { ok: false, reason: "road stub overlaps a building" };
    }
  }
  const reached = cellsReachedFromTown([...input.overlayTiles, ...stub.tiles]);
  if (!stub.tiles.every((tile) => reached.has(tileKey(tile)))) {
    return { ok: false, reason: "road stub does not connect to the existing road network" };
  }
  return { ok: true, stub };
}

export function eligibleRoadStubs(input: {
  placedStubIds: ReadonlySet<string>;
  overlayTiles: readonly Tile[];
  buildings?: readonly { x: number; y: number; w: number; h: number }[];
  stock: { wood: number; stone: number };
}): RoadStubDef[] {
  if (input.stock.wood < ROAD_STUB_WOOD || input.stock.stone < ROAD_STUB_STONE) {
    return [];
  }
  return ROAD_STUBS.filter((stub) => validateRoadStubPlacement({ ...input, stubId: stub.id }).ok);
}

export function overlayRoadAt(
  x: number,
  y: number,
  roads: readonly Pick<RoadOverlayView, "id" | "tiles" | "status">[],
): (typeof roads)[number] | undefined {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return roads.find(
    (road) => road.status === "complete" && road.tiles.some((tile) => tile.x === tx && tile.y === ty),
  );
}

export function describeRoadsBanner(
  roads: readonly Pick<RoadOverlayView, "name">[],
  ready: boolean,
): { title: string; detail: string } {
  if (!ready) {
    return {
      title: "Road overlay is not in this database yet",
      detail: "The Phase 5b migration has not been applied. Base layout roads are unchanged.",
    };
  }
  if (roads.length === 0) {
    return {
      title: "No constructed road spurs yet",
      detail: "The mind may choose a catalog stub. Coordinates come from the server catalog.",
    };
  }
  return {
    title: `${roads.length} completed road ${roads.length === 1 ? "spur" : "spurs"}`,
    detail: roads.map((road) => road.name).join(" · "),
  };
}
