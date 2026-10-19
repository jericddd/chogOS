import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  darkness,
  formatWorldTime,
  runnerHealth,
  worldSecondsAt,
} from "@/lib/world/clock";
import { BUILDINGS, TILE, pathBetween } from "@/lib/world/layout";
import { citizenHref, describeCitizenNow, eventSegments } from "@/lib/world/present";
import { toCitizen, toEvent, type CitizenRow, type EventRow } from "@/lib/world/rows";
import {
  DEFAULT_VIEW_PX_H,
  DEFAULT_VIEW_PX_W,
  DEFAULT_VIEW_TILE_W,
  MAX_SCALE,
  WORLD_PX_H,
  WORLD_PX_W,
  clampCamera,
  fitCamera,
  hitTest,
  minScale,
  placeCitizens,
  zoomAt,
} from "@/lib/world/scene";
import {
  eventFilterFromSearch,
  matchesFilter,
  mergeEvents,
  pickAiConstructionEvent,
  receiveLive,
  resolveEventFilter,
  revealPending,
} from "@/lib/world/sync";
import type { BuildingView, CitizenView, ClockView, WorldEventView } from "@/lib/world/types";

const T0 = Date.parse("2026-10-13T00:00:00Z");

function clock(patch: Partial<ClockView> = {}): ClockView {
  return {
    status: "running",
    speed: 60,
    anchorReal: new Date(T0).toISOString(),
    anchorWorldS: 6 * 3600,
    tickSeq: 10,
    lastTickAt: new Date(T0 + 50_000).toISOString(),
    lastTickWorldS: 6 * 3600 + 50 * 60,
    lastTickGapS: 5,
    lastTickFailed: 0,
    lastErrorAt: null,
    maxLagSeconds: 150,
    walkWorldSPerTile: 30,
    layoutVersion: "genesis-v1",
    layoutHash: "7e8db240",
    serverNow: new Date(T0 + 52_000).toISOString(),
    ...patch,
  };
}

const buildings: BuildingView[] = BUILDINGS.map((b) => ({
  id: b.id,
  kind: b.kind,
  name: b.name,
  x: b.rect.x,
  y: b.rect.y,
  w: b.rect.w,
  h: b.rect.h,
  doorX: b.door.x,
  doorY: b.door.y,
  capacity: b.capacity,
  jobSlots: b.jobSlots,
  role: b.role,
  openAir: b.open,
  status: b.initialStatus,
  constructionProgress: b.initialStatus === "under_construction" ? 0 : null,
  batchShifts: b.batchShifts,
  productionProgress: 0,
  batchesCompleted: 0,
  stock: (b.kind === "storehouse" ? { food: 80, wood: 60, stone: 40, tools: 0 } : {}) as Record<string, number>,
  completedAt: null,
  updatedTick: 0,
}));
const byId = new Map(buildings.map((b) => [b.id, b]));

function citizen(patch: Partial<CitizenView>): CitizenView {
  return {
    tokenId: "7",
    name: null,
    origin: "founding",
    role: "farmer",
    homeId: "house-01",
    workId: "north-farm",
    activity: "working",
    locationId: "north-farm",
    originId: null,
    destinationId: null,
    purpose: null,
    startedAt: new Date(T0).toISOString(),
    endsAt: new Date(T0 + 240_000).toISOString(),
    worldStartedS: 6 * 3600,
    worldEndsS: 10 * 3600,
    shiftsToday: 1,
    dayIndex: 1,
    decisionSource: "simulation",
    updatedTick: 1,
    ...patch,
  };
}

function confirmedRow(hash: string): EventRow {
  return {
    id: "transfer",
    seq: 4,
    kind: "nft.transferred",
    category: "onchain",
    source: "onchain",
    summary: "Chog #7 transferred.",
    occurred_at: "2026-10-19T00:00:00Z",
    world_s: null,
    tick_seq: null,
    building_id: null,
    chain_status: "confirmed",
    tx_hash: hash,
    chain_id: 143,
    canonical: true,
    payload: { tokenId: "7" },
  };
}

