import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { HistoryFeed } from "@/components/world/history-feed";
import { formatUtc } from "@/lib/civilization/labels";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";
import { loadWorld, realtimeConfig } from "@/lib/world/load";
import type { EventFilter } from "@/lib/world/types";

export const metadata: Metadata = {
  title: "History",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function ActivityPage({ searchParams }: { searchParams: Search }) {
  return (
    <div>
      <PageHeader
        title="Civilization History"
        lede="Everything the civilization has recorded, newest first. Simulation rows are rule-based world transitions. System rows are setup and synchronization. AI and onchain labels are reserved for real AI decisions and activity verified on Monad, and none are shown until they exist."
      />
      <Suspense fallback={<p className="text-sm text-muted">Reading history…</p>}>
        <ActivityLive searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function ActivityLive({ searchParams }: { searchParams: Search }) {
  await connection();
  const params = await searchParams;
  const filter: EventFilter = {};
  const citizen = one(params.citizen);
  const building = one(params.building);
  if (citizen && /^[0-9]{1,78}$/.test(citizen)) {
    filter.tokenId = citizen;
  }
  if (building && /^[a-z0-9-]{2,40}$/.test(building)) {
    filter.buildingId = building;
  }

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
