import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { formatUtc } from "@/lib/civilization/labels";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";

export const metadata: Metadata = {
  title: "History",
};

export default function ActivityPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Reading history…</p>}>
      <ActivityLive />
    </Suspense>
  );
}

async function ActivityLive() {
  await connection();
  const world = await loadWorldSnapshot();

  return (
    <div>
      <PageHeader
        title="Civilization History"
        lede="Only events written by treasury synchronization or enrollment are shown. Future AI decisions, businesses, and Monad receipts can use this same feed. None of those are fabricated here."
      />
      {world.events.length === 0 ? (
        <p className="text-sm leading-6 text-muted">
          No civilization events recorded. {world.persistenceLabel}
        </p>
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
