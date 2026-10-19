"use client";

import Link from "next/link";
import { formatRealAgo, formatWorldTime } from "@/lib/world/clock";
import { CATEGORY_LABEL, SOURCE_DESCRIPTION, SOURCE_LABEL, eventSegments } from "@/lib/world/present";
import type { EventSource, WorldEventView } from "@/lib/world/types";

const SOURCE_TONE: Record<EventSource, string> = {
  simulation: "border-accent/40 text-accent",
  ai: "border-violet/50 text-violet",
  onchain: "border-sky-400/50 text-sky-300",
  system: "border-line text-muted",
};

export function SourceBadge({ source }: { source: EventSource }) {
  return (
    <span
      title={SOURCE_DESCRIPTION[source]}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[0.65rem] font-medium tracking-[0.12em] uppercase ${SOURCE_TONE[source]}`}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

export function EventItem({
  event,
  now,
  citizenName,
  compact = false,
}: {
  event: WorldEventView;
  now: number;
  citizenName: (tokenId: string) => string | null;
  compact?: boolean;
}) {
  const segments = eventSegments(event, citizenName);
  return (
    <li className={compact ? "py-2" : "py-3"} data-seq={event.seq}>
      <div className="flex items-start gap-3">
        <SourceBadge source={event.source} />
        <div className="min-w-0 flex-1">
          <p className={compact ? "text-sm leading-5" : "leading-6"}>
            {segments.map((segment, index) =>
              segment.href ? (
                <Link
                  key={index}
                  href={segment.href}
                  scroll={false}
                  className={segment.entity === "citizen" ? "text-accent hover:underline" : "text-violet hover:underline"}
                >
                  {segment.text}
                </Link>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>
          <p className="mt-1 text-xs text-muted">
            {event.worldS !== null ? <span>{formatWorldTime(event.worldS)} · </span> : null}
            <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toUTCString()}>
              {now > 0 ? formatRealAgo(event.occurredAt, now) : event.occurredAt.slice(0, 16).replace("T", " ") + " UTC"}
            </time>
            {compact ? null : <span> · {CATEGORY_LABEL[event.category]}</span>}
            {event.chainStatus === "confirmed" && event.txHash ? (
              event.txUrl ? (
                <a href={event.txUrl} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                  {" · "}
                  {event.txHash.slice(0, 10)}…
                </a>
              ) : (
                <span className="font-mono"> · {event.txHash.slice(0, 10)}…</span>
              )
            ) : null}
            {" "}
            ·{" "}
            <Link href={`/verify/events/${event.id}`} className="text-accent hover:underline">
              Verify
            </Link>
          </p>
        </div>
      </div>
    </li>
  );
}
