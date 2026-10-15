import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  EXPANSION_ROADS,
  GENESIS_V1_GRID_H,
  GENESIS_V1_GRID_W,
  GENESIS_V1_VERSION,
  GRID_H,
  GRID_W,
  PLOTS,
  decorations,
  genesisV1Layout,
  initializationLayout,
  isPlot,
  isRoad,
  pathBetween,
  walkableGrid,
} from "@/lib/world/layout";

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("world layout", () => {
  it("keeps every building on the map without overlapping another building or a road", () => {
    for (const building of BUILDINGS) {
      const { x, y, w, h } = building.rect;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(GRID_W);
      expect(y + h).toBeLessThanOrEqual(GRID_H);
      for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x; xx < x + w; xx += 1) {
          expect(isRoad(xx, yy), `${building.id} covers road ${xx},${yy}`).toBe(false);
        }
      }
      for (const other of BUILDINGS) {
        if (other.id !== building.id) {
          expect(overlaps(building.rect, other.rect), `${building.id} overlaps ${other.id}`).toBe(false);
        }
      }
    }
  });

  it("puts each door on its building edge, next to a road", () => {
    for (const building of BUILDINGS) {
      const { door, rect } = building;
      const onEdge =
        door.x >= rect.x &&
        door.x < rect.x + rect.w &&
        door.y >= rect.y &&
        door.y < rect.y + rect.h &&
        (door.x === rect.x || door.x === rect.x + rect.w - 1 || door.y === rect.y || door.y === rect.y + rect.h - 1);
      expect(onEdge, building.id).toBe(true);
      const touchesRoad = [
        [door.x + 1, door.y],
        [door.x - 1, door.y],
        [door.x, door.y + 1],
        [door.x, door.y - 1],
      ].some(([x, y]) => isRoad(x!, y!));
      expect(touchesRoad, building.id).toBe(true);
    }
  });

  it("connects every pair of buildings by walkable tiles only", () => {
    const grid = walkableGrid();
    for (const from of BUILDINGS) {
      for (const to of BUILDINGS) {
        if (from.id === to.id) {
          continue;
        }
        const path = pathBetween(from.id, to.id);
        expect(path, `${from.id} -> ${to.id}`).not.toBeNull();
        for (const [index, tile] of path!.entries()) {
          expect(grid[tile.y * GRID_W + tile.x]).toBe(1);
          if (index > 0) {
            const prev = path![index - 1]!;
            expect(Math.abs(prev.x - tile.x) + Math.abs(prev.y - tile.y)).toBe(1);
          }
        }
      }
    }
  });

  it("produces the same initialization payload every time", () => {
    const first = initializationLayout();
    const second = initializationLayout();
    expect(first.hash).toBe(second.hash);
    expect(first.version).toBe("genesis-v1.1");
    expect(first.gridW).toBe(GRID_W);
    expect(first.gridH).toBe(GRID_H);
    expect(first.buildings.map((b) => b.id)).toEqual(second.buildings.map((b) => b.id));
    expect(new Set(first.buildings.map((b) => b.id)).size).toBe(first.buildings.length);
    expect(first.routes.length).toBe(BUILDINGS.length * (BUILDINGS.length - 1));
    const there = first.routes.find((r) => r.from === "house-01" && r.to === "workshop-a")!;
    const back = first.routes.find((r) => r.from === "workshop-a" && r.to === "house-01")!;
    expect(there.steps).toBe(back.steps);
    expect(decorations()).toEqual(decorations());
  });

  it("is twice the genesis-v1 width and height, with the town still on its original tiles", () => {
    expect(GRID_W).toBe(GENESIS_V1_GRID_W * 2);
    expect(GRID_H).toBe(GENESIS_V1_GRID_H * 2);
    expect(GRID_W * GRID_H).toBe(GENESIS_V1_GRID_W * GENESIS_V1_GRID_H * 4);
    const v1 = genesisV1Layout();
    const next = initializationLayout();
    expect(v1.version).toBe(GENESIS_V1_VERSION);
    expect(v1.hash).toBe("7e8db240");
    expect(next.fromVersions).toEqual([GENESIS_V1_VERSION]);
    for (const building of next.buildings) {
      const original = v1.buildings.find((item) => item.id === building.id)!;
      expect([building.x, building.y, building.w, building.h, building.door_x, building.door_y]).toEqual([
        original.x,
        original.y,
        original.w,
        original.h,
        original.door_x,
        original.door_y,
      ]);
      expect(building.x + building.w).toBeLessThanOrEqual(GENESIS_V1_GRID_W);
      expect(building.y + building.h).toBeLessThanOrEqual(GENESIS_V1_GRID_H);
    }
    const v1Steps = new Map(v1.routes.map((route) => [`${route.from}>${route.to}`, route.steps]));
    for (const route of next.routes) {
      expect(route.steps, `${route.from} -> ${route.to}`).toBe(v1Steps.get(`${route.from}>${route.to}`));
    }
  });

  it("attaches expansion roads to the founding network without covering lots or the old town", () => {
    const grid = walkableGrid();
    expect(grid[19 * GRID_W + 59]).toBe(1);
    expect(grid[38 * GRID_W + 29]).toBe(1);
    expect(grid[55 * GRID_W + 90]).toBe(1);
    expect(pathBetween("house-01", "riverside-farm")).not.toBeNull();
    for (const road of EXPANSION_ROADS) {
      expect(road.x + road.w).toBeLessThanOrEqual(GRID_W);
      expect(road.y + road.h).toBeLessThanOrEqual(GRID_H);
    }
    for (const plot of PLOTS) {
      expect(plot.y >= GENESIS_V1_GRID_H || plot.x >= GENESIS_V1_GRID_W).toBe(true);
      for (let y = plot.y; y < plot.y + plot.h; y += 1) {
        for (let x = plot.x; x < plot.x + plot.w; x += 1) {
          expect(isPlot(x, y)).toBe(true);
          expect(isRoad(x, y), `lot ${x},${y} on a road`).toBe(false);
          expect(BUILDINGS.some((building) => x >= building.rect.x && x < building.rect.x + building.rect.w && y >= building.rect.y && y < building.rect.y + building.rect.h)).toBe(
            false,
          );
        }
      }
    }
    const extraEast = PLOTS.filter((plot) => plot.y === 11 && plot.x >= 80);
    const extraSouth = PLOTS.filter((plot) => plot.y === 57 && plot.x >= 53);
    expect(extraEast.map((plot) => plot.x)).toEqual([80, 84, 92, 96, 100]);
    expect(extraSouth.map((plot) => plot.x)).toEqual([53, 57, 61, 65, 69, 73]);
  });

  it("has enough homes and shelter for the founding population", () => {
    const beds = BUILDINGS.filter((b) => b.kind === "house" && b.initialStatus === "active").reduce(
      (sum, b) => sum + (b.capacity ?? 0),
      0,
    );
    const shelter = BUILDINGS.find((b) => b.kind === "hall")!.capacity!;
    expect(beds + shelter).toBeGreaterThanOrEqual(59);
  });
});
