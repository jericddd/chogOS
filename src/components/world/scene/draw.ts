import { darkness } from "@/lib/world/clock";
import {
  GRID_H,
  GRID_W,
  POND,
  RIVER_Y,
  TILE,
  decorations,
  hash32,
  isRoad,
  type WorkRole,
} from "@/lib/world/layout";
import { WORLD_PX_H, WORLD_PX_W, type Placement } from "@/lib/world/scene";
import type { BuildingView, CitizenView, WorldActivity } from "@/lib/world/types";

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length]!;
}

const GRASS = ["#1f4a35", "#21503a", "#1d4632", "#22533b"];
const TUFT = ["#2c6647", "#2a6144", "#327250"];
const ROAD = "#6b5741";
const ROAD_EDGE = "#56462f";
const PEBBLE = ["#806a51", "#5f4d38", "#8a7459"];
const WATER = "#1d4e78";
const WATER_LIGHT = "#2a6aa0";
const SAND = "#9e8a5c";
const ROOFS = [
  ["#6d3fd6", "#55309f"],
  ["#2f9474", "#237158"],
  ["#a8532e", "#843f22"],
  ["#3a68ad", "#2c5085"],
] as const;

function inPond(x: number, y: number): boolean {
  return x >= POND.x && x < POND.x + POND.w && y >= POND.y && y < POND.y + POND.h;
}

function isWater(x: number, y: number): boolean {
  if (y === RIVER_Y || y === RIVER_Y + 1) {
    return true;
  }
  if (!inPond(x, y)) {
    return false;
  }
  const corner =
    (x === POND.x || x === POND.x + POND.w - 1) && (y === POND.y || y === POND.y + POND.h - 1);
  return !corner;
}

function drawGround(ctx: Ctx) {
  for (let ty = 0; ty < GRID_H; ty += 1) {
    for (let tx = 0; tx < GRID_W; tx += 1) {
      const px = tx * TILE;
      const py = ty * TILE;
      const seed = hash32(`g:${tx}:${ty}`);
      rect(ctx, px, py, TILE, TILE, pick(GRASS, seed));
      for (let i = 0; i < 3; i += 1) {
        const s = hash32(`t:${tx}:${ty}:${i}`);
        rect(ctx, px + (s % 14), py + ((s >> 4) % 14), 1, 2, pick(TUFT, s >> 8));
      }
    }
  }
}

function drawWater(ctx: Ctx) {
  for (let ty = 0; ty < GRID_H; ty += 1) {
    for (let tx = 0; tx < GRID_W; tx += 1) {
      if (!isWater(tx, ty)) {
        continue;
      }
      const px = tx * TILE;
      const py = ty * TILE;
      rect(ctx, px, py, TILE, TILE, WATER);
      const s = hash32(`w:${tx}:${ty}`);
      rect(ctx, px + (s % 10), py + ((s >> 3) % 12), 4, 1, WATER_LIGHT);
      rect(ctx, px + ((s >> 6) % 12), py + ((s >> 9) % 12), 3, 1, WATER_LIGHT);
      if (!isWater(tx, ty - 1)) {
        rect(ctx, px, py, TILE, 2, SAND);
      }
      if (!isWater(tx, ty + 1)) {
        rect(ctx, px, py + TILE - 2, TILE, 2, SAND);
      }
      if (!isWater(tx - 1, ty) && tx > 0) {
        rect(ctx, px, py, 2, TILE, SAND);
      }
      if (!isWater(tx + 1, ty) && tx < GRID_W - 1) {
        rect(ctx, px + TILE - 2, py, 2, TILE, SAND);
      }
    }
  }
}

