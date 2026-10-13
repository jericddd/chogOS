import { GENESIS_V1_GRID_H, GENESIS_V1_GRID_W, GRID_H, GRID_W, TILE, hash32, pathBetween, type Tile } from "@/lib/world/layout";
import type { BuildingView, CitizenView } from "@/lib/world/types";

export const WORLD_PX_W = GRID_W * TILE;
export const WORLD_PX_H = GRID_H * TILE;
export const SETTLEMENT_PX_W = GENESIS_V1_GRID_W * TILE;
export const SETTLEMENT_PX_H = GENESIS_V1_GRID_H * TILE;

export type Placement = {
  tokenId: string;
  /** Tile coordinates of the sprite's feet. Fractional while walking. */
  x: number;
  y: number;
  visible: boolean;
  /** Enclosed building that hides this citizen, if any. */
  insideId: string | null;
  moving: boolean;
  facing: 1 | -1;
};

/** Open places show their occupants. Houses, the hall, workshops, and the storehouse hide them. */
export function showsOccupants(building: BuildingView): boolean {
  return building.openAir || building.status === "under_construction";
}

function interiorCells(building: BuildingView): Tile[] {
  const cells: Tile[] = [];
  const inset = building.w >= 5 && building.h >= 4 ? 1 : 0;
  for (let y = building.y + inset; y < building.y + building.h - inset; y += 1) {
    for (let x = building.x + inset; x < building.x + building.w - inset; x += 1) {
      cells.push({ x, y });
    }
  }
  if (building.status === "under_construction") {
    return [
      { x: building.x - 0.3, y: building.y + building.h + 0.1 },
      { x: building.x + building.w + 0.3, y: building.y + building.h + 0.1 },
      { x: building.x - 0.3, y: building.y + 1.5 },
      { x: building.x + building.w + 0.3, y: building.y + 1.5 },
      { x: building.x + 0.6, y: building.y + building.h + 0.4 },
      { x: building.x + building.w - 0.6, y: building.y + building.h + 0.4 },
      { x: building.x + building.w / 2, y: building.y + building.h + 0.6 },
    ];
  }
  return cells;
}

function walkPoint(path: Tile[], progress: number): { x: number; y: number; dx: number } {
  if (path.length === 1) {
    return { x: path[0]!.x + 0.5, y: path[0]!.y + 0.5, dx: 0 };
  }
  const f = Math.min(1, Math.max(0, progress)) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f));
  const a = path[i]!;
  const b = path[i + 1]!;
  const t = f - i;
  return { x: a.x + (b.x - a.x) * t + 0.5, y: a.y + (b.y - a.y) * t + 0.5, dx: b.x - a.x };
}

/**
 * Where each citizen is drawn at world second `worldS`. Walkers follow the
 * same road path the server used to price the trip; arrivals wait at the
 * destination door until the server applies the arrival.
 */
export function placeCitizens(
  citizens: readonly CitizenView[],
  buildings: ReadonlyMap<string, BuildingView>,
  worldS: number,
): Placement[] {
  const placements: Placement[] = [];
  const present = new Map<string, CitizenView[]>();

  for (const citizen of citizens) {
    if (citizen.activity === "unavailable") {
      continue;
    }
    if (citizen.activity === "walking" && citizen.originId && citizen.destinationId) {
      const path = pathBetween(citizen.originId, citizen.destinationId);
      const from = buildings.get(citizen.originId);
      const to = buildings.get(citizen.destinationId);
      const route: Tile[] = path ?? [from, to].filter((b): b is BuildingView => Boolean(b)).map((b) => ({ x: b.doorX, y: b.doorY }));
      if (route.length === 0) {
        continue;
      }
      const span = Math.max(1, (citizen.worldEndsS ?? citizen.worldStartedS) - citizen.worldStartedS);
      const progress = (worldS - citizen.worldStartedS) / span;
      const point = walkPoint(route, progress);
      placements.push({
        tokenId: citizen.tokenId,
        x: point.x,
        y: point.y,
        visible: true,
        insideId: null,
        moving: progress < 1,
        facing: point.dx < 0 ? -1 : 1,
      });
      continue;
    }
    if (!citizen.locationId) {
      continue;
    }
    const list = present.get(citizen.locationId) ?? [];
    list.push(citizen);
    present.set(citizen.locationId, list);
  }

  for (const [buildingId, list] of present) {
    const building = buildings.get(buildingId);
    if (!building) {
      continue;
    }
    list.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
    if (!showsOccupants(building)) {
      for (const citizen of list) {
        placements.push({
          tokenId: citizen.tokenId,
          x: building.doorX + 0.5,
          y: building.doorY + 0.5,
          visible: false,
          insideId: building.id,
          moving: false,
          facing: 1,
        });
      }
      continue;
    }
    const cells = interiorCells(building);
    const start = hash32(building.id) % cells.length;
    const stride = cells.length > 7 ? 7 : 1;
    list.forEach((citizen, index) => {
      const cell = cells[(start + index * stride) % cells.length]!;
      const lap = Math.floor((index * stride) / cells.length);
      const jitter = (hash32(`${citizen.tokenId}:${buildingId}`) % 5) / 10 - 0.2;
      const integral = Number.isInteger(cell.x);
      placements.push({
        tokenId: citizen.tokenId,
        x: cell.x + (integral ? 0.5 : 0) + jitter + lap * 0.35,
        y: cell.y + (integral ? 0.6 : 0),
        visible: true,
        insideId: null,
        moving: false,
        facing: hash32(citizen.tokenId) % 2 === 0 ? 1 : -1,
      });
    });
  }
  return placements;
}

