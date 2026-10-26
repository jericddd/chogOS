"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AiDecisionsLink } from "@/components/world/ai-decisions-link";
import { ActivityFeed } from "@/components/world/activity-feed";
import { GrowthDecisions } from "@/components/world/growth-decisions";
import { createLiveStore, sharedLiveStore, useLive, type LiveStore } from "@/components/world/live-store";
import { useNow } from "@/components/world/use-now";
import { WorldCanvas, type Selection, type WorldCanvasHandle } from "@/components/world/world-canvas";
import { WorldPanel, WorldStatus } from "@/components/world/world-panel";
import { runnerHealth } from "@/lib/world/clock";
import type { AiRunView } from "@/lib/ai/run-record";
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

export function LivingWorld({
  initial,
  realtime,
  aiRun,
}: {
  initial: WorldLoad;
  realtime: RealtimeConfig | null;
  aiRun: AiRunView;
}) {
  const store = useWorldStore(initial, realtime);
  const live = useLive(store);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selection = parseSelection(params);
  const [follow, setFollow] = useState(true);
  const [phonePane, setPhonePane] = useState<"town" | "growth" | "activity">("town");
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
    if (selectionKey) setPhonePane("town");
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
        <ActivityFeed store={store} initialFilter={feedFilter} aiRun={aiRun} />
      </div>
    );
  }

  const snapshot = live.snapshot;
  const health = now > 0 ? runnerHealth(snapshot.clock, now + live.skewMs) : "live";

  return (
    <div
      ref={stage}
      className="world-stage h-[calc(100dvh-var(--shell-header))] min-h-[24rem] overflow-hidden bg-[#07140c]"
    >
      <div className="world-map">
        <WorldCanvas
          ref={canvas}
          snapshot={snapshot}
          skewMs={live.skewMs}
          selection={selection}
          follow={follow}
          onSelect={onHit}
          onUserMove={() => setFollow(false)}
        />
        <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 md:max-w-[calc(100%-23.5rem)]">
          <p className="pointer-events-auto w-fit border-2 border-[var(--pixel-gold)] bg-background/90 px-3 py-1 text-[0.65rem] leading-4 text-muted">
            Observing · pan to explore the surrounding lands
          </p>
          <div className="pointer-events-auto flex gap-1.5">
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
          {health === "stalled" || health === "paused" ? (
            <p className="pointer-events-auto max-w-xs bg-background/90 px-3 py-2 text-xs text-warning">
              {health === "paused"
                ? "Paused by an operator. Citizens hold still until the simulation resumes."
                : "The simulation runner is not ticking. The world is frozen and will resume without replaying missed time."}
            </p>
          ) : null}
        </div>
      </div>
      <div className="world-lower">
        <div className="world-tabs" role="tablist" aria-label="World panels">
          {(
            [
              ["town", "Town"],
              ["growth", "Growth"],
              ["activity", "Activity"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={phonePane === id} onClick={() => setPhonePane(id)}>
              {label}
            </button>
          ))}
        </div>
        <aside aria-label="World details" className={`world-town world-hud pixel-panel${phonePane === "town" ? "" : " is-inactive"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-4 border-line px-3 py-2">
            <p className="font-display text-[0.6rem] leading-4 text-accent">One shared world</p>
            <AiDecisionsLink />
          </div>
          <div className="world-scroll min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
            <WorldStatus snapshot={snapshot} skewMs={live.skewMs} link={live.link} realtime={live.realtime} />
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
        <div className="world-feeds">
          <GrowthDecisions dock inactive={phonePane !== "growth"} clock={snapshot.clock} />
          <ActivityFeed store={store} initialFilter={feedFilter} dock inactive={phonePane !== "activity"} aiRun={aiRun} />
        </div>
      </div>
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
      className="grid h-9 w-9 place-items-center border-2 border-[var(--pixel-gold)] bg-background/90 font-display text-sm text-foreground hover:bg-accent hover:text-[var(--pixel-ink)]"
    >
      {children}
    </button>
  );
}
