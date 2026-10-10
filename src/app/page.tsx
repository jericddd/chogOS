import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { WorldStage } from "@/components/world/world-stage";
import { formatUtc } from "@/lib/civilization/labels";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";

export default function OverviewPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Reading Monad…</p>}>
      <WorldHome />
    </Suspense>
  );
}

async function WorldHome() {
  await connection();
  const world = await loadWorldSnapshot();
  const recent = world.events.slice(0, 5);

  return (
    <div className="space-y-8">
      <header className="max-w-3xl">
        <p className="text-xs tracking-[0.18em] text-accent uppercase">Genesis founded</p>
        <h1 className="mt-2 font-serif text-5xl tracking-tight">One civilization, still waking.</h1>
        <p className="mt-4 text-base leading-7 text-muted">
          chogOS is a single shared world on Monad. One Chog Genesis NFT is one citizen, and every citizen
          belongs to this same civilization. The founding population is the NFTs held by the ChogTreasury
          wallet, verified on the collection contract. Neighbors can enroll NFTs they personally own. The AI
          mind is not running. Nothing here is a balance, a trade, or a simulated decision.
        </p>
      </header>

      <WorldStage
        foundingCount={world.treasuryCount}
        communityCount={world.communityRecords}
        treasuryCount={world.treasuryCount}
        networkLabel={world.networkLabel}
        syncLabel={
          world.lastSyncAt ? `Synchronized ${formatUtc(world.lastSyncAt)}` : "No successful synchronization yet"
        }
        aiLabel={world.aiLabel}
        persistenceLabel={world.persistenceLabel}
        discrepancy={world.discrepancy}
        countLabel={world.countLabel}
      />

      <section className="grid gap-4 md:grid-cols-3">
        <Count
          label="Treasury NFTs"
          value={world.treasuryCount === null ? "Unavailable" : String(world.treasuryCount)}
          detail="Chog Genesis tokens verified in the ChogTreasury wallet. Not a $CHOG balance."
        />
        <Count
          label="Founding records"
          value={world.foundingRecords === null ? "Not persisted" : String(world.foundingRecords)}
          detail="Active founding memberships stored for this civilization. The same NFTs are not counted twice."
        />
        <Count
          label="Community citizens"
          value={world.communityRecords === null ? "Not persisted" : String(world.communityRecords)}
          detail="Owners who enrolled their own Chog Genesis NFTs. Citizens registered, not an online-user count."
        />
      </section>

      {world.liveError ? <p className="text-sm leading-6 text-warning">{world.liveError}</p> : null}
      {world.notice ? <p className="text-sm leading-6 text-muted">{world.notice}</p> : null}

      <section className="rounded-2xl border border-line bg-card px-5 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-2xl">Recent verified events</h2>
          <Link href="/activity" className="text-sm text-accent">
            Civilization History
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-muted">
            No civilization events recorded. A genesis synchronization writes the first events after the
            database is configured. Empty history is not filled with samples.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {recent.map((event) => (
              <li key={event.id} className="py-3">
                <p>{event.summary}</p>
                <p className="mt-1 text-xs text-muted">
                  {formatUtc(event.occurredAt)} · {event.kind}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Count({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-4">
      <p className="text-xs tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className="mt-2 font-serif text-3xl tracking-tight">{value}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{detail}</p>
    </div>
  );
}