function drawRoads(ctx: Ctx) {
  for (let ty = 0; ty < GRID_H; ty += 1) {
    for (let tx = 0; tx < GRID_W; tx += 1) {
      if (!isRoad(tx, ty)) {
        continue;
      }
      const px = tx * TILE;
      const py = ty * TILE;
      if (isWater(tx, ty)) {
        rect(ctx, px, py, TILE, TILE, "#7a5a36");
        for (let i = 0; i < TILE; i += 4) {
          rect(ctx, px, py + i, TILE, 1, "#5c4228");
        }
        if (!isRoad(tx - 1, ty)) {
          rect(ctx, px, py, 2, TILE, "#3d2c1b");
        }
        if (!isRoad(tx + 1, ty)) {
          rect(ctx, px + TILE - 2, py, 2, TILE, "#3d2c1b");
        }
        continue;
      }
      rect(ctx, px, py, TILE, TILE, ROAD);
      const s = hash32(`r:${tx}:${ty}`);
      for (let i = 0; i < 4; i += 1) {
        const p = hash32(`p:${s}:${i}`);
        rect(ctx, px + (p % 15), py + ((p >> 4) % 15), 1, 1, pick(PEBBLE, p >> 8));
      }
      if (!isRoad(tx, ty - 1)) {
        rect(ctx, px, py, TILE, 1, ROAD_EDGE);
      }
      if (!isRoad(tx, ty + 1)) {
        rect(ctx, px, py + TILE - 1, TILE, 1, ROAD_EDGE);
      }
      if (!isRoad(tx - 1, ty)) {
        rect(ctx, px, py, 1, TILE, ROAD_EDGE);
      }
      if (!isRoad(tx + 1, ty)) {
        rect(ctx, px + TILE - 1, py, 1, TILE, ROAD_EDGE);
      }
    }
  }
}

function drawTree(ctx: Ctx, cx: number, by: number, variant: number) {
  const crowns = ["#2f7a4c", "#2a6e45", "#358655", "#2b7349"];
  rect(ctx, cx - 1, by - 5, 3, 5, "#5a3d24");
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(cx - 5, by - 1, 11, 2);
  const crown = crowns[variant % crowns.length]!;
  rect(ctx, cx - 5, by - 13, 11, 8, crown);
  rect(ctx, cx - 4, by - 15, 9, 2, crown);
  rect(ctx, cx - 6, by - 11, 13, 4, crown);
  rect(ctx, cx - 3, by - 14, 3, 2, "#4aa36b");
  rect(ctx, cx - 5, by - 7, 11, 1, "#235c3a");
}

function drawPine(ctx: Ctx, cx: number, by: number, variant: number) {
  const tones = ["#1f5c3d", "#22653f", "#1c5538"];
  const tone = tones[variant % tones.length]!;
  rect(ctx, cx, by - 3, 2, 3, "#4c3420");
  for (let i = 0; i < 6; i += 1) {
    const half = 1 + i;
    rect(ctx, cx + 1 - half, by - 14 + i * 2, half * 2, 2, tone);
  }
  rect(ctx, cx, by - 15, 2, 2, tone);
  rect(ctx, cx - 1, by - 12, 1, 1, "#3c8a5c");
}

function drawDecor(ctx: Ctx) {
  for (const item of decorations()) {
    const px = item.x * TILE;
    const py = item.y * TILE;
    switch (item.kind) {
      case "tree":
        drawTree(ctx, px + 8, py + 15, item.variant);
        break;
      case "pine":
        drawPine(ctx, px + 7, py + 15, item.variant);
        break;
      case "bush":
        rect(ctx, px + 4, py + 8, 8, 5, "#2f7048");
        rect(ctx, px + 5, py + 7, 6, 1, "#3b8558");
        rect(ctx, px + 6, py + 9, 2, 1, "#4da56c");
        break;
      case "flower": {
        const colors = ["#f0a3c8", "#f5d76e", "#c4b5fd", "#f8f4e3"];
        for (let i = 0; i < 3; i += 1) {
          const s = hash32(`f:${item.x}:${item.y}:${i}`);
          rect(ctx, px + 2 + (s % 11), py + 3 + ((s >> 4) % 10), 2, 2, pick(colors, item.variant + i));
        }
        break;
      }
      case "rock":
        rect(ctx, px + 4, py + 8, 8, 5, "#6e6c78");
        rect(ctx, px + 5, py + 7, 5, 1, "#8b8996");
        rect(ctx, px + 4, py + 12, 8, 1, "#4d4b55");
        break;
      case "lamp":
        rect(ctx, px + 7, py + 4, 2, 11, "#2b2f36");
        rect(ctx, px + 5, py + 1, 6, 4, "#3b414b");
        rect(ctx, px + 6, py + 2, 4, 2, "#f7d98b");
        break;
    }
  }
}

