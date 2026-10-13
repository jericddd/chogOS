"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CitizenPortrait } from "@/components/citizens/portrait";
import { EventItem } from "@/components/world/event-item";
import type { LinkState, RealtimeState } from "@/components/world/live-store";
import type { Selection } from "@/components/world/world-canvas";
import { useNow } from "@/components/world/use-now";
import {
  dayPhase,
  formatRealAgo,
  formatWorldDuration,
  formatWorldTime,
  runnerHealth,
  worldDay,
  worldSecondsAt,
} from "@/lib/world/clock";
import {
  ACTIVITY_LABEL,
  KIND_LABEL,
  RESOURCE_LABEL,
  ROLE_LABEL,
  buildingHref,
  citizenHref,
  citizenLabel,
  describeCitizenNow,
  profileHref,
} from "@/lib/world/present";
import { describeSpeed } from "@/lib/world/speed";
import { matchesFilter, mergeEvents } from "@/lib/world/sync";
import type { BuildingView, CitizenView, EventFilter, EventPage, WorldActivity, WorldEventView, WorldSnapshot } from "@/lib/world/types";

const HEALTH_TEXT = {
  live: { label: "Live", tone: "bg-accent", detail: "The shared simulation is running." },
  delayed: { label: "Delayed", tone: "bg-warning", detail: "The runner is late. Citizens wait until the next tick." },
  stalled: {
    label: "Runner stopped",
    tone: "bg-warning",
    detail: "No tick recently. The world is frozen and will resume without replaying missed time.",
  },
  paused: { label: "Paused", tone: "bg-muted", detail: "An operator paused the simulation." },
} as const;

const LINK_TEXT: Record<LinkState, string> = {
  connecting: "Connecting",
  live: "Realtime updates",
  polling: "Refreshing every few seconds",
  reconnecting: "Reconnecting",
  offline: "Offline. Retrying",
};

export function WorldStatus({
  snapshot,
  skewMs,
  link,
  realtime,
}: {
  snapshot: WorldSnapshot;
  skewMs: number;
  link: LinkState;
  realtime: RealtimeState;
}) {
  const now = useNow(1_000);
  const clock = snapshot.clock;
  const serverNow = now > 0 ? now + skewMs : Date.parse(clock.serverNow);
  const worldS = worldSecondsAt(clock, serverNow);
  const health = runnerHealth(clock, serverNow);
  const info = HEALTH_TEXT[health];
  const phase = dayPhase(worldS);
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-serif text-2xl tracking-tight tabular-nums" aria-live="off">
          {formatWorldTime(worldS)}
        </p>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs" title={info.detail}>
          <span className={`h-2 w-2 rounded-full ${info.tone} ${health === "live" ? "animate-pulse" : ""}`} />
          {info.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        <span className="capitalize">{phase}</span> · {describeSpeed(clock.speed)}
      </p>
      <p className="mt-1 text-xs text-muted">
        Tick {clock.tickSeq.toLocaleString("en-US")}
        {now > 0 ? ` · ${formatRealAgo(clock.lastTickAt, serverNow)}` : ""} · {LINK_TEXT[link]}
        {realtime === "error" ? " · realtime unavailable, polling instead" : ""}
      </p>
      {health !== "live" ? <p className="mt-2 text-xs leading-5 text-warning">{info.detail}</p> : null}
    </div>
  );
}

function useEntityEvents(filter: EventFilter, recent: readonly WorldEventView[]) {
  const key = `${filter.tokenId ?? ""}|${filter.buildingId ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; events: WorldEventView[]; error: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "8" });
    if (filter.tokenId) params.set("citizen", filter.tokenId);
    if (filter.buildingId) params.set("building", filter.buildingId);
    fetch(`/api/world/events?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.json() as Promise<EventPage>)
      .then((page) => setLoaded({ key, events: page.status === "ok" ? page.events : [], error: page.status !== "ok" }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ key, events: [], error: true });
        }
      });
    return () => controller.abort();
    // The key captures the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = loaded?.key === key ? loaded : null;
  const live = recent.filter((event) => matchesFilter(event, filter));
  return {
    events: mergeEvents(current?.events ?? [], live, 8),
    loading: current === null,
    error: current?.error ?? false,
  };
}

