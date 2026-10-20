"use client";

import { useEffect, useState } from "react";
import { EventItem } from "@/components/world/event-item";
import { useNow } from "@/components/world/use-now";
import type { EventPage, WorldEventView } from "@/lib/world/types";

/**
 * Real AI construction already stored in history, including the model's own
 * reason when the event points at a decision. Does not invent a row.
 */
export function GrowthDecisions() {
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

  return (
    <section aria-labelledby="growth-title" className="rounded-2xl border border-violet/40 bg-card px-4 py-5 sm:px-5">
      <h2 id="growth-title" className="font-serif text-2xl tracking-tight">
        How the town is growing
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        These are recorded AI construction events. The sentence under a row is the mind&apos;s own reason, when that
        decision was stored. Sleep, work, and visits stay on the simulation below.
      </p>
      {events === null ? <p className="mt-4 text-sm text-muted">Reading growth decisions…</p> : null}
      {events && events.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          {detail || "No AI construction is recorded yet. A growth decision appears here after the mind places a road or a building."}
        </p>
      ) : null}
      {events && events.length > 0 ? (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {events.map((event) => (
            <EventItem key={event.id} event={event} now={now} citizenName={() => null} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