function drawHouseBody(
  ctx: Ctx,
  b: BuildingView,
  roof: readonly [string, string],
  wall = "#d8c6a1",
) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  const doorTop = b.doorY === b.y;
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(x + 3, y + 4, w - 2, h - 2);
  const wallH = 15;
  const wallY = doorTop ? y + 1 : y + h - wallH - 1;
  const roofY = doorTop ? y + wallH : y + 1;
  const roofH = h - wallH - 2;
  rect(ctx, x + 2, wallY, w - 4, wallH, wall);
  rect(ctx, x + 2, doorTop ? wallY + wallH - 2 : wallY, w - 4, 2, "#b39d78");
  rect(ctx, x + 1, roofY, w - 2, roofH, roof[0]);
  for (let i = 3; i < roofH; i += 4) {
    rect(ctx, x + 1, roofY + i, w - 2, 1, roof[1]);
  }
  rect(ctx, x + 1, doorTop ? roofY : roofY + roofH - 2, w - 2, 2, roof[1]);
  rect(ctx, x + w / 2 - 1, roofY, 2, roofH, roof[1]);
  const doorX = b.doorX * TILE + 5;
  rect(ctx, doorX, doorTop ? wallY : wallY + 5, 6, 10, "#5b3a22");
  rect(ctx, doorX + 4, doorTop ? wallY + 5 : wallY + 10, 1, 1, "#e8c46a");
  rect(ctx, x + 6, wallY + 4, 5, 5, "#33465f");
  rect(ctx, x + w - 11, wallY + 4, 5, 5, "#33465f");
}

function drawConstruction(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x + 1, y + 1, w - 2, h - 2, "#5e4b34");
  rect(ctx, x + 3, y + 3, w - 6, h - 6, "#76603f");
  for (let i = 0; i < w - 6; i += 6) {
    rect(ctx, x + 3 + i, y + 3, 4, 2, "#8f8a80");
    rect(ctx, x + 3 + i, y + h - 5, 4, 2, "#8f8a80");
  }
  rect(ctx, x + 2, y + 2, 2, h - 4, "#a07a46");
  rect(ctx, x + w - 4, y + 2, 2, h - 4, "#a07a46");
  rect(ctx, x + 2, y + 2, w - 4, 1, "#a07a46");
  rect(ctx, x + 2, y + h / 2, w - 4, 1, "#a07a46");
  rect(ctx, x + w / 2 - 6, y + h / 2 + 4, 12, 3, "#b48a52");
  rect(ctx, x + w / 2 - 5, y + h / 2 + 7, 10, 3, "#9b7543");
}

function drawCommons(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x, y, w, h, "#8d8676");
  for (let ty = 0; ty < h; ty += 8) {
    for (let tx = (ty / 8) % 2 === 0 ? 0 : 4; tx < w; tx += 8) {
      rect(ctx, x + tx, y + ty, 7, 7, "#9a9383");
    }
  }
  rect(ctx, x, y, w, 1, "#6f695c");
  rect(ctx, x, y + h - 1, w, 1, "#6f695c");
  const cx = x + w / 2;
  const cy = y + h / 2 + 2;
  rect(ctx, cx - 10, cy - 8, 20, 16, "#6b6e78");
  rect(ctx, cx - 8, cy - 6, 16, 12, "#2a6aa0");
  rect(ctx, cx - 2, cy - 3, 4, 6, "#c7d2dd");
  rect(ctx, cx - 1, cy - 5, 2, 2, "#9fd8ff");
  for (const bx of [x + 10, x + w - 26]) {
    rect(ctx, bx, y + 8, 16, 3, "#7a5634");
    rect(ctx, bx + 1, y + 11, 2, 2, "#4d3520");
    rect(ctx, bx + 13, y + 11, 2, 2, "#4d3520");
  }
}

