import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { AiDecisionsLink } from "@/components/world/ai-decisions-link";
import { HistoryFeed } from "@/components/world/history-feed";
import { formatUtc } from "@/lib/civilization/labels";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";
import { loadWorld, realtimeConfig } from "@/lib/world/load";
import { eventFilterFromSearch } from "@/lib/world/sync";

export const metadata: Metadata = {
  title: "History",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function ActivityPage({ searchParams }: { searchParams: Search }) {
  return (
    <div>
      <PageHeader
        title="Civilization History"
        lede="This feed lists actual recorded world events, newest first. Simulation rows are rule-based world transitions. System rows are setup and synchronization, including each Chog Genesis NFT that joined this civilization. AI rows are decisions recorded by the mind, and each one shows the stored reason. A wallet, fund, trade, or return row links to Monadscan when a receipt, citizen wallet, factory, or Genesis token was stored. A join row links the Genesis token, the observed owner, and the block from that ownerOf read. Genesis transfer links stay on watcher rows. A database status alone is not a chain receipt."
      />
      <p className="-mt-2 mb-6">
        <AiDecisionsLink />
      </p>
      <Suspense fallback={<p className="text-sm text-muted">Reading history…</p>}>
        <ActivityLive searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ActivityLive({ searchParams }: { searchParams: Search }) {
  await connection();
  const params = await searchParams;
  const filter = eventFilterFromSearch(params);

  const world = await loadWorld();
  if (world.status === "migration_pending" || world.status === "unconfigured") {
    return <LegacyHistory note={world.detail} />;
  }
  return <HistoryFeed initial={world} realtime={realtimeConfig()} filter={filter} />;
}

async function LegacyHistory({ note }: { note: string }) {
  const world = await loadWorldSnapshot();
  return (
    <div>
      <p className="mb-4 text-sm leading-6 text-muted">{note} Membership events recorded before the world existed are listed below.</p>
      {world.events.length === 0 ? (
        <p className="text-sm leading-6 text-muted">No civilization events recorded. {world.persistenceLabel}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {world.events.map((event) => (
            <li key={event.id} className="py-4">
              <p>{event.summary}</p>
              <p className="mt-1 text-sm text-muted">
                {formatUtc(event.occurredAt)} · {event.kind} · {event.chainStatus}
                {event.tokenId ? ` · token ${event.tokenId}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
