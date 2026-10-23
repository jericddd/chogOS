"use client";

import Link from "next/link";
import { formatEventWhen, formatWorldTime } from "@/lib/world/clock";
import { CATEGORY_LABEL, SOURCE_DESCRIPTION, SOURCE_LABEL, eventSegments } from "@/lib/world/present";
import { presentedAsMainnetGenesis, transferPresentationIssues } from "@/lib/world/transfer";
import type { ClockView, EventSource, WorldEventView } from "@/lib/world/types";

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

function unnamedCitizen(): null {
  return null;
}

export function EventItem({
  event,
  now,
  citizenName = unnamedCitizen,
  compact = false,
  clock = null,
}: {
  event: WorldEventView;
  now: number;
  /** Optional. A server page must omit this; a function cannot cross into this client component. */
  citizenName?: (tokenId: string) => string | null;
  compact?: boolean;
  /** Projects a world day when the event has no stored world second. */
  clock?: ClockView | null;
}) {
  const segments = eventSegments(event, citizenName);
  const when = formatEventWhen(event.occurredAt, now, event.worldS, clock);
  const storedWorld = event.worldS !== null ? formatWorldTime(event.worldS) : null;
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
          {event.source === "ai" && (event.mind?.rationale || event.mind?.summary) ? (
            <p className={`mt-1 text-sm leading-6 text-foreground/90 ${compact ? "line-clamp-3" : ""}`}>
              <span className="text-muted">Reason. </span>
              {event.mind.rationale ?? event.mind.summary}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted">
            {storedWorld && storedWorld !== when ? <span>{storedWorld} · </span> : null}
            <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toUTCString()}>
              {when}
            </time>
            {compact ? null : <span> · {CATEGORY_LABEL[event.category]}</span>}
            {event.txUrl && event.txHash && (!event.transfer || presentedAsMainnetGenesis(event.transfer)) ? (
              <a href={event.txUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
                {" · "}
                {event.txHash.slice(0, 10)}…
              </a>
            ) : null}
            {" "}
            ·{" "}
            <Link href={`/verify/events/${event.id}`} className="text-accent hover:underline">
              Verify
            </Link>
          </p>
          <TransferLinks event={event} />
          <OnchainLinks event={event} />
        </div>
      </div>
    </li>
  );
}

function OnchainLinks({ event }: { event: WorldEventView }) {
  const links = event.onchain?.links ?? [];
  if (links.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      {links.map((link) => (
        <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" title={link.href}>
          {link.label}
        </a>
      ))}
    </p>
  );
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function TransferLinks({ event }: { event: WorldEventView }) {
  const transfer = event.transfer;
  if (!transfer) {
    return null;
  }
  if (!presentedAsMainnetGenesis(transfer)) {
    const reason = transferPresentationIssues(transfer)[0] ?? "This transfer is not a complete Chog Genesis mainnet log.";
    return (
      <p className="mt-1 text-xs leading-5 text-muted">
        {reason} Explorer links are withheld.
      </p>
    );
  }
  const links = [
    transfer.links.block && transfer.blockNumber
      ? { href: transfer.links.block, label: `Block ${transfer.blockNumber}` }
      : null,
    transfer.links.from && transfer.from ? { href: transfer.links.from, label: `From ${shortAddress(transfer.from)}` } : null,
    transfer.links.to && transfer.to ? { href: transfer.links.to, label: `To ${shortAddress(transfer.to)}` } : null,
    transfer.links.token && transfer.tokenId ? { href: transfer.links.token, label: `Token ${transfer.tokenId}` } : null,
    transfer.links.contract ? { href: transfer.links.contract, label: "Contract" } : null,
  ].filter((link): link is { href: string; label: string } => Boolean(link));
  if (links.length === 0 && transfer.chainId == null) {
    return null;
  }
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      <span>Chain {transfer.chainId ?? "—"}</span>
      {transfer.txIndex ? <span>Tx index {transfer.txIndex}</span> : null}
      {transfer.logIndex ? <span>Log {transfer.logIndex}</span> : null}
      {links.map((link) => (
        <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" title={link.href}>
          {link.label}
        </a>
      ))}
    </p>
  );
}
