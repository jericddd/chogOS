"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ActivityFeed } from "@/components/world/activity-feed";
import { GrowthDecisions } from "@/components/world/growth-decisions";
import { createLiveStore, sharedLiveStore, useLive, type LiveStore } from "@/components/world/live-store";
import { useNow } from "@/components/world/use-now";
import { WorldCanvas, type Selection, type WorldCanvasHandle } from "@/components/world/world-canvas";
import { WorldPanel, WorldStatus } from "@/components/world/world-panel";
import { runnerHealth } from "@/lib/world/clock";
import type { Hit } from "@/lib/world/scene";
import type { EventFilter, RealtimeConfig, WorldLoad, WorldUnavailable } from "@/lib/world/types";

export function useWorldStore(initial: WorldLoad, realtime: RealtimeConfig | null): LiveStore {
  const [store] = useState(() =>
    typeof window === "undefined" ? createLiveStore(initial) : sharedLiveStore(initial, realtime),
  );
  return store;
}

function parseSelection(params: URLSearchParams | null): Selection {
  const citizen = params?.get("citizen");
  if (citizen && /^[0-9]{1,78}$/.test(citizen)) {
    return { type: "citizen", tokenId: citizen };
  }
  const building = params?.get("building");
  if (building && /^[a-z0-9-]{2,40}$/.test(building)) {
    return { type: "building", id: building };
  }
  const road = params?.get("road");
  if (road && /^[a-z0-9-]{2,40}$/.test(road)) {
    return { type: "road", id: road };
  }
  const project = params?.get("project");
  if (project && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(project)) {
    return { type: "project", id: project };
  }
  return null;
}

function selectionHref(pathname: string, selection: Selection): string {
  if (!selection) {
    return pathname;
  }
  if (selection.type === "citizen") {
    return `${pathname}?citizen=${encodeURIComponent(selection.tokenId)}`;
  }
  if (selection.type === "road") {
    return `${pathname}?road=${encodeURIComponent(selection.id)}`;
  }
  if (selection.type === "project") {
    return `${pathname}?project=${encodeURIComponent(selection.id)}`;
  }
  return `${pathname}?building=${encodeURIComponent(selection.id)}`;
}

const UNAVAILABLE_TITLE: Record<WorldUnavailable["status"], string> = {
  unconfigured: "The world is not connected to its database",
  migration_pending: "The world is waiting for its database migration",
  not_initialized: "The world has not been founded yet",
  error: "The world could not be read",
};

export function WorldUnavailablePanel({ unavailable }: { unavailable: WorldUnavailable }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-5 py-8">
      <p className="text-xs tracking-[0.16em] text-warning uppercase">World offline</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">{UNAVAILABLE_TITLE[unavailable.status]}</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{unavailable.detail}</p>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
        Nothing is drawn from placeholder data. The map appears once the shared simulation has real state to show.
      </p>
    </div>
  );
}

export function LivingWorld({ initial, realtime }: { initial: WorldLoad; realtime: RealtimeConfig | null }) {
  const store = useWorldStore(initial, realtime);
  const live = useLive(store);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selection = parseSelection(params);
  const [follow, setFollow] = useState(true);
  const canvas = useRef<WorldCanvasHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const now = useNow(5_000);
  const selectionKey = selection
    ? `${selection.type}:${selection.type === "citizen" ? selection.tokenId : selection.id}`
    : "";
  const [seenKey, setSeenKey] = useState(selectionKey);

  if (selectionKey !== seenKey) {
    setSeenKey(selectionKey);
    setFollow(true);
  }

  useEffect(() => {
    if (!selectionKey) {
      return;
    }
    const box = stage.current?.getBoundingClientRect();
    if (box && (box.bottom < 120 || box.top > window.innerHeight - 120)) {
      stage.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectionKey]);

  const select = (next: Selection) => {
    router.replace(selectionHref(pathname, next), { scroll: false });
  };

  const onHit = (hit: Hit) => {
    if (!hit) {
      select(null);
      return;
    }
    if (hit.type === "citizen") {
      select({ type: "citizen", tokenId: hit.tokenId });
      return;
    }
    if (hit.type === "road") {
      select({ type: "road", id: hit.id });
      return;
    }
    select({ type: "building", id: hit.id });
  };

  const feedFilter: EventFilter = {};

  if (!live.snapshot) {
    return (
      <div className="space-y-8">
        <WorldUnavailablePanel unavailable={live.unavailable ?? { status: "error", detail: "The world could not be read." }} />
        <GrowthDecisions />
        <ActivityFeed store={store} initialFilter={feedFilter} />
      </div>
    );
  }

  const snapshot = live.snapshot;
  const health = now > 0 ? runnerHealth(snapshot.clock, now + live.skewMs) : "live";

  return (
    <div className="space-y-8">
      <div ref={stage} className="grid scroll-mt-4 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative h-[62vh] min-h-[340px] overflow-hidden rounded-2xl border border-line bg-[#0b1712] sm:h-auto sm:aspect-[3/2] sm:max-h-[78vh] sm:min-h-0">
          <WorldCanvas
            ref={canvas}
            snapshot={snapshot}
            skewMs={live.skewMs}
            selection={selection}
            follow={follow}
            onSelect={onHit}
            onUserMove={() => setFollow(false)}
          />
          <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
            <p className="pointer-events-auto rounded-full bg-background/85 px-3 py-1 text-xs text-muted">
              Observing · pan to explore the surrounding lands
            </p>
            {health === "stalled" || health === "paused" ? (
              <p className="pointer-events-auto max-w-xs rounded-lg bg-background/90 px-3 py-2 text-xs text-warning">
                {health === "paused"
                  ? "Paused by an operator. Citizens hold still until the simulation resumes."
                  : "The simulation runner is not ticking. The world is frozen and will resume without replaying missed time."}
              </p>
            ) : null}
          </div>
          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <MapButton label="Zoom in" onClick={() => canvas.current?.zoom(1.4)}>
              +
            </MapButton>
            <MapButton label="Zoom out" onClick={() => canvas.current?.zoom(1 / 1.4)}>
              −
            </MapButton>
            <MapButton
              label="Reset view"
              onClick={() => {
                setFollow(false);
                canvas.current?.reset();
              }}
            >
              ⤢
            </MapButton>
          </div>
        </div>
        <aside className="space-y-4" aria-label="World details">
          <WorldStatus snapshot={snapshot} skewMs={live.skewMs} link={live.link} realtime={live.realtime} />
          <div className="rounded-xl border border-line bg-card px-4 py-4 lg:max-h-[calc(78vh-7rem)] lg:overflow-y-auto">
            <WorldPanel
              snapshot={snapshot}
              skewMs={live.skewMs}
              selection={selection}
              recent={live.recent}
              follow={follow}
              onToggleFollow={() => {
                setFollow((value) => !value);
                if (!follow) {
                  canvas.current?.focus(selection);
                }
              }}
              onPick={select}
            />
          </div>
        </aside>
      </div>
      <GrowthDecisions />
      <ActivityFeed store={store} initialFilter={feedFilter} />
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-background/90 text-lg text-foreground hover:border-accent/60 hover:text-accent"
    >
      {children}
    </button>
  );
}