function drawFarm(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x, y, w, h, "#5a3f27");
  const crop = b.id === "north-farm" ? ["#7cc552", "#5fa83d"] : ["#d8b94e", "#bf9d36"];
  for (let row = 6; row < h - 4; row += 6) {
    rect(ctx, x + 4, y + row, w - 8, 2, "#4a3320");
    for (let col = 6; col < w - 6; col += 4) {
      const s = hash32(`${b.id}:${row}:${col}`);
      rect(ctx, x + col, y + row - 3, 2, 3, pick(crop, s));
    }
  }
  for (let i = 0; i < w; i += 4) {
    rect(ctx, x + i, y, 2, 2, "#8a6a45");
    rect(ctx, x + i, y + h - 2, 2, 2, "#8a6a45");
  }
  for (let i = 0; i < h; i += 4) {
    rect(ctx, x, y + i, 2, 2, "#8a6a45");
    rect(ctx, x + w - 2, y + i, 2, 2, "#8a6a45");
  }
  rect(ctx, b.doorX * TILE + 2, y, 12, 2, "#5a3f27");
  rect(ctx, x + w - 22, y + h - 30, 2, 16, "#6d4b2b");
  rect(ctx, x + w - 26, y + h - 26, 10, 2, "#6d4b2b");
  rect(ctx, x + w - 23, y + h - 34, 4, 4, "#e3c27a");
}

function drawForest(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x, y, w, h, "#173d2b");
  for (let ty = 0; ty < b.h; ty += 1) {
    for (let tx = 0; tx < b.w; tx += 1) {
      const gx = b.x + tx;
      const gy = b.y + ty;
      const clearing = Math.abs(gx - b.doorX) <= 1 && gy >= b.doorY - 2;
      if (clearing) {
        rect(ctx, gx * TILE, gy * TILE, TILE, TILE, "#3f5c37");
        continue;
      }
      const s = hash32(`fo:${gx}:${gy}`);
      if (s % 3 === 0) {
        drawPine(ctx, gx * TILE + 7, gy * TILE + 15, s >> 3);
      } else {
        drawTree(ctx, gx * TILE + 8, gy * TILE + 15, s >> 3);
      }
    }
  }
  const lx = (b.doorX - 1) * TILE + 2;
  const ly = (b.doorY - 1) * TILE + 6;
  rect(ctx, lx, ly, 14, 3, "#8a5a32");
  rect(ctx, lx + 2, ly + 3, 14, 3, "#7a4d2a");
  rect(ctx, lx, ly, 2, 3, "#c79a64");
  rect(ctx, (b.doorX + 1) * TILE + 4, ly + 2, 6, 4, "#6e4a2c");
  rect(ctx, (b.doorX + 1) * TILE + 5, ly + 2, 4, 1, "#c79a64");
}

function drawQuarry(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x, y, w, h, "#5d5966");
  rect(ctx, x + 10, y + 14, w - 20, h - 24, "#47434f");
  rect(ctx, x + 16, y + 20, w - 32, h - 36, "#38353f");
  for (let i = 0; i < 18; i += 1) {
    const s = hash32(`q:${b.id}:${i}`);
    const rx = x + 4 + (s % (w - 14));
    const ry = y + 4 + ((s >> 8) % (h - 12));
    if (Math.abs(rx - b.doorX * TILE) < 14 && ry < y + 14) {
      continue;
    }
    if (i % 4 === 0) {
      rect(ctx, rx, ry, 4, 7, "#a78bfa");
      rect(ctx, rx + 1, ry - 2, 2, 2, "#c4b5fd");
      rect(ctx, rx + 3, ry + 2, 1, 4, "#7c5fd6");
    } else {
      rect(ctx, rx, ry + 2, 9, 6, "#7d7987");
      rect(ctx, rx + 1, ry + 1, 6, 1, "#9894a3");
      rect(ctx, rx, ry + 8, 9, 1, "#3f3c46");
    }
  }
  rect(ctx, b.doorX * TILE + 2, y, 12, 12, "#6b6773");
}