function event(seq: number, patch: Partial<WorldEventView> = {}): WorldEventView {
  return {
    id: `e${seq}`,
    seq,
    kind: "work.shift_started",
    category: "work",
    source: "simulation",
    summary: `Chog #7 began a shift at Workshop A.`,
    occurredAt: new Date(T0 + seq * 1000).toISOString(),
    worldS: 6 * 3600 + seq * 60,
    tickSeq: seq,
    tokenId: "7",
    relatedTokenId: null,
    buildingId: "workshop-a",
    buildingName: "Workshop A",
    chainStatus: "offchain",
    txHash: null,
    ...patch,
  };
}

describe("world clock", () => {
  it("projects world time from the shared anchor at the stored speed", () => {
    const c = clock();
    expect(worldSecondsAt(c, T0 + 60_000)).toBe(6 * 3600 + 3600);
    expect(formatWorldTime(worldSecondsAt(c, T0 + 60_000))).toBe("Day 1 · 07:00");
  });

  it("stops projecting where the server would pause, so a dead runner never shows unprocessed time", () => {
    const c = clock();
    const frozen = worldSecondsAt(c, T0 + 50_000 + 150_000);
    expect(worldSecondsAt(c, T0 + 50_000 + 3_600_000)).toBe(frozen);
    expect(worldSecondsAt(clock({ status: "paused" }), T0 + 999_999)).toBe(c.lastTickWorldS);
  });

  it("reports live, delayed, stalled, and paused runner health", () => {
    const c = clock();
    expect(runnerHealth(c, T0 + 55_000)).toBe("live");
    expect(runnerHealth(c, T0 + 50_000 + 60_000)).toBe("delayed");
    expect(runnerHealth(c, T0 + 50_000 + 151_000)).toBe("stalled");
    expect(runnerHealth(clock({ status: "paused" }), T0 + 55_000)).toBe("paused");
    expect(runnerHealth(clock({ lastTickGapS: 60 }), T0 + 50_000 + 120_000)).toBe("live");
  });

  it("darkens the map at night and not at noon", () => {
    expect(darkness(12 * 3600)).toBe(0);
    expect(darkness(2 * 3600)).toBe(1);
    expect(darkness(6 * 3600)).toBeGreaterThan(0);
    expect(darkness(6 * 3600)).toBeLessThan(1);
  });
});

describe("presentation", () => {
  it("links the citizen and building named in a summary without rewriting it", () => {
    const segments = eventSegments(event(1), () => null);
    expect(segments.map((s) => s.text).join("")).toBe("Chog #7 began a shift at Workshop A.");
    expect(segments.find((s) => s.text === "Chog #7")?.href).toBe(citizenHref("7"));
    expect(segments.find((s) => s.text === "Workshop A")?.href).toBe("/?building=workshop-a");
  });

  it("links both people in a meeting", () => {
    const segments = eventSegments(
      event(2, { summary: "Mossy met Chog #14 at Commons Square.", relatedTokenId: "14", buildingId: "commons-square", buildingName: "Commons Square" }),
      (id) => (id === "7" ? "Mossy" : null),
    );
    expect(segments.filter((s) => s.entity === "citizen").map((s) => s.href)).toEqual(["/?citizen=7", "/?citizen=14"]);
  });

  it("describes what a citizen is doing in plain words", () => {
    expect(describeCitizenNow(citizen({}), byId)).toBe("Working at North Farm");
    expect(
      describeCitizenNow(citizen({ activity: "walking", locationId: null, originId: "house-01", destinationId: "market", purpose: "shop" }), byId),
    ).toBe("Walking to Market to shop");
  });
});