export type Camera = { scale: number; x: number; y: number };
export type Viewport = { width: number; height: number };

export const MAX_SCALE = 6;

/** Default view: the founding 60×40 settlement, framed as genesis-v1 was. */
export function fitCamera(view: Viewport): Camera {
  const scale = Math.min(view.width / SETTLEMENT_PX_W, view.height / SETTLEMENT_PX_H);
  return {
    scale,
    x: (view.width - SETTLEMENT_PX_W * scale) / 2,
    y: (view.height - SETTLEMENT_PX_H * scale) / 2,
  };
}

/** Smallest zoom that still shows the whole expanded map. */
export function minScale(view: Viewport): number {
  return Math.min(view.width / WORLD_PX_W, view.height / WORLD_PX_H);
}

function clampAxis(offset: number, size: number, worldSize: number): number {
  if (worldSize <= size) {
    return (size - worldSize) / 2;
  }
  return Math.min(0, Math.max(size - worldSize, offset));
}

/** Keeps the map on screen. A map smaller than the viewport is centered. */
export function clampCamera(camera: Camera, view: Viewport): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(view), camera.scale));
  return {
    scale,
    x: clampAxis(camera.x, view.width, WORLD_PX_W * scale),
    y: clampAxis(camera.y, view.height, WORLD_PX_H * scale),
  };
}

/** Zooms by `factor` while keeping the screen point (px, py) over the same map point. */
export function zoomAt(camera: Camera, view: Viewport, factor: number, px: number, py: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(view), camera.scale * factor));
  const ratio = scale / camera.scale;
  return clampCamera({ scale, x: px - (px - camera.x) * ratio, y: py - (py - camera.y) * ratio }, view);
}

export function panBy(camera: Camera, view: Viewport, dx: number, dy: number): Camera {
  return clampCamera({ ...camera, x: camera.x + dx, y: camera.y + dy }, view);
}

/** Centers the camera on a tile position, zooming in to at least `scale`. */
export function focusOn(camera: Camera, view: Viewport, tileX: number, tileY: number, scale?: number): Camera {
  const next = Math.min(MAX_SCALE, Math.max(minScale(view), scale ?? camera.scale));
  return clampCamera(
    { scale: next, x: view.width / 2 - tileX * TILE * next, y: view.height / 2 - tileY * TILE * next },
    view,
  );
}

export function screenToTile(camera: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - camera.x) / camera.scale / TILE, y: (sy - camera.y) / camera.scale / TILE };
}

export type Hit = { type: "citizen"; tokenId: string } | { type: "building"; id: string } | null;

/** Citizens win over buildings. The nearest visible sprite within its body radius is picked. */
export function hitTest(
  tile: { x: number; y: number },
  placements: readonly Placement[],
  buildings: readonly BuildingView[],
  camera: Camera,
): Hit {
  const radius = Math.max(0.45, 9 / (camera.scale * TILE));
  let best: { tokenId: string; d: number } | null = null;
  for (const placement of placements) {
    if (!placement.visible) {
      continue;
    }
    const dx = tile.x - placement.x;
    const dy = tile.y - (placement.y - 0.35);
    const d = Math.hypot(dx, dy);
    if (d <= radius && (!best || d < best.d)) {
      best = { tokenId: placement.tokenId, d };
    }
  }
  if (best) {
    return { type: "citizen", tokenId: best.tokenId };
  }
  for (const building of buildings) {
    if (tile.x >= building.x && tile.x < building.x + building.w && tile.y >= building.y && tile.y < building.y + building.h) {
      return { type: "building", id: building.id };
    }
  }
  return null;
}
