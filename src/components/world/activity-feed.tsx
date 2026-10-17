"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AiDecisionsLink } from "@/components/world/ai-decisions-link";
import { EventItem } from "@/components/world/event-item";
import { useLive, type LiveStore } from "@/components/world/live-store";
import { useNow } from "@/components/world/use-now";
import { CATEGORY_LABEL, SOURCE_LABEL } from "@/lib/world/present";
import {
  eventFilterSearchParams,
  filterKey,
  matchesFilter,
  oldestSeq,
  receiveLive,
  resolveEventFilter,
  revealPending,
  type FeedState,
} from "@/lib/world/sync";
import {
  EVENT_CATEGORIES,
  EVENT_SOURCES,
  type EventCategory,
  type EventFilter,
  type EventPage,
  type EventSource,
} from "@/lib/world/types";

const PAGE_SIZE = 25;

function pageUrl(filter: EventFilter, before: number | null): string {
  const params = eventFilterSearchParams(resolveEventFilter(filter));
  params.set("limit", String(PAGE_SIZE));
  if (before !== null) params.set("before", String(before));
  return `/api/world/events?${params.toString()}`;
}

function historyHref(pathname: string, filter: EventFilter): string {
  const query = eventFilterSearchParams(filter).toString();
  return query ? `${pathname}?${query}` : pathname;
}

async function fetchPage(filter: EventFilter, before: number | null): Promise<EventPage> {
  const response = await fetch(pageUrl(filter, before), { cache: "no-store" });
  return (await response.json()) as EventPage;
}

function isEmptyFilter(filter: EventFilter): boolean {
  return !filter.category && !filter.source && !filter.tokenId && !filter.buildingId;
}

function emptyText(filter: EventFilter): string {
  if (filter.source === "ai" || filter.category === "ai") {
    return "No AI events. Only genuine model-backed decisions are labeled AI. Rule-based activity stays simulation.";
  }
  if (filter.source === "onchain" || filter.category === "onchain") {
    return "No onchain events. Only activity verified against Monad is labeled onchain, and the world makes no transactions.";
  }
  if (!isEmptyFilter(filter)) {
    return "Nothing matches this filter yet.";
  }
  return "No activity recorded yet. Events appear as the shared simulation runs. History is never filled with samples.";
}