describe("row mapping", () => {
  it("labels legacy Phase 1 rows as system membership events", () => {
    const row: EventRow = {
      id: "x",
      seq: "3",
      kind: "genesis_joined",
      category: null,
      source: null,
      summary: "Chog #7 joined.",
      occurred_at: "2026-10-12T00:00:00Z",
      world_s: null,
      tick_seq: null,
      building_id: null,
      chain_status: "offchain",
      tx_hash: null,
      payload: { tokenId: "7" },
    };
    const mapped = toEvent(row);
    expect(mapped).toMatchObject({ seq: 3, source: "system", category: "membership", tokenId: "7", worldS: null });
  });

  it("links a confirmed transfer and hides an orphaned one", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const confirmed = toEvent({
      id: "transfer",
      seq: 4,
      kind: "nft.transferred",
      category: "onchain",
      source: "onchain",
      summary: "Chog #7 transferred from 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222 in block 11.",
      occurred_at: "2026-10-19T00:00:00Z",
      world_s: null,
      tick_seq: null,
      building_id: null,
      chain_status: "confirmed",
      tx_hash: hash,
      chain_id: 143,
      canonical: true,
      payload: { tokenId: "7", from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222" },
    });
    expect(confirmed).toMatchObject({
      category: "onchain",
      source: "onchain",
      chainStatus: "confirmed",
      tokenId: "7",
      txHash: hash,
      txUrl: null,
    });
    expect(confirmed.transfer?.canonical).toBe(false);
    expect(confirmed.transfer?.links.from).toBeNull();
    expect(confirmed.transfer?.links.to).toBeNull();
    expect(confirmed.transfer?.links.transaction).toBeNull();
    expect(confirmed.transfer?.issues.join(" ")).toMatch(/contract|block hash|log index|block number/i);
    expect(confirmed.transfer?.txIndex).toBeNull();
    const contract = "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763";
    const detailed = toEvent({
      ...confirmedRow(hash),
      payload: {
        tokenId: "7",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        blockNumber: "11",
        blockHash: `0x${"cd".repeat(32)}`,
        logIndex: 4,
        contract,
      },
    });
    expect(detailed.transfer).toMatchObject({
      chainId: 143,
      blockNumber: "11",
      logIndex: "4",
      txIndex: null,
      canonical: true,
    });
    expect(detailed.transfer?.links.block).toBe("https://monadscan.com/block/11");
    expect(detailed.transfer?.links.token).toBe(`https://monadscan.com/nft/${contract}/7`);
    expect(detailed.transfer?.links.contract).toBe(`https://monadscan.com/address/${contract}`);
    const mismatched = toEvent({
      ...confirmedRow(hash),
      payload: { tokenId: "7", txHash: `0x${"ff".repeat(32)}` },
    });
    expect(mismatched.txUrl).toBeNull();
    expect(mismatched.txHash).toBeNull();
    expect(mismatched.transfer?.consistent).toBe(false);
    const malformed = toEvent({ ...confirmedRow("0xnot-a-hash"), canonical: true });
    expect(malformed.txUrl).toBeNull();
    expect(malformed.transfer?.links.transaction).toBeNull();
    const orphaned = toEvent({ ...confirmedRow(hash), canonical: false });
    expect(orphaned.chainStatus).toBe("offchain");
    expect(orphaned.txHash).toBeNull();
    expect(orphaned.txUrl).toBeNull();
  });

  it("treats founding_treasury citizens as founding and exposes no internal ids", () => {
    const row = {
      role: null,
      home_id: null,
      work_id: null,
      activity: "idle",
      location_id: "commons-square",
      origin_id: null,
      destination_id: null,
      purpose: null,
      started_at: "2026-10-13T00:00:00Z",
      ends_at: null,
      world_started_s: 1,
      world_ends_s: null,
      day_index: 1,
      shifts_today: 0,
      decision_source: "simulation",
      updated_tick: 1,
      citizens: { token_id: 7, metadata_name: "  ", origin: "founding_treasury" },
    } satisfies CitizenRow;
    const mapped = toCitizen(row);
    expect(mapped).toMatchObject({ tokenId: "7", origin: "founding", name: null });
    expect(JSON.stringify(mapped)).not.toMatch(/citizen_id|owner|wallet/);
  });
});

