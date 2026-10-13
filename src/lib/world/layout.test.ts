import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  GRID_H,
  GRID_W,
  decorations,
  initializationLayout,
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
    expect(first.buildings.map((b) => b.id)).toEqual(second.buildings.map((b) => b.id));
    expect(new Set(first.buildings.map((b) => b.id)).size).toBe(first.buildings.length);
    expect(first.routes.length).toBe(BUILDINGS.length * (BUILDINGS.length - 1));
    const there = first.routes.find((r) => r.from === "house-01" && r.to === "workshop-a")!;
    const back = first.routes.find((r) => r.from === "workshop-a" && r.to === "house-01")!;
    expect(there.steps).toBe(back.steps);
    expect(decorations()).toEqual(decorations());
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
