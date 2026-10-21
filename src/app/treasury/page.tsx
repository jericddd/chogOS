import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenGallery } from "@/components/citizens/citizen-gallery";
import { CivilizationTreasuryPanel } from "@/components/treasury/civilization-treasury";
import { RecordWallets } from "@/components/treasury/record-wallets";
import { RefreshRoster } from "@/components/treasury/refresh-roster";
import { PageHeader } from "@/components/ui/page-header";
import { formatUtc } from "@/lib/civilization/labels";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";
import { loadCivilizationTreasury } from "@/lib/wallets/load";

export const metadata: Metadata = {
  title: "Genesis Treasury",
};

export default function TreasuryPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Reading the treasury…</p>}>
      <TreasuryLive />
    </Suspense>
  );
}

async function TreasuryLive() {
  await connection();
  const world = await loadWorldSnapshot();
  const treasury = await loadCivilizationTreasury();
  const holdings = world.display.filter(
    (citizen) => world.tokenIds.includes(citizen.tokenId) || citizen.designation.startsWith("Founding"),
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Genesis Treasury"
        lede="These are Chog Genesis NFTs held by the ChogTreasury wallet. They are founding citizen identities, not a $CHOG token balance. The Civilization Treasury below is a different wallet."
      />
      <p className="text-sm leading-6 text-muted">
        <Link href="/economy" className="text-accent">
          ChogBank
        </Link>{" "}
        is the economic contract. It is separate from this NFT roster, and it has no funding address until its code is deployed and checked.
      </p>
      <CivilizationTreasuryPanel view={treasury} action={<RecordWallets locked={world.syncSecretRequired} />} />
      <section className="grid gap-4 md:grid-cols-2">
        <Fact label="Treasury wallet" value={world.treasury} mono />
        <Fact label="Network" value={world.networkLabel} />
        <Fact label="Official collection" value={world.nft} mono />
        <Fact label="Verified NFT count" value={world.countLabel} />
        <Fact
          label="balanceOf"
          value={world.balanceOf === null ? "Not read" : String(world.balanceOf)}
        />
        <Fact
          label="Last chain read"
          value={world.observedAt ? formatUtc(world.observedAt) : "Unavailable"}
        />
        <Fact label="Discovery source" value={world.source ?? "Unavailable"} />
        <Fact label="Last successful synchronization" value={formatUtc(world.lastSyncAt)} />
      </section>
      <p className="text-sm leading-6 text-muted">{world.persistenceLabel}</p>
      {world.discrepancy ? <p className="text-sm leading-6 text-warning">{world.discrepancy}</p> : null}
      {world.liveError ? <p className="text-sm leading-6 text-warning">{world.liveError}</p> : null}
      {world.notice ? <p className="text-sm leading-6 text-muted">{world.notice}</p> : null}
      {world.lastSyncError ? <p className="text-sm leading-6 text-warning">Last sync error: {world.lastSyncError}</p> : null}
      <RefreshRoster locked={world.syncSecretRequired} />
      <section>
        <h2 className="font-serif text-2xl">Verified token ids</h2>
        {world.tokenIds.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-muted">No token ids were verified on this read.</p>
        ) : (
          <p className="mt-2 font-mono text-sm leading-7 break-words text-muted">{world.tokenIds.join(", ")}</p>
        )}
      </section>
      <CitizenGallery citizens={holdings} />
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-4">
      <p className="text-xs tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className={`mt-2 text-sm leading-6 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}
