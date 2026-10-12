import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CivilizationTreasuryPanel } from "@/components/treasury/civilization-treasury";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { loadCivilizationTreasury } from "@/lib/wallets/load";

export const metadata: Metadata = {
  title: "Economy",
};

export default function EconomyPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Reading the civilization treasury…</p>}>
      <EconomyLive />
    </Suspense>
  );
}

async function EconomyLive() {
  await connection();
  const treasury = await loadCivilizationTreasury();
  return (
    <div>
      <PageHeader
        title="Economy"
        lede="The shared Civilization Treasury is separate from the ChogTreasury NFT wallet. Balances appear only after an address is configured and a chain read succeeds. The AI cannot spend."
      />
      <div className="space-y-6">
        <CivilizationTreasuryPanel view={treasury} />
        <p className="text-sm leading-6 text-muted">
          <Link href="/treasury" className="text-accent">
            Open the Genesis Treasury
          </Link>{" "}
          for the founding NFT roster. AI spending stays closed.
        </p>
        <Section title="Known assets" tone="record">
          <p className="mb-4 text-sm leading-6 text-muted">
            Configuration from {recordedCheck.observedOn}. Whole $CHOG supply was{" "}
            {recordedCheck.token.totalSupplyWhole}. That supply is not a civilization holding.
          </p>
          <ul className="divide-y divide-line border-y border-line text-sm">
            <li className="py-3">MON · native currency · civilization balance is shown above only after a live read</li>
            <li className="py-3 font-mono text-xs break-all">$CHOG · {addresses.chogToken}</li>
            <li className="py-3 font-mono text-xs break-all">Chog Genesis NFT · {addresses.chogGenesis}</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