function drawWorkshop(ctx: Ctx, b: BuildingView) {
  drawHouseBody(ctx, b, ["#3f4a5c", "#2f3847"], "#b9a888");
  const x = b.x * TILE;
  const y = b.y * TILE;
  rect(ctx, x + b.w * TILE - 16, y - 4, 6, 12, "#5b4b44");
  rect(ctx, x + b.w * TILE - 17, y - 5, 8, 2, "#433630");
  rect(ctx, x + 10, y + 10, 10, 8, "#d9a441");
  rect(ctx, x + 13, y + 12, 4, 4, "#3f4a5c");
}

function drawStorehouse(ctx: Ctx, b: BuildingView) {
  drawHouseBody(ctx, b, ["#8b3a2b", "#6c2c20"], "#c9b48c");
  const x = b.x * TILE;
  const y = b.y * TILE;
  rect(ctx, x + 6, y + 8, 10, 8, "#a07a46");
  rect(ctx, x + 6, y + 11, 10, 1, "#7a5a32");
  rect(ctx, x + 18, y + 8, 10, 8, "#a07a46");
  rect(ctx, x + 18, y + 11, 10, 1, "#7a5a32");
}

function drawMarket(ctx: Ctx, b: BuildingView) {
  const x = b.x * TILE;
  const y = b.y * TILE;
  const w = b.w * TILE;
  const h = b.h * TILE;
  rect(ctx, x, y, w, h, "#857a66");
  for (let ty = 0; ty < h; ty += 6) {
    for (let tx = (ty / 6) % 2 === 0 ? 0 : 3; tx < w; tx += 6) {
      rect(ctx, x + tx, y + ty, 5, 5, "#918670");
    }
  }
  const stripes = [
    ["#3dffb0", "#e8f7f0"],
    ["#a78bfa", "#e8f7f0"],
    ["#f0a35e", "#f8eeda"],
    ["#5aa9e6", "#e8f7f0"],
  ];
  const stalls = [
    [x + 6, y + 22],
    [x + 40, y + 22],
    [x + 74, y + 22],
    [x + 100, y + 50],
    [x + 6, y + 54],
  ];
  stalls.forEach(([sx, sy], i) => {
    if (sx === undefined || sy === undefined || sx + 22 > x + w) {
      return;
    }
    const [a, c] = stripes[i % stripes.length]!;
    rect(ctx, sx, sy + 8, 22, 8, "#7a5634");
    rect(ctx, sx + 1, sy + 9, 20, 2, "#9b7347");
    for (let k = 0; k < 22; k += 4) {
      rect(ctx, sx + k, sy, 2, 7, a!);
      rect(ctx, sx + k + 2, sy, 2, 7, c!);
    }
    rect(ctx, sx, sy + 7, 22, 1, "#3d2c1b");
    rect(ctx, sx + 4, sy + 10, 3, 2, "#e04f4f");
    rect(ctx, sx + 9, sy + 10, 3, 2, "#f5d76e");
    rect(ctx, sx + 14, sy + 10, 3, 2, "#7cc552");
  });
}