function EntityHistory({
  filter,
  recent,
  citizenName,
  allHref,
}: {
  filter: EventFilter;
  recent: readonly WorldEventView[];
  citizenName: (tokenId: string) => string | null;
  allHref?: string;
}) {
  const now = useNow(15_000);
  const { events, loading, error } = useEntityEvents(filter, recent);
  return (
    <section className="mt-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Recent history</h3>
        {allHref ? (
          <Link href={allHref} className="text-xs text-accent">
            Full history
          </Link>
        ) : null}
      </div>
      {loading && events.length === 0 ? <p className="mt-2 text-sm text-muted">Reading history…</p> : null}
      {!loading && events.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{error ? "History could not be read." : "Nothing recorded yet."}</p>
      ) : null}
      <ul className="mt-1 divide-y divide-line">
        {events.map((event) => (
          <EventItem key={event.id} event={event} now={now} citizenName={citizenName} compact />
        ))}
      </ul>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.68rem] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function PlaceLink({ building }: { building: BuildingView | undefined }) {
  if (!building) {
    return <span className="text-muted">None</span>;
  }
  return (
    <Link href={buildingHref(building.id)} scroll={false} className="text-violet hover:underline">
      {building.name}
    </Link>
  );
}

function CitizenLink({ citizen }: { citizen: CitizenView }) {
  return (
    <Link href={citizenHref(citizen.tokenId)} scroll={false} className="text-accent hover:underline">
      {citizenLabel(citizen)}
    </Link>
  );
}

