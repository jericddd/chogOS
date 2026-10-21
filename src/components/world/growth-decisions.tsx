"use client";

import { useEffect, useState } from "react";
import { EventItem } from "@/components/world/event-item";
import { useNow } from "@/components/world/use-now";
import type { EventPage, WorldEventView } from "@/lib/world/types";

/**
 * Real AI construction already stored in history, including the model's own
 * reason when the event points at a decision. Does not invent a row.
 */
export function GrowthDecisions({ dock = false, inactive = false }: { dock?: boolean; inactive?: boolean }) {
  const now = useNow(15_000);
  const [events, setEvents] = useState<WorldEventView[] | null>(null);
  const [detail, setDetail] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/world/events?source=ai&category=construction&limit=5", { cache: "no-store" })
      .then(async (response) => (await response.json()) as EventPage)
      .then((page) => {
        if (cancelled) {
          return;
        }
        if (page.status !== "ok") {
          setDetail(page.detail);
          setEvents([]);
          return;
        }
        setEvents(page.events);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail("Growth decisions could not be read.");
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const empty =
    detail ||
    (dock
      ? "No AI construction is recorded yet."
      : "No AI construction is recorded yet. A growth decision appears here after the mind places a road or a building.");

  return (
    <section
      aria-labelledby="growth-title"
      className={dock ? `world-growth pixel-panel${inactive ? " is-inactive" : ""}` : "rounded-2xl border border-violet/40 bg-card px-4 py-5 sm:px-5"}
    >
      <div className={dock ? "shrink-0 border-b-4 border-line px-2.5 py-2" : undefined}>
        <h2 id="growth-title" className={dock ? "font-display text-[0.62rem] leading-4 text-violet" : "font-serif text-2xl tracking-tight"}>
          {dock ? "Town growth" : "How the town is growing"}
        </h2>
        {dock ? null : (
          <p className="mt-1 text-sm leading-6 text-muted">
            These are recorded AI construction events. The sentence under a row is the mind&apos;s own reason, when that
            decision was stored. Sleep, work, and visits stay on the simulation below.
          </p>
        )}
      </div>
      <div className={dock ? "world-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5" : undefined}>
        {events === null ? <p className="py-3 text-sm text-muted">Reading growth decisions…</p> : null}
        {events && events.length === 0 ? <p className="py-3 text-sm leading-6 text-muted">{empty}</p> : null}
        {events && events.length > 0 ? (
          <ul className={dock ? "divide-y divide-line" : "mt-3 divide-y divide-line border-y border-line"}>
            {events.map((event) => (
              <EventItem key={event.id} event={event} now={now} citizenName={() => null} compact={dock} />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
