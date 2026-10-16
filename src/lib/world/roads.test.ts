import { describe, expect, it } from "vitest";
import { BUILDINGS, pathAcross, pathBetween, type PathBuilding } from "@/lib/world/layout";
import { planConstruction, surveyedPlots } from "@/lib/world/placement";
import {
  ROAD_STUBS,
  ROAD_STUB_STONE,
  ROAD_STUB_WOOD,
  completeOverlayTiles,
  eligibleRoadStubs,
  overlayRoadAt,
  validateRoadStubPlacement,
} from "@/lib/world/roads";
import type { BuildingView } from "@/lib/world/types";

function views(): BuildingView[] {
  return BUILDINGS.map((building) => ({
    id: building.id,
    kind: building.kind,
    name: building.name,
    x: building.rect.x,
    y: building.rect.y,
    w: building.rect.w,
    h: building.rect.h,
    doorX: building.door.x,
    doorY: building.door.y,
    capacity: building.capacity,
    jobSlots: building.jobSlots,
    role: building.role,
    openAir: building.open,
    status: building.initialStatus,
    constructionProgress: building.initialStatus === "under_construction" ? 0 : null,
    batchShifts: building.batchShifts,
    productionProgress: 0,
    batchesCompleted: 0,
    stock: {},
    completedAt: null,
    updatedTick: 0,
  }));
}

function easternHouse(plotX: number): PathBuilding {
  return {
    id: `house-east-${plotX}`,
    kind: "house",
    rect: { x: plotX, y: 2, w: 3, h: 3 },
    door: { x: plotX + 1, y: 4 },
  };
}

describe("phase 5b catalog roads", () => {
  it("defines six spurs from the connected y=10 road to the reserved y=2 lots", () => {
    expect(ROAD_STUBS.map((stub) => stub.id)).toEqual([
      "east-y2-64",
      "east-y2-68",
      "east-y2-72",
      "east-y2-76",
      "east-y2-80",
      "east-y2-84",
    ]);
    expect(ROAD_STUBS[0]).toMatchObject({
      tiles: [
        { x: 65, y: 9 },
        { x: 65, y: 8 },
        { x: 65, y: 6 },
        { x: 65, y: 5 },
      ],
      servesPlotIds: ["plot-64-2"],
    });
    expect(ROAD_STUB_WOOD).toBe(3);
    expect(ROAD_STUB_STONE).toBe(2);
  });

  it("rejects unknown, duplicate, overlapping, and disconnected stubs", () => {
    const empty = { placedStubIds: new Set<string>(), overlayTiles: [] as Array<{ x: number; y: number }> };
    expect(validateRoadStubPlacement({ ...empty, stubId: "invented-path" }).ok).toBe(false);
    expect(validateRoadStubPlacement({ ...empty, stubId: "east-y2-64" }).ok).toBe(true);
    expect(
      validateRoadStubPlacement({
        stubId: "east-y2-64",
        placedStubIds: new Set(["east-y2-64"]),
        overlayTiles: [],
      }).ok,
    ).toBe(false);
    expect(
      validateRoadStubPlacement({
        stubId: "east-y2-68",
        placedStubIds: new Set(),
        overlayTiles: ROAD_STUBS[1]!.tiles,
      }).ok,
    ).toBe(false);
    expect(
      validateRoadStubPlacement({
        ...empty,
        stubId: "east-y2-64",
        buildings: [{ x: 65, y: 6, w: 1, h: 1 }],
      }).ok,
    ).toBe(false);
    expect(eligibleRoadStubs({ ...empty, stock: { wood: 2, stone: 2 } })).toEqual([]);
    expect(eligibleRoadStubs({ ...empty, stock: { wood: 3, stone: 2 } }).map((stub) => stub.id)).toContain("east-y2-64");
  });

  it("unlocks only the lot whose door actually touches the overlay", () => {
    const none = surveyedPlots();
    expect(none.filter((plot) => plot.rect.y === 2).every((plot) => !plot.served)).toBe(true);
    expect(none.filter((plot) => plot.served)).toHaveLength(20);

    const short = surveyedPlots([{ x: 65, y: 6 }]);
    expect(short.find((plot) => plot.id === "plot-64-2")?.served).toBe(false);
    expect(short.filter((plot) => plot.rect.y === 2).every((plot) => !plot.served)).toBe(true);

    const full = surveyedPlots(ROAD_STUBS[0]!.tiles);
    expect(full.find((plot) => plot.id === "plot-64-2")?.served).toBe(true);
    expect(full.filter((plot) => plot.rect.y === 2 && plot.id !== "plot-64-2").every((plot) => !plot.served)).toBe(true);
    expect(full.filter((plot) => plot.served)).toHaveLength(21);
  });

  it("lets citizens walk the overlay and then plan Phase 5a construction on the newly served lot", () => {
    const overlay = ROAD_STUBS[0]!.tiles;
    const lot = easternHouse(64);
    const graph = [...BUILDINGS, lot];
    expect(pathAcross(BUILDINGS[0]!, lot, graph)).toBeNull();
    const walked = pathAcross(BUILDINGS[0]!, lot, graph, overlay);
    expect(walked).not.toBeNull();
    expect(walked?.some((tile) => tile.x === 65 && tile.y === 6)).toBe(true);
    expect(walked?.some((tile) => tile.x === 65 && tile.y === 5)).toBe(true);

    const founding = pathBetween("house-01", "market");
    const foundingWithOverlay = pathAcross(BUILDINGS[0]!, BUILDINGS.find((b) => b.id === "market")!, BUILDINGS, overlay);
    expect(foundingWithOverlay).toEqual(founding);

    const occupied = new Set(surveyedPlots().filter((plot) => plot.served).map((plot) => plot.id));
    expect(planConstruction(views(), occupied, "house").ok).toBe(false);
    const planned = planConstruction(views(), occupied, "house", overlay);
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.plan.plotId).toBe("plot-64-2");
      expect(planned.plan.kind).toBe("house");
      expect(planned.plan.door).toEqual({ x: 65, y: 4 });
    }
    expect(planConstruction(views(), occupied, "farm", overlay).ok).toBe(true);
    expect(planConstruction(views(), occupied, "workshop", overlay).ok).toBe(true);
  });

  it("keeps overlay lookup on completed tiles only", () => {
    const roads = [
      {
        id: "east-y2-64",
        tiles: ROAD_STUBS[0]!.tiles,
        status: "complete" as const,
      },
    ];
    expect(overlayRoadAt(65.2, 5.4, roads)?.id).toBe("east-y2-64");
    expect(overlayRoadAt(64, 2, roads)).toBeUndefined();
    expect(completeOverlayTiles(roads)).toEqual(ROAD_STUBS[0]!.tiles);
  });
});