export function ActivityFeed({
  store,
  initialFilter = {},
  mode = "home",
}: {
  store: LiveStore;
  initialFilter?: EventFilter;
  mode?: "home" | "page";
}) {
  const live = useLive(store);
  const now = useNow(15_000);
  const router = useRouter();
  const pathname = usePathname();
  const [filter, setFilter] = useState<EventFilter>(initialFilter);
  const initialKey = filterKey(initialFilter);
  const initialFilterRef = useRef(initialFilter);
  const startsWithRecent = isEmptyFilter(initialFilter) && live.recent.length > 0;
  const [feed, setFeed] = useState<FeedState>(() => ({
    shown: startsWithRecent ? live.recent.filter((event) => matchesFilter(event, initialFilter)) : [],
    pending: [],
  }));
  const [nextBefore, setNextBefore] = useState<number | null>(() => (startsWithRecent ? oldestSeq(live.recent) : null));
  const [status, setStatus] = useState<"ready" | "loading" | "error" | "unavailable">(startsWithRecent ? "ready" : "loading");
  const [detail, setDetail] = useState("");
  const [older, setOlder] = useState<"idle" | "loading" | "error">("idle");
  const filterRef = useRef(filter);
  const atTop = useRef(true);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const names = useMemo(
    () => new Map((live.snapshot?.citizens ?? []).map((c) => [c.tokenId, c.name])),
    [live.snapshot?.citizens],
  );
  const citizenName = (tokenId: string) => names.get(tokenId) ?? null;

  const reload = (next: EventFilter) => {
    const id = ++request.current;
    setStatus("loading");
    fetchPage(next, null)
      .then((page) => {
        if (id !== request.current) {
          return;
        }
        if (page.status !== "ok") {
          setDetail(page.detail);
          setStatus(page.status === "error" ? "error" : "unavailable");
          return;
        }
        setFeed({ shown: page.events, pending: [] });
        setNextBefore(page.nextBefore);
        setStatus("ready");
      })
      .catch(() => {
        if (id === request.current) {
          setStatus("error");
        }
      });
  };

  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
    initialFilterRef.current = initialFilter;
  });

  useEffect(() => {
    if (!startsWithRecent) {
      reloadRef.current(filterRef.current);
    }
    // Initial load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialKey === filterKey(filterRef.current)) {
      return;
    }
    const next = initialFilterRef.current;
    filterRef.current = next;
    setFilter(next);
    setOlder("idle");
    reloadRef.current(next);
  }, [initialKey]);

  useEffect(() => {
    let reset = store.getState().resetToken;
    return store.subscribe(() => {
      const state = store.getState();
      if (state.resetToken !== reset) {
        reset = state.resetToken;
        reloadRef.current(filterRef.current);
        return;
      }
      setFeed((current) => receiveLive(current, state.recent, filterRef.current, atTop.current));
    });
  }, [store]);

  useEffect(() => {
    const top = topRef.current;
    if (!top) {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      atTop.current = Boolean(entry?.isIntersecting);
      if (atTop.current) {
        setFeed((current) => revealPending(current));
      }
    });
    observer.observe(top);
    return () => observer.disconnect();
  }, []);

  const loadOlder = () => {
    if (nextBefore === null || older === "loading") {
      return;
    }
    setOlder("loading");
    const key = filterKey(filterRef.current);
    fetchPage(filterRef.current, nextBefore)
      .then((page) => {
        if (key !== filterKey(filterRef.current)) {
          return;
        }
        if (page.status !== "ok") {
          setOlder("error");
          return;
        }
        setFeed((current) => {
          const known = new Set(current.shown.map((event) => event.id));
          return { ...current, shown: [...current.shown, ...page.events.filter((event) => !known.has(event.id))] };
        });
        setNextBefore(page.nextBefore);
        setOlder("idle");
      })
      .catch(() => setOlder("error"));
  };

  const loadOlderRef = useRef(loadOlder);
  useEffect(() => {
    loadOlderRef.current = loadOlder;
  });

  useEffect(() => {
    const bottom = bottomRef.current;
    if (!bottom || mode !== "page") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        loadOlderRef.current();
      }
    }, { rootMargin: "400px" });
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [mode]);

  const changeFilter = (patch: Partial<EventFilter>) => {
    const next = { ...filterRef.current, ...patch };
    for (const key of Object.keys(next) as Array<keyof EventFilter>) {
      if (!next[key]) {
        delete next[key];
      }
    }
    filterRef.current = next;
    setFilter(next);
    setOlder("idle");
    reload(next);
    if (mode === "page") {
      router.replace(historyHref(pathname, next), { scroll: false });
    }
  };

  const showPending = () => {
    setFeed((current) => revealPending(current));
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scoped = filter.tokenId
    ? `Citizen #${filter.tokenId}`
    : filter.buildingId
      ? (live.snapshot?.buildings.find((b) => b.id === filter.buildingId)?.name ?? filter.buildingId)
      : null;

  return (
    <section aria-labelledby="activity-title" className="rounded-2xl border border-line bg-card px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="activity-title" className="font-serif text-2xl tracking-tight">
            Civilization Activity
          </h2>
          <p className="mt-1 text-sm text-muted">
            Newest first. Every row is a recorded world event, labeled by where it came from.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AiDecisionsLink />
          <label className="text-xs text-muted">
            <span className="sr-only">Category</span>
            <select
              value={filter.category ?? ""}
              onChange={(event) => changeFilter({ category: (event.target.value || undefined) as EventCategory | undefined })}
              className="rounded-lg border border-line bg-background px-2 py-1.5 text-sm text-foreground"
            >
              <option value="">All activity</option>
              {EVENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABEL[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="sr-only">Source</span>
            <select
              value={filter.source ?? ""}
              onChange={(event) => changeFilter({ source: (event.target.value || undefined) as EventSource | undefined })}
              className="rounded-lg border border-line bg-background px-2 py-1.5 text-sm text-foreground"
            >
              <option value="">All sources</option>
              {EVENT_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABEL[source]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {scoped ? (
        <p className="mt-3 text-sm">
          Showing {scoped}.{" "}
          <button type="button" className="text-accent" onClick={() => changeFilter({ tokenId: undefined, buildingId: undefined })}>
            Show everything
          </button>
        </p>
      ) : null}

      <div ref={topRef} aria-hidden className="h-px scroll-mt-24" />
      <div className="sticky top-2 z-10 flex justify-center">
        {feed.pending.length > 0 ? (
          <button
            type="button"
            onClick={showPending}
            className="mt-2 rounded-full border border-accent/50 bg-background/95 px-4 py-1.5 text-sm text-accent shadow-lg"
          >
            ↑ New activity · {feed.pending.length}
          </button>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {feed.pending.length > 0 ? `${feed.pending.length} new events` : ""}
      </p>

      {status === "loading" && feed.shown.length === 0 ? <p className="mt-4 text-sm text-muted">Reading history…</p> : null}
      {status === "error" ? (
        <p className="mt-4 text-sm text-warning">
          History could not be read.{" "}
          <button type="button" className="text-accent" onClick={() => reload(filterRef.current)}>
            Try again
          </button>
        </p>
      ) : null}
      {status === "unavailable" ? <p className="mt-4 text-sm leading-6 text-muted">{detail} Recorded history appears here once it can be read.</p> : null}
      {status === "ready" && feed.shown.length === 0 ? <p className="mt-4 text-sm leading-6 text-muted">{emptyText(filter)}</p> : null}

      <ul className={`mt-3 divide-y divide-line border-y border-line ${feed.shown.length === 0 ? "hidden" : ""}`}>
        {feed.shown.map((event) => (
          <EventItem key={event.id} event={event} now={now} citizenName={citizenName} />
        ))}
      </ul>

      <div ref={bottomRef} className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {nextBefore !== null && feed.shown.length > 0 ? (
          <button
            type="button"
            onClick={loadOlder}
            disabled={older === "loading"}
            className="rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-60"
          >
            {older === "loading" ? "Loading…" : older === "error" ? "Could not load. Try again" : "Load older activity"}
          </button>
        ) : feed.shown.length > 0 ? (
          <p className="text-sm text-muted">This is the beginning of recorded history.</p>
        ) : (
          <span />
        )}
        {mode === "home" ? (
          <Link href="/activity" className="text-sm text-accent">
            Open full history
          </Link>
        ) : null}
      </div>
    </section>
  );
}