describe("live merge", () => {
  it("keeps one row per event, newest first", () => {
    const merged = mergeEvents([event(3), event(1)], [event(2), event(3, { summary: "updated" })]);
    expect(merged.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(merged[0]!.summary).toBe("updated");
    expect(mergeEvents([event(1), event(2), event(3)], [], 2).map((e) => e.seq)).toEqual([3, 2]);
  });

  it("holds live rows behind the New activity indicator while the reader is away from the top", () => {
    const start = { shown: [event(2), event(1)], pending: [] };
    const away = receiveLive(start, [event(4), event(3), event(2)], {}, false);
    expect(away.shown.map((e) => e.seq)).toEqual([2, 1]);
    expect(away.pending.map((e) => e.seq)).toEqual([4, 3]);
    const again = receiveLive(away, [event(4), event(3)], {}, false);
    expect(again).toBe(away);
    expect(revealPending(again).shown.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(receiveLive(start, [event(3)], {}, true).shown.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("only admits live rows that match the active filter", () => {
    const social = event(5, { category: "social", source: "simulation" });
    expect(matchesFilter(social, { category: "social" })).toBe(true);
    expect(matchesFilter(social, { category: "work" })).toBe(false);
    expect(matchesFilter(social, { source: "ai" })).toBe(false);
    expect(matchesFilter(event(6, { relatedTokenId: "9" }), { tokenId: "9" })).toBe(true);
    expect(receiveLive({ shown: [], pending: [] }, [social], { category: "work" }, true).shown).toHaveLength(0);
  });

  it("treats category AI as an alias for source=ai without inventing rows", () => {
    const road = event(8, { kind: "road.placed", category: "construction", source: "ai" });
    const social = event(5, { category: "social", source: "simulation" });
    expect(resolveEventFilter({ category: "ai" })).toEqual({ source: "ai" });
    expect(resolveEventFilter({ category: "ai", source: "ai", tokenId: "7" })).toEqual({ source: "ai", tokenId: "7" });
    expect(resolveEventFilter({ category: "construction", source: "ai" })).toEqual({
      category: "construction",
      source: "ai",
    });
    expect(matchesFilter(road, { category: "ai" })).toBe(true);
    expect(matchesFilter(road, { source: "ai" })).toBe(true);
    expect(matchesFilter(road, { category: "construction" })).toBe(true);
    expect(matchesFilter(social, { category: "ai" })).toBe(false);
    expect(matchesFilter(social, { category: "social" })).toBe(true);
    expect(receiveLive({ shown: [], pending: [] }, [road, social], { category: "ai" }, true).shown.map((e) => e.id)).toEqual([
      "e8",
    ]);
  });

  it("picks only a real AI construction event for Verify discovery", () => {
    const road = event(8, { kind: "road.placed", category: "construction", source: "ai" });
    const system = event(9, { kind: "world.tick", category: "world", source: "system" });
    expect(pickAiConstructionEvent([system, road])).toMatchObject({ id: "e8", source: "ai", category: "construction" });
    expect(pickAiConstructionEvent([system])).toBeNull();
    expect(pickAiConstructionEvent([])).toBeNull();
  });

  it("reads History query params including source=ai", () => {
    expect(eventFilterFromSearch({ source: "ai" })).toEqual({ source: "ai" });
    expect(eventFilterFromSearch({ category: "ai" })).toEqual({ category: "ai" });
    expect(eventFilterFromSearch({ source: "simulation", category: "construction" })).toEqual({
      source: "simulation",
      category: "construction",
    });
    expect(eventFilterFromSearch({ citizen: "7", building: "market" })).toEqual({
      tokenId: "7",
      buildingId: "market",
    });
    expect(eventFilterFromSearch({ source: "admin", category: "secret", citizen: "nope" })).toEqual({});
  });
});

describe("scene placement", () => {
  it("moves walkers along the same road path the server priced", () => {
    const path = pathBetween("house-01", "market")!;
    const walker = citizen({
      activity: "walking",
      locationId: null,
      originId: "house-01",
      destinationId: "market",
      purpose: "shop",
      worldStartedS: 1000,
      worldEndsS: 1000 + (path.length - 1) * 30,
    });
    const at = (s: number) => placeCitizens([walker], byId, s)[0]!;
    expect(at(1000)).toMatchObject({ x: path[0]!.x + 0.5, y: path[0]!.y + 0.5, moving: true });
    const end = at(1000 + (path.length - 1) * 30 + 500);
    expect(end).toMatchObject({ x: path.at(-1)!.x + 0.5, y: path.at(-1)!.y + 0.5, moving: false });
    const mid = at(1000 + 15 * 30);
    expect(mid.x).toBeCloseTo(path[15]!.x + 0.5);
    expect(mid.y).toBeCloseTo(path[15]!.y + 0.5);
  });

  it("hides citizens inside enclosed buildings and spreads open-air workers without overlap", () => {
    const sleepers = ["1", "2"].map((id) => citizen({ tokenId: id, activity: "sleeping", locationId: "house-01" }));
    const farmers = ["3", "4", "5", "6"].map((id) => citizen({ tokenId: id }));
    const placed = placeCitizens([...sleepers, ...farmers, citizen({ tokenId: "8", activity: "unavailable", locationId: null })], byId, 7000);
    expect(placed.filter((p) => p.insideId === "house-01" && !p.visible)).toHaveLength(2);
    const visible = placed.filter((p) => p.visible);
    expect(visible).toHaveLength(4);
    expect(new Set(visible.map((p) => `${Math.floor(p.x)}:${Math.floor(p.y)}`)).size).toBe(4);
    expect(placed.find((p) => p.tokenId === "8")).toBeUndefined();
    const farm = byId.get("north-farm")!;
    for (const p of visible) {
      expect(p.x).toBeGreaterThanOrEqual(farm.x);
      expect(p.x).toBeLessThanOrEqual(farm.x + farm.w);
    }
  });

  it("keeps the camera on the map, zooms around the pointer, and resets to the inhabited town", () => {
    const view = { width: 900, height: 600 };
    const fit = fitCamera(view);
    expect(fit.scale).toBeCloseTo(Math.min(900 / DEFAULT_VIEW_PX_W, 600 / DEFAULT_VIEW_PX_H));
    expect(DEFAULT_VIEW_TILE_W).toBeGreaterThan(60);
    expect(DEFAULT_VIEW_TILE_W).toBeLessThan(120);
    expect(minScale(view)).toBeCloseTo(Math.min(900 / WORLD_PX_W, 600 / WORLD_PX_H));
    expect(minScale(view)).toBeLessThan(fit.scale);
    const onScreen = (tileX: number, tileY: number) => {
      const sx = fit.x + tileX * TILE * fit.scale;
      const sy = fit.y + tileY * TILE * fit.scale;
      return sx >= 0 && sx <= view.width && sy >= 0 && sy <= view.height;
    };
    expect(onScreen(8, 8)).toBe(true);
    expect(onScreen(85, 6)).toBe(true);
    const zoomed = zoomAt(fit, view, 3, 450, 300);
    const before = { x: (450 - fit.x) / fit.scale, y: (300 - fit.y) / fit.scale };
    const after = { x: (450 - zoomed.x) / zoomed.scale, y: (300 - zoomed.y) / zoomed.scale };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(zoomed, view, 1000, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt(fit, view, 0.01, 0, 0).scale).toBeCloseTo(minScale(view));
    const far = clampCamera({ scale: 2, x: 5000, y: -9000 }, view);
    expect(far.x).toBe(0);
    expect(far.y).toBe(600 - WORLD_PX_H * 2);
    expect(WORLD_PX_W).toBe(120 * TILE);
    expect(WORLD_PX_H).toBe(80 * TILE);
  });

  it("paints the static layer at the full 120×80 map, not the founding 60×40", () => {
    const src = readFileSync("src/components/world/world-canvas.tsx", "utf8");
    expect(src).toMatch(/off\.width = WORLD_PX_W/);
    expect(src).toMatch(/off\.height = WORLD_PX_H/);
    expect(src).not.toMatch(/off\.width = 60 \* TILE/);
  });

  it("hit-tests citizens before the building they stand in", () => {
    const farmer = citizen({});
    const placed = placeCitizens([farmer], byId, 7000);
    const cam = { scale: 2, x: 0, y: 0 };
    const p = placed[0]!;
    expect(hitTest({ x: p.x, y: p.y - 0.35 }, placed, buildings, cam)).toEqual({ type: "citizen", tokenId: "7" });
    const farm = byId.get("north-farm")!;
    expect(hitTest({ x: farm.x + 0.2, y: farm.y + 0.2 }, placed, buildings, cam)).toEqual({ type: "building", id: "north-farm" });
    expect(hitTest({ x: 30, y: 39.5 }, placed, buildings, cam)).toBeNull();
    const roads = [
      {
        id: "east-y2-64",
        stubId: "east-y2-64",
        name: "East spur to plot 64,2",
        tiles: [
          { x: 65, y: 6 },
          { x: 65, y: 5 },
        ],
        status: "complete" as const,
        servedPlotIds: ["plot-64-2"],
        completedAt: null,
        source: "system" as const,
      },
    ];
    expect(hitTest({ x: 65.2, y: 5.2 }, placed, buildings, cam, roads)).toEqual({ type: "road", id: "east-y2-64" });
    expect(TILE).toBe(16);
  });
});
