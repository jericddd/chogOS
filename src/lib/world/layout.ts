/**
 * The persistent chogOS map, version genesis-v1.
 *
 * Building rectangles, doors, capacities, and job slots are inserted into
 * world_buildings once by world_initialize. The database copy is
 * authoritative for state. Roads, terrain, and decor are derived here from
 * fixed numbers, so every viewer draws the same map without a random seed.
 */

export const WORLD_LAYOUT_VERSION = "genesis-v1";
export const GRID_W = 60;
export const GRID_H = 40;
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

/** Road rectangles. Every door touches one of these, and they form one network. */
export const ROADS: readonly Rect[] = [
  { x: 1, y: 19, w: 58, h: 2 },
  { x: 29, y: 1, w: 2, h: 38 },
  { x: 1, y: 7, w: 28, h: 1 },
  { x: 1, y: 14, w: 28, h: 1 },
  { x: 31, y: 10, w: 28, h: 1 },
  { x: 1, y: 31, w: 58, h: 1 },
  { x: 1, y: 7, w: 1, h: 25 },
];

export const POND: Rect = { x: 40, y: 23, w: 7, h: 5 };
export const RIVER_Y = 35;

export function buildingById(id: string): BuildingDef | undefined {
  return BUILDINGS.find((building) => building.id === id);
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function isRoad(x: number, y: number): boolean {
  return ROADS.some((road) => inRect(road, x, y));
}

export function buildingAt(x: number, y: number): BuildingDef | undefined {
  return BUILDINGS.find((building) => inRect(building.rect, x, y));
}

function key(x: number, y: number): number {
  return y * GRID_W + x;
}

let walkable: Uint8Array | null = null;

/** Roads, doors, and the open interior of Commons Square. */
export function walkableGrid(): Uint8Array {
  if (walkable) {
    return walkable;
  }
  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (isRoad(x, y)) {
        grid[key(x, y)] = 1;
      }
    }
  }
  for (const building of BUILDINGS) {
    grid[key(building.door.x, building.door.y)] = 1;
    if (building.kind === "commons") {
      const { x, y, w, h } = building.rect;
      for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
          grid[key(xx, yy)] = 1;
        }
      }
    }
  }
  walkable = grid;
  return grid;
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
  const grid = walkableGrid();
  const start = key(from.door.x, from.door.y);
  const goal = key(to.door.x, to.door.y);
  const previous = new Int32Array(GRID_W * GRID_H).fill(-1);
  previous[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (current === goal) {
      break;
    }
    const cx = current % GRID_W;
    const cy = Math.floor(current / GRID_W);
    const neighbors: Array<[number, number]> = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) {
        continue;
      }
      const next = key(nx, ny);
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
    tiles.push({ x: cursor % GRID_W, y: Math.floor(cursor / GRID_W) });
    if (cursor === start) {
      break;
    }
  }
  tiles.reverse();
  pathCache.set(cacheKey, tiles);
  return tiles;
}

export type RouteRow = { from: string; to: string; steps: number };

export function routeTable(): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const from of BUILDINGS) {
    for (const to of BUILDINGS) {
      if (from.id === to.id) {
        continue;
      }
      const path = pathBetween(from.id, to.id);
      if (!path) {
        throw new Error(`No road connects ${from.id} to ${to.id}.`);
      }
      rows.push({ from: from.id, to: to.id, steps: Math.max(1, path.length - 1) });
    }
  }
  return rows;
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
      if (isRoad(x, y) || buildingAt(x, y) || inRect(POND, x, y) || y === RIVER_Y || y === RIVER_Y + 1) {
        continue;
      }
      const roll = hash32(`${WORLD_LAYOUT_VERSION}:${x}:${y}`) % 1000;
      const variant = hash32(`v:${x}:${y}`) % 4;
      if (nearStructure(x, y)) {
        if (roll < 40) {
          items.push({ kind: "flower", x, y, variant });
        } else if (roll < 70) {
          items.push({ kind: "bush", x, y, variant });
        }
        continue;
      }
      const edge = x < 1 || y < 2 || x > GRID_W - 2 || y > RIVER_Y + 1;
      if (roll < (edge ? 420 : 110)) {
        items.push({ kind: y > 30 || x > 44 ? "pine" : "tree", x, y, variant });
      } else if (roll < (edge ? 470 : 150)) {
        items.push({ kind: "bush", x, y, variant });
      } else if (roll < 190) {
        items.push({ kind: "flower", x, y, variant });
      } else if (roll < 200) {
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

/** Payload for world_initialize. Contains only building facts and road distances. */
export function initializationLayout(): {
  version: string;
  hash: string;
  buildings: Array<{
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
  }>;
  routes: RouteRow[];
} {
  const buildings = BUILDINGS.map((building) => ({
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
  const routes = routeTable();
  const hash = hash32(JSON.stringify({ buildings, roads: ROADS, routes })).toString(16).padStart(8, "0");
  return { version: WORLD_LAYOUT_VERSION, hash, buildings, routes };
}
