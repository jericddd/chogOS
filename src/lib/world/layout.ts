/**
 * The persistent chogOS map.
 *
 * genesis-v1 was 60×40. genesis-v1.1 keeps every founding building on the
 * same tiles and opens land to the east and south (120×80). Building
 * rectangles in the database stay authoritative for state. Roads, terrain,
 * reserved plots, and decor are derived here from fixed numbers.
 */

export const GENESIS_V1_VERSION = "genesis-v1";
export const WORLD_LAYOUT_VERSION = "genesis-v1.1";
export const GENESIS_V1_GRID_W = 60;
export const GENESIS_V1_GRID_H = 40;
export const GRID_W = 120;
export const GRID_H = 80;
export const TILE = 16;

export type BuildingKind =
  | "house"
  | "hall"
  | "commons"
  | "farm"
  | "forest"
  | "quarry"
  | "workshop"
  | "storehouse"
  | "market";

export type WorkRole = "farmer" | "woodcutter" | "stonecutter" | "crafter" | "merchant" | "builder";

export type Rect = { x: number; y: number; w: number; h: number };
export type Tile = { x: number; y: number };

export type BuildingDef = {
  id: string;
  kind: BuildingKind;
  name: string;
  rect: Rect;
  door: Tile;
  /** Residents for a house, shelter places for the hall. */
  capacity: number | null;
  /** Workers who can hold a job here. */
  jobSlots: number | null;
  role: WorkRole | null;
  /** Shifts that complete one simulated production batch. */
  batchShifts: number | null;
  initialStatus: "active" | "under_construction";
  /** Open-air places whose interior is visible and walkable. */
  open: boolean;
};

function house(index: number, x: number, y: number, doorTop: boolean, planned = false): BuildingDef {
  const id = `house-${String(index).padStart(2, "0")}`;
  return {
    id,
    kind: "house",
    name: `House ${String(index).padStart(2, "0")}`,
    rect: { x, y, w: 3, h: 3 },
    door: { x: x + 1, y: doorTop ? y : y + 2 },
    capacity: 4,
    jobSlots: planned ? 7 : null,
    role: planned ? "builder" : null,
    batchShifts: null,
    initialStatus: planned ? "under_construction" : "active",
    open: false,
  };
}

const houseColumns = [2, 6, 10, 14, 18, 22];

