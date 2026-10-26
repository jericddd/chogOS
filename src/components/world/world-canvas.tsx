"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { worldSecondsAt } from "@/lib/world/clock";
import { TILE } from "@/lib/world/layout";
import { ACTIVITY_LABEL, KIND_LABEL, ROLE_LABEL, citizenLabel, describeCitizenNow } from "@/lib/world/present";
import {
  WORLD_PX_H,
  WORLD_PX_W,
  cameraPaddingForOverlays,
  clampCamera,
  focusOn,
  hitTest,
  minScale,
  openingCamera,
  panBy,
  placeCitizens,
  screenToTile,
  zoomAt,
  type Camera,
  type Hit,
  type Placement,
  type ScreenBox,
  type Viewport,
} from "@/lib/world/scene";
import type { BuildingView, CitizenView, WorldSnapshot } from "@/lib/world/types";
import {
  drawBuildingOverlays,
  drawCitizen,
  drawLabel,
  drawNight,
  drawRoadSelection,
  drawSelection,
  drawStaticLayer,
  staticLayerKey,
} from "@/components/world/scene/draw";
import { completeOverlayTiles } from "@/lib/world/roads";

export type Selection =
  | { type: "citizen"; tokenId: string }
  | { type: "building"; id: string }
  | { type: "road"; id: string }
  | { type: "project"; id: string }
  | null;

export type WorldCanvasHandle = {
  zoom: (factor: number) => void;
  reset: () => void;
  focus: (selection: Selection) => void;
};

type Props = {
  snapshot: WorldSnapshot;
  skewMs: number;
  selection: Selection;
  follow: boolean;
  onSelect: (hit: Hit) => void;
  onUserMove: () => void;
  ref?: Ref<WorldCanvasHandle>;
};

type Tip = { x: number; y: number; width: number; hit: NonNullable<Hit> };

const FRAME_MS = 1000 / 30;