/** Terrain, roads, decor, and building shells. Redrawn only when a building's status changes. */
export function drawStaticLayer(ctx: Ctx, buildings: readonly BuildingView[]) {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, WORLD_PX_W, WORLD_PX_H);
  drawGround(ctx);
  drawWater(ctx);
  drawRoads(ctx);
  for (const b of buildings) {
    if (b.kind === "farm") drawFarm(ctx, b);
    if (b.kind === "commons") drawCommons(ctx, b);
    if (b.kind === "market") drawMarket(ctx, b);
    if (b.kind === "quarry") drawQuarry(ctx, b);
  }
  drawDecor(ctx);
  for (const b of buildings) {
    switch (b.kind) {
      case "house":
        if (b.status === "under_construction") {
          drawConstruction(ctx, b);
        } else {
          drawHouseBody(ctx, b, ROOFS[hash32(b.id) % ROOFS.length]!);
        }
        break;
      case "hall":
        drawHouseBody(ctx, b, ["#1f7f86", "#175f64"], "#e2d4b4");
        rect(ctx, b.x * TILE + 21, b.y * TILE + 2, 6, 9, "#3dffb0");
        break;
      case "forest":
        drawForest(ctx, b);
        break;
      case "workshop":
        drawWorkshop(ctx, b);
        break;
      case "storehouse":
        drawStorehouse(ctx, b);
        break;
    }
  }
}

export function staticLayerKey(buildings: readonly BuildingView[]): string {
  return buildings.map((b) => `${b.id}:${b.status}`).join("|");
}

// Citizens ------------------------------------------------------------------

const BODY = ["#8b5cf6", "#7c4dff", "#9d6bff", "#9466e0", "#8572f0"];

const CHOG = [
  "..o....o..",
  ".opo..opo.",
  ".oppppppo.",
  "oppppppppo",
  "opwkppwkpo",
  "oppppppppo",
  "opplllpppo",
  ".opllllpo.",
  "..oppppo..",
];

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * amount);
  const g = clamp(((n >> 8) & 255) * amount);
  const b = clamp((n & 255) * amount);
  return `rgb(${r},${g},${b})`;
}

function drawHat(ctx: Ctx, role: WorkRole | null, x: number, y: number) {
  switch (role) {
    case "farmer":
      rect(ctx, x - 1, y + 2, 12, 1, "#d9b65a");
      rect(ctx, x + 2, y, 6, 2, "#e8c76a");
      rect(ctx, x + 2, y + 1, 6, 1, "#b8452f");
      break;
    case "woodcutter":
      rect(ctx, x + 2, y, 6, 3, "#c0392b");
      rect(ctx, x + 4, y - 1, 2, 1, "#f2f2f2");
      break;
    case "stonecutter":
      rect(ctx, x + 1, y, 8, 3, "#8e8b98");
      rect(ctx, x + 1, y + 2, 8, 1, "#5d5a66");
      break;
    case "crafter":
      rect(ctx, x + 1, y + 2, 8, 1, "#3a68ad");
      rect(ctx, x + 2, y + 1, 2, 2, "#9fd8ff");
      rect(ctx, x + 6, y + 1, 2, 2, "#9fd8ff");
      break;
    case "merchant":
      rect(ctx, x + 2, y, 6, 2, "#2f9474");
      rect(ctx, x + 7, y + 1, 3, 1, "#237158");
      break;
    case "builder":
      rect(ctx, x + 1, y, 8, 3, "#f0a020");
      rect(ctx, x, y + 2, 10, 1, "#c97f12");
      break;
  }
}

const ICONS: Partial<Record<WorldActivity, { rows: string[]; color: string }>> = {
  sleeping: { rows: ["xxx", "..x", ".x.", "x..", "xxx"], color: "#9fd8ff" },
  working: { rows: ["xxx", "xxx", ".x.", ".x.", ".x."], color: "#f5d76e" },
  gathering: { rows: [".xx", "xxx", ".x.", ".x.", "x.."], color: "#c79a64" },
  building: { rows: ["xx.", "xxx", "...", ".xx", "xxx"], color: "#f0a020" },
  shopping: { rows: [".x.", "x.x", "xxx", "xxx", "xxx"], color: "#3dffb0" },
  socializing: { rows: ["x.x", "xxx", "xxx", ".x.", "..."], color: "#f0a3c8" },
  resting: { rows: ["...", ".x.", "xxx", "x.x", "x.x"], color: "#e8f7f0" },
  idle: { rows: ["...", "...", "x.x", "...", "..."], color: "#93a89f" },
};