export const BUILDINGS: readonly BuildingDef[] = [
  ...houseColumns.map((x, i) => house(i + 1, x, 4, false)),
  ...houseColumns.map((x, i) => house(i + 7, x, 8, true)),
  ...[2, 6, 10].map((x, i) => house(i + 13, x, 15, true, true)),
  {
    id: "commons-hall",
    kind: "hall",
    name: "Commons Hall",
    rect: { x: 14, y: 15, w: 3, h: 3 },
    door: { x: 15, y: 15 },
    capacity: 12,
    jobSlots: null,
    role: null,
    batchShifts: null,
    initialStatus: "active",
    open: false,
  },
  {
    id: "commons-square",
    kind: "commons",
    name: "Commons Square",
    rect: { x: 18, y: 15, w: 10, h: 4 },
    door: { x: 22, y: 15 },
    capacity: null,
    jobSlots: null,
    role: null,
    batchShifts: null,
    initialStatus: "active",
    open: true,
  },
  {
    id: "workshop-a",
    kind: "workshop",
    name: "Workshop A",
    rect: { x: 32, y: 6, w: 5, h: 4 },
    door: { x: 34, y: 9 },
    capacity: null,
    jobSlots: 5,
    role: "crafter",
    batchShifts: 3,
    initialStatus: "active",
    open: false,
  },
  {
    id: "workshop-b",
    kind: "workshop",
    name: "Workshop B",
    rect: { x: 38, y: 6, w: 5, h: 4 },
    door: { x: 40, y: 9 },
    capacity: null,
    jobSlots: 5,
    role: "crafter",
    batchShifts: 3,
    initialStatus: "active",
    open: false,
  },
  {
    id: "storehouse",
    kind: "storehouse",
    name: "Storehouse",
    rect: { x: 44, y: 6, w: 5, h: 4 },
    door: { x: 46, y: 9 },
    capacity: null,
    jobSlots: null,
    role: null,
    batchShifts: null,
    initialStatus: "active",
    open: false,
  },
  {
    id: "mossy-woods",
    kind: "forest",
    name: "Mossy Woods",
    rect: { x: 50, y: 1, w: 9, h: 9 },
    door: { x: 54, y: 9 },
    capacity: null,
    jobSlots: 7,
    role: "woodcutter",
    batchShifts: 3,
    initialStatus: "active",
    open: true,
  },
  {
    id: "market",
    kind: "market",
    name: "Market",
    rect: { x: 32, y: 11, w: 8, h: 5 },
    door: { x: 35, y: 11 },
    capacity: null,
    jobSlots: 5,
    role: "merchant",
    batchShifts: null,
    initialStatus: "active",
    open: true,
  },
  {
    id: "violet-quarry",
    kind: "quarry",
    name: "Violet Quarry",
    rect: { x: 48, y: 11, w: 9, h: 6 },
    door: { x: 51, y: 11 },
    capacity: null,
    jobSlots: 6,
    role: "stonecutter",
    batchShifts: 3,
    initialStatus: "active",
    open: true,
  },
  {
    id: "north-farm",
    kind: "farm",
    name: "North Farm",
    rect: { x: 3, y: 21, w: 11, h: 8 },
    door: { x: 8, y: 21 },
    capacity: null,
    jobSlots: 6,
    role: "farmer",
    batchShifts: 3,
    initialStatus: "active",
    open: true,
  },
  {
    id: "riverside-farm",
    kind: "farm",
    name: "Riverside Farm",
    rect: { x: 16, y: 21, w: 11, h: 8 },
    door: { x: 21, y: 21 },
    capacity: null,
    jobSlots: 6,
    role: "farmer",
    batchShifts: 3,
    initialStatus: "active",
    open: true,
  },
];

/** Road rectangles from genesis-v1. Do not change these; expansion roads attach at the old rim. */
export const GENESIS_V1_ROADS: readonly Rect[] = [
  { x: 1, y: 19, w: 58, h: 2 },
  { x: 29, y: 1, w: 2, h: 38 },
  { x: 1, y: 7, w: 28, h: 1 },
  { x: 1, y: 14, w: 28, h: 1 },
  { x: 31, y: 10, w: 28, h: 1 },
  { x: 1, y: 31, w: 58, h: 1 },
  { x: 1, y: 7, w: 1, h: 25 },
];

/**
 * New roads live on or past the old 60×40 rim so they cannot shorten walks
 * between founding buildings. They join the existing network at x = 59 and y = 38.
 */
export const EXPANSION_ROADS: readonly Rect[] = [
  { x: 59, y: 19, w: 58, h: 2 },
  { x: 59, y: 10, w: 58, h: 1 },
  { x: 59, y: 31, w: 58, h: 1 },
  { x: 29, y: 38, w: 2, h: 38 },
  { x: 90, y: 10, w: 2, h: 62 },
  { x: 110, y: 10, w: 2, h: 48 },
  { x: 29, y: 55, w: 83, h: 2 },
  { x: 64, y: 7, w: 48, h: 1 },
  { x: 1, y: 50, w: 28, h: 1 },
];

export const ROADS: readonly Rect[] = [...GENESIS_V1_ROADS, ...EXPANSION_ROADS];

export const POND: Rect = { x: 40, y: 23, w: 7, h: 5 };
export const SOUTH_POND: Rect = { x: 72, y: 63, w: 10, h: 6 };
export const PONDS: readonly Rect[] = [POND, SOUTH_POND];
export const RIVER_Y = 35;

export type RegionKind = "settlement" | "wilds" | "reserve" | "resource";

export type RegionDef = {
  id: string;
  name: string;
  kind: RegionKind;
  rect: Rect;
  note: string;
};