function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { scale: a.scale + (b.scale - a.scale) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function buildingMap(snapshot: WorldSnapshot): Map<string, BuildingView> {
  return new Map(snapshot.buildings.map((b) => [b.id, b]));
}

function overlayPadding(container: HTMLElement): Pick<Viewport, "padLeft" | "padTop" | "padRight" | "padBottom"> {
  const map = container.getBoundingClientRect();
  const stage = container.closest(".world-stage");
  if (!stage) return { padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 };
  const overlays: ScreenBox[] = [];
  for (const node of stage.querySelectorAll<HTMLElement>(".world-town, .world-growth, .world-civilization, .world-activity, .world-inspect")) {
    if (getComputedStyle(node).display === "none") continue;
    const box = node.getBoundingClientRect();
    overlays.push({
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    });
  }
  return cameraPaddingForOverlays(
    { left: map.left, top: map.top, right: map.right, bottom: map.bottom, width: map.width, height: map.height },
    overlays,
  );
}

export function WorldCanvas({ snapshot, skewMs, selection, follow, onSelect, onUserMove, ref }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ snapshot, skewMs, selection, follow, onSelect, onUserMove });
  const camera = useRef<Camera | null>(null);
  const target = useRef<Camera | null>(null);
  const view = useRef<Viewport>({ width: 0, height: 0 });
  const userMoved = useRef(false);
  const placements = useRef<Placement[]>([]);
  const hovered = useRef<Hit>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    live.current = { snapshot, skewMs, selection, follow, onSelect, onUserMove };
  });

  const markMoved = () => {
    userMoved.current = true;
    target.current = null;
    live.current.onUserMove();
  };

  const focusSelection = (next: Selection, zoom = true) => {
    const cam = camera.current;
    if (!cam || !next || view.current.width === 0) {
      return;
    }
    const { snapshot: snap, skewMs: skew } = live.current;
    const fit = minScale(view.current);
    const scale = zoom ? Math.max(cam.scale, fit * 2.2) : cam.scale;
    if (next.type === "building") {
      const b = snap.buildings.find((item) => item.id === next.id);
      if (b) {
        target.current = focusOn(cam, view.current, b.x + b.w / 2, b.y + b.h / 2, scale);
        userMoved.current = true;
      }
      return;
    }
    if (next.type === "road") {
      const road = (snap.roads ?? []).find((item) => item.id === next.id);
      const tile = road?.tiles[0];
      if (tile) {
        target.current = focusOn(cam, view.current, tile.x + 0.5, tile.y + 0.5, scale);
        userMoved.current = true;
      }
      return;
    }
    if (next.type === "project") {
      const project = (snap.townProjects ?? []).find((item) => item.id === next.id);
      if (project?.relatedRoadId) {
        focusSelection({ type: "road", id: project.relatedRoadId }, zoom);
      } else if (project?.relatedBuildingId) {
        focusSelection({ type: "building", id: project.relatedBuildingId }, zoom);
      }
      return;
    }
    // Imperative camera focus, not render. The frame loop already samples wall time.
    // eslint-disable-next-line react-hooks/purity -- Date.now is for citizen placement at click time
    const worldS = worldSecondsAt(snap.clock, Date.now() + skew);
    const placed = placeCitizens(
      snap.citizens,
      buildingMap(snap),
      worldS,
      completeOverlayTiles(snap.roads ?? []),
    ).find((p) => p.tokenId === next.tokenId);
    if (placed) {
      target.current = focusOn(cam, view.current, placed.x, placed.y - 0.3, scale);
      userMoved.current = true;
    }
  };

  useImperativeHandle(ref, () => ({
    zoom(factor) {
      const cam = target.current ?? camera.current;
      if (!cam) {
        return;
      }
      target.current = zoomAt(cam, view.current, factor, view.current.width / 2, view.current.height / 2);
      userMoved.current = true;
    },
    reset() {
      userMoved.current = false;
      target.current = openingCamera(view.current);
    },
    focus(next) {
      focusSelection(next);
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    let layer: { key: string; canvas: HTMLCanvasElement } | null = null;
    let visible = true;
    let raf = 0;
    let last = 0;

    const resize = () => {
      const box = container.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      view.current = { width: box.width, height: box.height, ...overlayPadding(container) };
      camera.current =
        !camera.current || !userMoved.current
          ? openingCamera(view.current)
          : clampCamera(camera.current, view.current);
      target.current = null;
      last = 0;
    };
    resize();
    const resizer = new ResizeObserver(resize);
    resizer.observe(container);
    const stage = container.closest(".world-stage");
    if (stage) resizer.observe(stage);
    const watcher = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    });
    watcher.observe(container);

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || t - last < FRAME_MS) {
        return;
      }
      last = t;
      const { snapshot: snap, skewMs: skew, selection: sel, follow: following } = live.current;
      const byId = buildingMap(snap);
      const worldS = worldSecondsAt(snap.clock, Date.now() + skew);
      const overlay = completeOverlayTiles(snap.roads ?? []);
      const placed = placeCitizens(snap.citizens, byId, worldS, overlay);
      placements.current = placed;

      let cam = camera.current ?? openingCamera(view.current);
      if (following && sel?.type === "citizen") {
        const me = placed.find((p) => p.tokenId === sel.tokenId);
        if (me) {
          target.current = focusOn(cam, view.current, me.x, me.y - 0.3, (target.current ?? cam).scale);
        }
      }
      if (target.current) {
        cam = lerpCamera(cam, target.current, 0.2);
        if (Math.abs(cam.scale - target.current.scale) < 0.002 && Math.hypot(cam.x - target.current.x, cam.y - target.current.y) < 0.5) {
          cam = target.current;
          target.current = null;
        }
      }
      camera.current = cam;

      const key = staticLayerKey(snap.buildings, overlay);
      if (!layer || layer.key !== key) {
        const off = document.createElement("canvas");
        off.width = WORLD_PX_W;
        off.height = WORLD_PX_H;
        const offCtx = off.getContext("2d");
        if (offCtx) {
          drawStaticLayer(offCtx, snap.buildings, overlay);
        }
        layer = { key, canvas: off };
      }

      const dpr = canvas.width / Math.max(1, view.current.width);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0b1712";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, cam.x * dpr, cam.y * dpr);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(layer.canvas, 0, 0);

      const citizens = new Map(snap.citizens.map((c) => [c.tokenId, c]));
      const inside = new Map<string, CitizenView[]>();
      for (const p of placed) {
        if (p.insideId) {
          const list = inside.get(p.insideId) ?? [];
          const c = citizens.get(p.tokenId);
          if (c) {
            list.push(c);
          }
          inside.set(p.insideId, list);
        }
      }
      drawBuildingOverlays(ctx, snap.buildings, inside, t);

      const hover = hovered.current;
      const drawn = placed.filter((p) => p.visible).sort((a, b) => a.y - b.y);
      for (const p of drawn) {
        const c = citizens.get(p.tokenId);
        if (!c) {
          continue;
        }
        const emphasis =
          sel?.type === "citizen" && sel.tokenId === p.tokenId
            ? "selected"
            : hover?.type === "citizen" && hover.tokenId === p.tokenId
              ? "hover"
              : "none";
        drawCitizen(ctx, c, p, t, emphasis);
      }
      drawNight(ctx, snap.buildings, inside, worldS);
      if (sel?.type === "building") {
        drawSelection(ctx, byId.get(sel.id), t);
      } else if (hover?.type === "building") {
        drawSelection(ctx, byId.get(hover.id), 0);
      }
      if (sel?.type === "road") {
        drawRoadSelection(ctx, (snap.roads ?? []).find((item) => item.id === sel.id), t);
      } else if (hover?.type === "road") {
        drawRoadSelection(ctx, (snap.roads ?? []).find((item) => item.id === hover.id), 0);
      }
      if (sel?.type === "citizen") {
        const p = placed.find((item) => item.tokenId === sel.tokenId);
        const c = citizens.get(sel.tokenId);
        if (p && c) {
          if (p.visible) {
            drawLabel(ctx, citizenLabel(c), p.x * TILE, p.y * TILE - 11);
          } else if (p.insideId) {
            const b = byId.get(p.insideId);
            if (b) {
              drawSelection(ctx, b, t);
              drawLabel(ctx, `${citizenLabel(c)} inside`, (b.x + b.w / 2) * TILE, b.y * TILE - 6);
            }
          }
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      resizer.disconnect();
      watcher.disconnect();
    };
  }, []);

  useEffect(() => {
    const key = selection
      ? selection.type === "citizen"
        ? `c:${selection.tokenId}`
        : `${selection.type}:${selection.id}`
      : "";
    if (key) {
      focusSelection(selection);
    }
    // Focus only when the selected entity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.type, selection && (selection.type === "citizen" ? selection.tokenId : selection.id)]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { lastX: number; lastY: number; startX: number; startY: number; moved: boolean } | null = null;
    let pinch: { dist: number; midX: number; midY: number } | null = null;
    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    const local = (event: PointerEvent | WheelEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    const hitAt = (x: number, y: number): Hit => {
      const cam = camera.current;
      if (!cam) {
        return null;
      }
      return hitTest(
        screenToTile(cam, x, y),
        placements.current,
        live.current.snapshot.buildings,
        cam,
        live.current.snapshot.roads ?? [],
      );
    };

    const pinchInfo = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) {
        return null;
      }
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
    };

    const down = (event: PointerEvent) => {
      const p = local(event);
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, p);
      if (pointers.size === 1) {
        drag = { lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, moved: false };
      } else if (pointers.size === 2) {
        pinch = pinchInfo();
        if (drag) {
          drag.moved = true;
        }
      }
    };

    const move = (event: PointerEvent) => {
      const p = local(event);
      if (!pointers.has(event.pointerId)) {
        if (event.pointerType !== "mouse") {
          return;
        }
        const hit = hitAt(p.x, p.y);
        hovered.current = hit;
        canvas.style.cursor = hit ? "pointer" : "grab";
        setTip(hit ? { x: p.x, y: p.y, width: view.current.width, hit } : null);
        return;
      }
      pointers.set(event.pointerId, p);
      const cam = camera.current;
      if (!cam) {
        return;
      }
      if (pointers.size >= 2 && pinch) {
        const next = pinchInfo();
        if (!next || pinch.dist === 0) {
          return;
        }
        let moved = zoomAt(cam, view.current, next.dist / pinch.dist, next.midX, next.midY);
        moved = panBy(moved, view.current, next.midX - pinch.midX, next.midY - pinch.midY);
        camera.current = moved;
        pinch = next;
        markMoved();
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 5) {
          drag.moved = true;
          setTip(null);
          canvas.style.cursor = "grabbing";
        }
        if (drag.moved) {
          camera.current = panBy(cam, view.current, p.x - drag.lastX, p.y - drag.lastY);
          markMoved();
        }
        drag.lastX = p.x;
        drag.lastY = p.y;
      }
    };

    const up = (event: PointerEvent) => {
      const p = local(event);
      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinch = null;
      }
      if (pointers.size === 0) {
        if (drag && !drag.moved) {
          live.current.onSelect(hitAt(p.x, p.y));
        }
        drag = null;
        canvas.style.cursor = "grab";
      } else if (pointers.size === 1) {
        const [rest] = [...pointers.values()];
        if (rest) {
          drag = { lastX: rest.x, lastY: rest.y, startX: rest.x, startY: rest.y, moved: true };
        }
      }
    };

    const leave = () => {
      hovered.current = null;
      setTip(null);
    };

    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        setHint(true);
        if (hintTimer) {
          clearTimeout(hintTimer);
        }
        hintTimer = setTimeout(() => setHint(false), 1400);
        return;
      }
      event.preventDefault();
      const cam = camera.current;
      if (!cam) {
        return;
      }
      const p = local(event);
      const factor = Math.min(2, Math.max(0.5, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.004))));
      camera.current = zoomAt(cam, view.current, factor, p.x, p.y);
      markMoved();
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      if (hintTimer) {
        clearTimeout(hintTimer);
      }
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const cam = camera.current;
    if (!cam) {
      return;
    }
    const step = 48;
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const pan = pans[event.key];
    if (pan) {
      event.preventDefault();
      camera.current = panBy(cam, view.current, pan[0], pan[1]);
      markMoved();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      camera.current = zoomAt(cam, view.current, 1.25, view.current.width / 2, view.current.height / 2);
      markMoved();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      camera.current = zoomAt(cam, view.current, 0.8, view.current.width / 2, view.current.height / 2);
      markMoved();
    } else if (event.key === "0") {
      event.preventDefault();
      userMoved.current = false;
      target.current = openingCamera(view.current);
    } else if (event.key === "Escape") {
      live.current.onSelect(null);
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="application"
      aria-label="Map of chogOS. Arrow keys pan, plus and minus zoom, 0 resets the view, Escape clears the selection. The day, civilization, town growth, and activity are in the panels inside this screen."
      className="relative h-full w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: "grab", imageRendering: "pixelated" }} />
      {tip ? <Tooltip tip={tip} snapshot={snapshot} /> : null}
      <p
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-background/85 px-3 py-1 text-xs text-muted transition-opacity ${
          hint ? "opacity-100" : "opacity-0"
        }`}
      >
        Hold Ctrl or ⌘ and scroll to zoom. Drag to pan.
      </p>
    </div>
  );
}

function Tooltip({ tip, snapshot }: { tip: Tip; snapshot: WorldSnapshot }) {
  const buildings = new Map(snapshot.buildings.map((b) => [b.id, b]));
  let title = "";
  let lines: string[] = [];
  if (tip.hit.type === "citizen") {
    const tokenId = tip.hit.tokenId;
    const c = snapshot.citizens.find((item) => item.tokenId === tokenId);
    if (!c) {
      return null;
    }
    title = citizenLabel(c);
    lines = [`${c.role ? ROLE_LABEL[c.role] : "No job"} · ${c.origin === "founding" ? "Founding" : "Community"}`, describeCitizenNow(c, buildings)];
  } else if (tip.hit.type === "road") {
    const roadId = tip.hit.id;
    const road = (snapshot.roads ?? []).find((item) => item.id === roadId);
    if (!road) {
      return null;
    }
    title = road.name;
    lines = [
      `Catalog ${road.stubId} · ${road.status}`,
      road.servedPlotIds.length > 0 ? `Serves ${road.servedPlotIds.join(", ")}` : "No newly served lots recorded",
    ];
  } else {
    const id = tip.hit.id;
    const b = buildings.get(id);
    if (!b) {
      return null;
    }
    const here = snapshot.citizens.filter((c) => c.locationId === b.id && c.activity !== "unavailable");
    title = b.name;
    lines = [
      b.status === "under_construction" ? `${KIND_LABEL[b.kind]} · under construction ${b.constructionProgress ?? 0}%` : KIND_LABEL[b.kind],
      here.length === 0
        ? "Nobody here right now"
        : `${here.length} here · ${[...new Set(here.map((c) => ACTIVITY_LABEL[c.activity].toLowerCase()))].join(", ")}`,
    ];
    if (b.kind === "storehouse") {
      lines.push(
        Object.entries(b.stock)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ") + " (simulated)",
      );
    }
  }
  const left = tip.x > tip.width - 240 ? tip.x - 236 : tip.x + 14;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-56 rounded-lg border border-line bg-background/95 px-3 py-2 text-xs shadow-lg"
      style={{ left, top: tip.y + 14 }}
    >
      <p className="font-medium text-foreground">{title}</p>
      {lines.map((line) => (
        <p key={line} className="mt-0.5 text-muted">
          {line}
        </p>
      ))}
    </div>
  );
}