function drawIcon(ctx: Ctx, activity: WorldActivity, cx: number, top: number, t: number) {
  const icon = ICONS[activity];
  if (!icon) {
    return;
  }
  const lift = activity === "sleeping" ? Math.round(Math.sin(t / 600) * 1.5) : 0;
  const x = Math.round(cx - 3);
  const y = Math.round(top - 9 + lift);
  ctx.fillStyle = "rgba(7,11,16,0.75)";
  ctx.fillRect(x - 1, y - 1, 7, 7);
  icon.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx += 1) {
      if (row[rx] === "x") {
        rect(ctx, x + rx + 1, y + ry, 1, 1, icon.color);
      }
    }
  });
}

export function drawCitizen(
  ctx: Ctx,
  citizen: CitizenView,
  placement: Placement,
  t: number,
  emphasis: "none" | "hover" | "selected",
) {
  const seed = hash32(citizen.tokenId);
  const body = BODY[seed % BODY.length]!;
  const light = shade(body, 1.35);
  const outline = shade(body, 0.35);
  const fx = placement.x * TILE;
  const fy = placement.y * TILE;
  const step = placement.moving ? Math.floor(t / 140 + (seed % 7)) % 2 : 0;
  const bob = placement.moving ? step : citizen.activity === "sleeping" ? 0 : Math.round(Math.sin(t / 500 + seed) * 0.5);
  const x = Math.round(fx - 5);
  const y = Math.round(fy - 10 - bob);

  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(Math.round(fx - 4), Math.round(fy - 1), 8, 2);

  if (emphasis !== "none") {
    const pulse = emphasis === "selected" ? 0.65 + Math.sin(t / 250) * 0.3 : 0.6;
    ctx.strokeStyle = emphasis === "selected" ? `rgba(61,255,176,${pulse})` : `rgba(232,247,240,${pulse})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(fx, fy, 7, 3, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  const flip = placement.facing === -1;
  CHOG.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx += 1) {
      const ch = row[flip ? row.length - 1 - rx : rx];
      if (!ch || ch === ".") {
        continue;
      }
      const color =
        ch === "o" ? outline : ch === "p" ? body : ch === "l" ? light : ch === "w" ? "#ffffff" : "#120a24";
      if (citizen.activity === "sleeping" && (ch === "w" || ch === "k")) {
        rect(ctx, x + rx, y + ry, 1, 1, ch === "w" ? outline : body);
        continue;
      }
      rect(ctx, x + rx, y + ry, 1, 1, color);
    }
  });
  if (placement.moving) {
    rect(ctx, x + (step ? 2 : 3), y + 9, 2, 1, outline);
    rect(ctx, x + (step ? 6 : 5), y + 9, 2, 1, outline);
  } else {
    rect(ctx, x + 2, y + 9, 2, 1, outline);
    rect(ctx, x + 6, y + 9, 2, 1, outline);
  }
  drawHat(ctx, citizen.role, x, y - 1);
  if (!placement.moving) {
    drawIcon(ctx, citizen.activity, fx, y, t);
  }
}

// Overlays -----------------------------------------------------------------

function pill(ctx: Ctx, cx: number, cy: number, text: string, fg: string) {
  ctx.font = "bold 7px ui-monospace, monospace";
  const width = Math.ceil(ctx.measureText(text).width) + 6;
  const x = Math.round(cx - width / 2);
  const y = Math.round(cy - 5);
  rect(ctx, x, y, width, 9, "rgba(7,11,16,0.85)");
  rect(ctx, x, y + 8, width, 1, fg);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, x + width / 2, y + 4.5);
}

export function drawBuildingOverlays(
  ctx: Ctx,
  buildings: readonly BuildingView[],
  inside: ReadonlyMap<string, CitizenView[]>,
  t: number,
) {
  for (const b of buildings) {
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const occupants = inside.get(b.id) ?? [];
    if (b.status === "under_construction" && b.constructionProgress !== null) {
      rect(ctx, x + 4, y - 6, w - 8, 4, "rgba(7,11,16,0.85)");
      rect(ctx, x + 5, y - 5, Math.round(((w - 10) * b.constructionProgress) / 100), 2, "#f0a020");
    }
    if (occupants.length > 0) {
      pill(ctx, b.doorX * TILE + 8, b.doorY === b.y ? y - 6 : y - 4, String(occupants.length), "#3dffb0");
      if (b.kind === "workshop" && occupants.some((c) => c.activity === "working")) {
        for (let i = 0; i < 3; i += 1) {
          const phase = ((t / 900 + i / 3) % 1 + 1) % 1;
          ctx.fillStyle = `rgba(200,200,210,${0.55 * (1 - phase)})`;
          const size = 2 + Math.round(phase * 3);
          ctx.fillRect(Math.round(x + w - 14 + phase * 6), Math.round(y - 6 - phase * 14), size, size);
        }
      }
    }
    if (b.batchShifts && b.status === "active" && b.productionProgress > 0) {
      for (let i = 0; i < b.batchShifts; i += 1) {
        rect(ctx, x + w - 4 - (b.batchShifts - i) * 4, y + b.h * TILE - 4, 3, 2, i < b.productionProgress ? "#3dffb0" : "rgba(7,11,16,0.6)");
      }
    }
  }
}

export function drawNight(
  ctx: Ctx,
  buildings: readonly BuildingView[],
  inside: ReadonlyMap<string, CitizenView[]>,
  worldS: number,
) {
  const dark = darkness(worldS);
  if (dark <= 0.01) {
    return;
  }
  ctx.fillStyle = `rgba(10,14,40,${0.58 * dark})`;
  ctx.fillRect(0, 0, WORLD_PX_W, WORLD_PX_H);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const item of decorations()) {
    if (item.kind !== "lamp") {
      continue;
    }
    const cx = item.x * TILE + 8;
    const cy = item.y * TILE + 4;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26);
    glow.addColorStop(0, `rgba(247,217,139,${0.38 * dark})`);
    glow.addColorStop(1, "rgba(247,217,139,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 26, cy - 26, 52, 52);
  }
  for (const b of buildings) {
    if ((inside.get(b.id) ?? []).length === 0 || b.openAir) {
      continue;
    }
    const doorTop = b.doorY === b.y;
    const wy = doorTop ? b.y * TILE + 5 : (b.y + b.h) * TILE - 12;
    ctx.fillStyle = `rgba(255,205,110,${0.7 * dark})`;
    ctx.fillRect(b.x * TILE + 6, wy, 5, 5);
    ctx.fillRect((b.x + b.w) * TILE - 11, wy, 5, 5);
  }
  ctx.restore();
}

export function drawSelection(ctx: Ctx, building: BuildingView | undefined, t: number) {
  if (!building) {
    return;
  }
  const pulse = 0.6 + Math.sin(t / 300) * 0.3;
  ctx.strokeStyle = `rgba(61,255,176,${pulse})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(building.x * TILE - 1.5, building.y * TILE - 1.5, building.w * TILE + 3, building.h * TILE + 3);
}

export function drawLabel(ctx: Ctx, text: string, cx: number, top: number) {
  ctx.font = "600 7px ui-sans-serif, system-ui, sans-serif";
  const width = Math.ceil(ctx.measureText(text).width) + 8;
  const x = Math.round(cx - width / 2);
  const y = Math.round(top - 12);
  rect(ctx, x, y, width, 10, "rgba(7,11,16,0.9)");
  ctx.fillStyle = "#e8f7f0";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + width / 2, y + 5);
}