function Progress({ value, tone = "bg-accent" }: { value: number; tone?: string }) {
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function CitizenInspector({
  citizen,
  snapshot,
  skewMs,
  recent,
  citizenName,
  onClose,
  follow,
  onToggleFollow,
}: {
  citizen: CitizenView;
  snapshot: WorldSnapshot;
  skewMs: number;
  recent: readonly WorldEventView[];
  citizenName: (tokenId: string) => string | null;
  onClose: () => void;
  follow: boolean;
  onToggleFollow: () => void;
}) {
  const now = useNow(1_000);
  const buildings = useMemo(() => new Map(snapshot.buildings.map((b) => [b.id, b])), [snapshot.buildings]);
  const worldS = worldSecondsAt(snapshot.clock, now > 0 ? now + skewMs : Date.parse(snapshot.clock.serverNow));
  const remaining = citizen.worldEndsS === null ? null : citizen.worldEndsS - worldS;
  return (
    <article aria-label={`Citizen ${citizenLabel(citizen)}`}>
      <div className="flex items-start gap-3">
        <div className="portrait-frame h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-line">
          <CitizenPortrait tokenId={citizen.tokenId} name={citizen.name} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[0.68rem] tracking-[0.16em] text-accent uppercase">
            {citizen.origin === "founding" ? "Founding citizen" : "Community citizen"}
          </p>
          <h2 className="truncate font-serif text-2xl tracking-tight">{citizenLabel(citizen)}</h2>
          <p className="text-xs text-muted">Token {citizen.tokenId}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-background hover:text-foreground" aria-label="Close inspector">
          ✕
        </button>
      </div>
      <p className="mt-3 text-sm">{describeCitizenNow(citizen, buildings)}</p>
      {remaining !== null && citizen.activity !== "unavailable" ? (
        <p className="mt-0.5 text-xs text-muted">
          {remaining > 0 ? `About ${formatWorldDuration(remaining)} left` : "Finishing at the next tick"}
          {citizen.worldEndsS !== null ? ` · until ${formatWorldTime(citizen.worldEndsS)}` : ""}
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <Fact label="Occupation">{citizen.role ? ROLE_LABEL[citizen.role] : "Unassigned"}</Fact>
        <Fact label="Workplace">
          <PlaceLink building={citizen.workId ? buildings.get(citizen.workId) : undefined} />
        </Fact>
        <Fact label="Home">
          {citizen.homeId ? <PlaceLink building={buildings.get(citizen.homeId)} /> : <span className="text-muted">Shelters at Commons Hall</span>}
        </Fact>
        <Fact label="Shifts today">{citizen.dayIndex === worldDay(worldS) ? citizen.shiftsToday : 0} of 2</Fact>
        <Fact label="Decided by">
          {citizen.decisionSource === "ai" ? "AI mind" : citizen.decisionSource === "system" ? "System" : "Simulation rules"}
        </Fact>
        <Fact label="Status">{ACTIVITY_LABEL[citizen.activity]}</Fact>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onToggleFollow}
          aria-pressed={follow}
          className={`rounded-full border px-3 py-1.5 text-xs ${follow ? "border-accent text-accent" : "border-line text-muted hover:text-foreground"}`}
        >
          {follow ? "Following" : "Follow on map"}
        </button>
        <Link href={profileHref(citizen.tokenId)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:text-foreground">
          Open profile
        </Link>
      </div>
      <EntityHistory filter={{ tokenId: citizen.tokenId }} recent={recent} citizenName={citizenName} allHref={`/activity?citizen=${citizen.tokenId}`} />
    </article>
  );
}

function BuildingInspector({
  building,
  snapshot,
  recent,
  citizenName,
  onClose,
}: {
  building: BuildingView;
  snapshot: WorldSnapshot;
  recent: readonly WorldEventView[];
  citizenName: (tokenId: string) => string | null;
  onClose: () => void;
}) {
  const residents = snapshot.citizens.filter((c) => c.homeId === building.id);
  const workers = snapshot.citizens.filter((c) => c.workId === building.id);
  const here = snapshot.citizens.filter((c) => c.locationId === building.id && c.activity !== "unavailable");
  const coming = snapshot.citizens.filter((c) => c.activity === "walking" && c.destinationId === building.id);
  const stock = Object.entries(building.stock);
  return (
    <article aria-label={building.name}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.68rem] tracking-[0.16em] text-violet uppercase">{KIND_LABEL[building.kind]}</p>
          <h2 className="font-serif text-2xl tracking-tight">{building.name}</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-background hover:text-foreground" aria-label="Close inspector">
          ✕
        </button>
      </div>
      {building.status === "under_construction" ? (
        <div className="mt-3">
          <p className="text-sm">Under construction · {building.constructionProgress ?? 0}%</p>
          <Progress value={building.constructionProgress ?? 0} tone="bg-[#f0a020]" />
          <p className="mt-1 text-xs text-muted">Each builder shift adds 4% and uses 3 wood and 2 stone from the Storehouse.</p>
        </div>
      ) : building.completedAt ? (
        <p className="mt-2 text-xs text-muted">Completed by simulated builders.</p>
      ) : null}
      <dl className="mt-4 grid grid-cols-2 gap-3">
        {building.capacity !== null ? (
          <Fact label={building.kind === "hall" ? "Shelter" : "Residents"}>
            {building.kind === "hall" ? `${here.length} of ${building.capacity} places in use` : `${residents.length} of ${building.capacity}`}
          </Fact>
        ) : null}
        {building.jobSlots !== null && building.role ? (
          <Fact label={`${ROLE_LABEL[building.role]}s`}>
            {workers.length} of {building.jobSlots} jobs
          </Fact>
        ) : null}
        <Fact label="Here now">{here.length}</Fact>
        <Fact label="On the way">{coming.length}</Fact>
        {building.batchShifts ? (
          <Fact label="Production">
            {building.productionProgress} of {building.batchShifts} shifts · {building.batchesCompleted} batches
          </Fact>
        ) : null}
      </dl>
      {stock.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Simulated stock</h3>
          <ul className="mt-2 grid grid-cols-2 gap-2">
            {stock.map(([resource, amount]) => (
              <li key={resource} className="rounded-lg border border-line px-3 py-2 text-sm">
                <span className="text-muted">{RESOURCE_LABEL[resource] ?? resource}</span>
                <span className="float-right tabular-nums">{amount}</span>
                <Progress value={(amount / 400) * 100} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Counts of simulated goods, from 0 to 400. Not token balances.</p>
        </div>
      ) : null}
      {here.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Present</h3>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {here.map((c) => (
              <li key={c.tokenId}>
                <CitizenLink citizen={c} /> <span className="text-xs text-muted">{ACTIVITY_LABEL[c.activity].toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {residents.length > 0 && building.kind === "house" ? (
        <div className="mt-4">
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Residents</h3>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {residents.map((c) => (
              <li key={c.tokenId}>
                <CitizenLink citizen={c} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <EntityHistory filter={{ buildingId: building.id }} recent={recent} citizenName={citizenName} allHref={`/activity?building=${building.id}`} />
    </article>
  );
}

const ACTIVITY_ORDER: WorldActivity[] = [
  "working",
  "gathering",
  "building",
  "walking",
  "shopping",
  "socializing",
  "resting",
  "sleeping",
  "idle",
];

function WorldOverview({ snapshot, onPick }: { snapshot: WorldSnapshot; onPick: (selection: Selection) => void }) {
  const present = snapshot.citizens.filter((c) => c.activity !== "unavailable");
  const counts = new Map<WorldActivity, number>();
  for (const c of present) {
    counts.set(c.activity, (counts.get(c.activity) ?? 0) + 1);
  }
  const store = snapshot.buildings.find((b) => b.kind === "storehouse");
  const sites = snapshot.buildings.filter((b) => b.status === "under_construction");
  const founding = present.filter((c) => c.origin === "founding").length;
  const sortedCitizens = [...snapshot.citizens].sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
  return (
    <div>
      <h2 className="font-serif text-2xl tracking-tight">The civilization</h2>
      <p className="mt-1 text-sm text-muted">
        {present.length} citizens in the world · {founding} founding · {present.length - founding} community
      </p>
      <ul className="mt-3 grid grid-cols-3 gap-2 text-center">
        {ACTIVITY_ORDER.filter((a) => (counts.get(a) ?? 0) > 0).map((activity) => (
          <li key={activity} className="rounded-lg border border-line px-2 py-2">
            <p className="font-serif text-xl tabular-nums">{counts.get(activity)}</p>
            <p className="text-[0.68rem] text-muted">{ACTIVITY_LABEL[activity]}</p>
          </li>
        ))}
      </ul>
      {store ? (
        <button
          type="button"
          onClick={() => onPick({ type: "building", id: store.id })}
          className="mt-4 w-full rounded-lg border border-line px-3 py-2 text-left hover:border-accent/50"
        >
          <span className="text-[0.68rem] tracking-[0.14em] text-muted uppercase">Storehouse · simulated</span>
          <span className="mt-1 flex flex-wrap gap-x-4 text-sm tabular-nums">
            {Object.entries(store.stock).map(([resource, amount]) => (
              <span key={resource}>
                {RESOURCE_LABEL[resource] ?? resource} {amount}
              </span>
            ))}
          </span>
        </button>
      ) : null}
      {sites.length > 0 ? (
        <div className="mt-3">
          <p className="text-[0.68rem] tracking-[0.14em] text-muted uppercase">Construction</p>
          <ul className="mt-1 space-y-2">
            {sites.map((site) => (
              <li key={site.id}>
                <button type="button" onClick={() => onPick({ type: "building", id: site.id })} className="w-full text-left text-sm hover:text-accent">
                  {site.name} · {site.constructionProgress ?? 0}%
                  <Progress value={site.constructionProgress ?? 0} tone="bg-[#f0a020]" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 grid gap-3">
        <label className="text-xs text-muted">
          Find a citizen
          <select
            className="mt-1 block w-full rounded-lg border border-line bg-background px-2 py-2 text-sm text-foreground"
            value=""
            onChange={(event) => event.target.value && onPick({ type: "citizen", tokenId: event.target.value })}
          >
            <option value="">Choose a citizen…</option>
            {sortedCitizens.map((c) => (
              <option key={c.tokenId} value={c.tokenId}>
                {citizenLabel(c)} · {ACTIVITY_LABEL[c.activity]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Go to a place
          <select
            className="mt-1 block w-full rounded-lg border border-line bg-background px-2 py-2 text-sm text-foreground"
            value=""
            onChange={(event) => event.target.value && onPick({ type: "building", id: event.target.value })}
          >
            <option value="">Choose a place…</option>
            {snapshot.buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted">
        Citizens follow fixed simulation rules. The AI mind is not running, and nothing here is a balance, a trade,
        or an onchain action. <Link href="/citizens" className="text-accent">Citizens</Link> ·{" "}
        <Link href="/treasury" className="text-accent">Genesis Treasury</Link> ·{" "}
        <Link href="/activity" className="text-accent">Civilization History</Link>
      </p>
    </div>
  );
}

export function WorldPanel({
  snapshot,
  skewMs,
  selection,
  recent,
  follow,
  onToggleFollow,
  onPick,
}: {
  snapshot: WorldSnapshot;
  skewMs: number;
  selection: Selection;
  recent: readonly WorldEventView[];
  follow: boolean;
  onToggleFollow: () => void;
  onPick: (selection: Selection) => void;
}) {
  const names = useMemo(() => new Map(snapshot.citizens.map((c) => [c.tokenId, c.name])), [snapshot.citizens]);
  const citizenName = (tokenId: string) => names.get(tokenId) ?? null;
  const close = () => onPick(null);
  if (selection?.type === "citizen") {
    const citizen = snapshot.citizens.find((c) => c.tokenId === selection.tokenId);
    if (citizen) {
      return (
        <CitizenInspector
          key={citizen.tokenId}
          citizen={citizen}
          snapshot={snapshot}
          skewMs={skewMs}
          recent={recent}
          citizenName={citizenName}
          onClose={close}
          follow={follow}
          onToggleFollow={onToggleFollow}
        />
      );
    }
    return (
      <div>
        <p className="text-sm text-muted">Citizen #{selection.tokenId} is not in the world.</p>
        <button type="button" onClick={close} className="mt-2 text-sm text-accent">
          Back to overview
        </button>
      </div>
    );
  }
  if (selection?.type === "building") {
    const building = snapshot.buildings.find((b) => b.id === selection.id);
    if (building) {
      return <BuildingInspector key={building.id} building={building} snapshot={snapshot} recent={recent} citizenName={citizenName} onClose={close} />;
    }
  }
  return <WorldOverview snapshot={snapshot} onPick={onPick} />;
}