/** Named land for later districts. These are not buildings and have no jobs. */
export const REGIONS: readonly RegionDef[] = [
  {
    id: "founding-town",
    name: "Founding Town",
    kind: "settlement",
    rect: { x: 0, y: 0, w: GENESIS_V1_GRID_W, h: GENESIS_V1_GRID_H },
    note: "The original genesis-v1 settlement. Building tiles were not moved.",
  },
  {
    id: "east-commons",
    name: "East Commons",
    kind: "reserve",
    rect: { x: 60, y: 0, w: 60, h: 40 },
    note: "Open land and surveyed lots for future homes and workshops.",
  },
  {
    id: "south-meadows",
    name: "South Meadows",
    kind: "wilds",
    rect: { x: 0, y: 40, w: 60, h: 40 },
    note: "Meadow and river bottom reserved for future farms.",
  },
  {
    id: "southeast-woods",
    name: "Southeast Woods",
    kind: "resource",
    rect: { x: 60, y: 40, w: 60, h: 40 },
    note: "Woods and stone ground for later resource camps.",
  },
];

function lotRow(y: number, xs: number[]): Rect[] {
  return xs.map((x) => ({ x, y, w: 3, h: 3 }));
}

/** Packed-earth lots. Drawn as undeveloped land, never as constructed buildings. */
export const PLOTS: readonly Rect[] = [
  ...lotRow(2, [64, 68, 72, 76, 80, 84]),
  ...lotRow(11, [64, 68, 72, 76]),
  ...lotRow(57, [33, 37, 41, 45, 49]),
];

export function buildingById(id: string): BuildingDef | undefined {
  return BUILDINGS.find((building) => building.id === id);
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function inBounds(x: number, y: number, width = GRID_W, height = GRID_H): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function coversRoad(x: number, y: number, roads: readonly Rect[]): boolean {
  return roads.some((road) => inRect(road, x, y));
}

export function isRoad(x: number, y: number): boolean {
  return coversRoad(x, y, ROADS);
}

export function isPlot(x: number, y: number): boolean {
  return PLOTS.some((plot) => inRect(plot, x, y));
}

export function isWaterTile(x: number, y: number): boolean {
  if (y === RIVER_Y || y === RIVER_Y + 1) {
    return true;
  }
  return PONDS.some((pond) => {
    if (!inRect(pond, x, y)) {
      return false;
    }
    const corner = (x === pond.x || x === pond.x + pond.w - 1) && (y === pond.y || y === pond.y + pond.h - 1);
    return !corner;
  });
}

export function regionAt(x: number, y: number): RegionDef | undefined {
  return REGIONS.find((region) => inRect(region.rect, x, y));
}

export function buildingAt(x: number, y: number): BuildingDef | undefined {
  return BUILDINGS.find((building) => inRect(building.rect, x, y));
}

function tileKey(x: number, y: number, width: number): number {
  return y * width + x;
}

function walkableOn(width: number, height: number, roads: readonly Rect[], buildings: readonly BuildingDef[]): Uint8Array {
  const grid = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (coversRoad(x, y, roads)) {
        grid[tileKey(x, y, width)] = 1;
      }
    }
  }
  for (const building of buildings) {
    grid[tileKey(building.door.x, building.door.y, width)] = 1;
    if (building.kind === "commons") {
      const { x, y, w, h } = building.rect;
      for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
          grid[tileKey(xx, yy, width)] = 1;
        }
      }
    }
  }
  return grid;
}

let walkable: Uint8Array | null = null;

/** Roads, doors, and the open interior of Commons Square. */
export function walkableGrid(): Uint8Array {
  if (!walkable) {
    walkable = walkableOn(GRID_W, GRID_H, ROADS, BUILDINGS);
  }
  return walkable;
}

