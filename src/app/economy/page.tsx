import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { EconomicOperationsPanel } from "@/components/economy/operations-panel";
import { CivilizationTreasuryPanel } from "@/components/treasury/civilization-treasury";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { loadEconomicOperations } from "@/lib/economy/load";
import { loadCivilizationTreasury } from "@/lib/wallets/load";

export const metadata: Metadata = {
  title: "Economy",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function EconomyPage({ searchParams }: { searchParams: Search }) {
  return (
    <div>
      <PageHeader
        title="Economy"
        lede="The economic treasury is an operator-configured public address on Monad mainnet. The Civilization Treasury record and the ChogTreasury NFT wallet are different addresses. Execution is disabled. A stored hash is not a fresh mainnet verification, and opening this page does not settle a proposal."
      />
      <div className="space-y-6">
        <Suspense fallback={<p className="text-sm text-muted">Reading the economic treasury…</p>}>
          <EconomicOperationsLive searchParams={searchParams} />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading the civilization treasury…</p>}>
          <CivilizationTreasuryLive />
        </Suspense>
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
            <li className="py-3">MON · native currency · an economic balance is shown only after a live read of the configured treasury</li>
            <li className="py-3 font-mono text-xs break-all">$CHOG · {addresses.chogToken}</li>
            <li className="py-3 font-mono text-xs break-all">Chog Genesis NFT · {addresses.chogGenesis}</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

async function EconomicOperationsLive({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const focus = typeof params.tx === "string" ? params.tx : null;
  const view = await loadEconomicOperations(focus);
  return <EconomicOperationsPanel view={view} />;
}

async function CivilizationTreasuryLive() {
  await connection();
  const treasury = await loadCivilizationTreasury();
  return <CivilizationTreasuryPanel view={treasury} />;
}