function pathOn(
  from: BuildingDef,
  to: BuildingDef,
  width: number,
  height: number,
  grid: Uint8Array,
): Tile[] | null {
  const start = tileKey(from.door.x, from.door.y, width);
  const goal = tileKey(to.door.x, to.door.y, width);
  const previous = new Int32Array(width * height).fill(-1);
  previous[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (current === goal) {
      break;
    }
    const cx = current % width;
    const cy = Math.floor(current / width);
    const neighbors: Array<[number, number]> = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const next = tileKey(nx, ny, width);
      if (grid[next] !== 1 || previous[next] !== -1) {
        continue;
      }
      previous[next] = current;
      queue.push(next);
    }
  }
  if (previous[goal] === -1) {
    return null;
  }
  const tiles: Tile[] = [];
  for (let cursor = goal; ; cursor = previous[cursor]!) {
    tiles.push({ x: cursor % width, y: Math.floor(cursor / width) });
    if (cursor === start) {
      break;
    }
  }
  tiles.reverse();
  return tiles;
}

const pathCache = new Map<string, Tile[]>();

/** Breadth-first path between two doors over walkable tiles. Neighbor order is fixed. */
export function pathBetween(fromId: string, toId: string): Tile[] | null {
  const cacheKey = `${fromId}>${toId}`;
  const hit = pathCache.get(cacheKey);
  if (hit) {
    return hit;
  }
  const from = buildingById(fromId);
  const to = buildingById(toId);
  if (!from || !to) {
    return null;
  }
  const tiles = pathOn(from, to, GRID_W, GRID_H, walkableGrid());
  if (!tiles) {
    return null;
  }
  pathCache.set(cacheKey, tiles);
  return tiles;
}

export type RouteRow = { from: string; to: string; steps: number };

function routesOn(width: number, height: number, roads: readonly Rect[], buildings: readonly BuildingDef[]): RouteRow[] {
  const grid = walkableOn(width, height, roads, buildings);
  const rows: RouteRow[] = [];
  for (const from of buildings) {
    for (const to of buildings) {
      if (from.id === to.id) {
        continue;
      }
      const path = pathOn(from, to, width, height, grid);
      if (!path) {
        throw new Error(`No road connects ${from.id} to ${to.id}.`);
      }
      rows.push({ from: from.id, to: to.id, steps: Math.max(1, path.length - 1) });
    }
  }
  return rows;
}

export function routeTable(): RouteRow[] {
  return routesOn(GRID_W, GRID_H, ROADS, BUILDINGS);
}

/** Small integer hash. Same input, same output, on every machine. */
export function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Decor = { kind: "tree" | "pine" | "bush" | "flower" | "rock" | "lamp"; x: number; y: number; variant: number };

let decorCache: Decor[] | null = null;

function nearStructure(x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (isRoad(x + dx, y + dy) || buildingAt(x + dx, y + dy)) {
        return true;
      }
    }
  }
  return false;
}

export function decorations(): Decor[] {
  if (decorCache) {
    return decorCache;
  }
  const items: Decor[] = [];
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (isRoad(x, y) || buildingAt(x, y) || isPlot(x, y) || isWaterTile(x, y)) {
        continue;
      }
      const inTown = x < GENESIS_V1_GRID_W && y < GENESIS_V1_GRID_H;
      const roll = hash32(`${inTown ? GENESIS_V1_VERSION : WORLD_LAYOUT_VERSION}:${x}:${y}`) % 1000;
      const variant = hash32(`v:${x}:${y}`) % 4;
      if (nearStructure(x, y)) {
        if (roll < 40) {
          items.push({ kind: "flower", x, y, variant });
        } else if (roll < 70) {
          items.push({ kind: "bush", x, y, variant });
        }
        continue;
      }
      const eastWoods = x >= 96 && y < 40;
      const southWoods = x >= 60 && y >= 40;
      const edge = x < 1 || y < 2 || x > GRID_W - 2 || y > GRID_H - 3;
      const treeChance = eastWoods || southWoods ? 280 : edge ? 420 : inTown ? 110 : 160;
      const bushChance = treeChance + (edge ? 50 : 40);
      if (roll < treeChance) {
        items.push({ kind: y > 30 || x > 44 || southWoods ? "pine" : "tree", x, y, variant });
      } else if (roll < bushChance) {
        items.push({ kind: "bush", x, y, variant });
      } else if (roll < bushChance + 40) {
        items.push({ kind: "flower", x, y, variant });
      } else if (roll < bushChance + (eastWoods ? 80 : 50)) {
        items.push({ kind: "rock", x, y, variant });
      }
    }
  }
  for (const road of ROADS) {
    if (road.h === 1 || road.w === 1) {
      continue;
    }
    if (road.w > road.h) {
      for (let x = road.x + 3; x < road.x + road.w; x += 7) {
        items.push({ kind: "lamp", x, y: road.y - 1, variant: 0 });
      }
    } else {
      for (let y = road.y + 4; y < road.y + road.h; y += 7) {
        items.push({ kind: "lamp", x: road.x - 1, y, variant: 0 });
      }
    }
  }
  decorCache = items.filter(
    (item) => item.kind !== "lamp" || (!buildingAt(item.x, item.y) && !isRoad(item.x, item.y)),
  );
  return decorCache;
}

export type LayoutBuilding = {
  id: string;
  kind: BuildingKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door_x: number;
  door_y: number;
  capacity: number | null;
  job_slots: number | null;
  role: WorkRole | null;
  batch_shifts: number | null;
  status: "active" | "under_construction";
  open: boolean;
};

export type LayoutRegion = {
  id: string;
  name: string;
  kind: RegionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
};

export type LayoutPayload = {
  version: string;
  hash: string;
  fromVersions: string[];
  gridW: number;
  gridH: number;
  buildings: LayoutBuilding[];
  routes: RouteRow[];
  regions: LayoutRegion[];
};

function serializedBuildings(): LayoutBuilding[] {
  return BUILDINGS.map((building) => ({
    id: building.id,
    kind: building.kind,
    name: building.name,
    x: building.rect.x,
    y: building.rect.y,
    w: building.rect.w,
    h: building.rect.h,
    door_x: building.door.x,
    door_y: building.door.y,
    capacity: building.capacity,
    job_slots: building.jobSlots,
    role: building.role,
    batch_shifts: building.batchShifts,
    status: building.initialStatus,
    open: building.open,
  }));
}

function serializedRegions(): LayoutRegion[] {
  return REGIONS.map((region) => ({
    id: region.id,
    name: region.name,
    kind: region.kind,
    x: region.rect.x,
    y: region.rect.y,
    w: region.rect.w,
    h: region.rect.h,
    note: region.note,
  }));
}

function layoutHash(buildings: LayoutBuilding[], roads: readonly Rect[], routes: RouteRow[]): string {
  return hash32(JSON.stringify({ buildings, roads, routes })).toString(16).padStart(8, "0");
}

/** Frozen genesis-v1 payload. Used to prove an expansion keeps the founding town. */
export function genesisV1Layout(): LayoutPayload {
  const buildings = serializedBuildings();
  const routes = routesOn(GENESIS_V1_GRID_W, GENESIS_V1_GRID_H, GENESIS_V1_ROADS, BUILDINGS);
  return {
    version: GENESIS_V1_VERSION,
    hash: layoutHash(buildings, GENESIS_V1_ROADS, routes),
    fromVersions: [],
    gridW: GENESIS_V1_GRID_W,
    gridH: GENESIS_V1_GRID_H,
    buildings,
    routes,
    regions: serializedRegions().filter((region) => region.id === "founding-town"),
  };
}

/** Payload for world_initialize and world_expand_layout. */
export function initializationLayout(): LayoutPayload {
  const buildings = serializedBuildings();
  const routes = routesOn(GRID_W, GRID_H, ROADS, BUILDINGS);
  return {
    version: WORLD_LAYOUT_VERSION,
    hash: layoutHash(buildings, ROADS, routes),
    fromVersions: [GENESIS_V1_VERSION],
    gridW: GRID_W,
    gridH: GRID_H,
    buildings,
    routes,
    regions: serializedRegions(),
  };
}
