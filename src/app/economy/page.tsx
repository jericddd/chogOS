import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChogBankPanel } from "@/components/economy/chog-bank-panel";
import { DiscoveredActivityPanel } from "@/components/economy/discovered-activity";
import { EconomicOperationsPanel } from "@/components/economy/operations-panel";
import { CivilizationTreasuryPanel } from "@/components/treasury/civilization-treasury";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { loadDiscoveredActivity } from "@/lib/economy/discover-load";
import { loadEconomicOperations } from "@/lib/economy/load";
import { loadOwnerlessChogBank } from "@/lib/economy/treasury-load";
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
        lede="ChogBank is the ownerless economic contract. Its address appears only after deployed Monad mainnet code passes the owner, proxy, chain, and asset checks. Until then there is no funding address. The operations panel below is a separate observer for an operator-configured address, and it is not this contract. Payout execution stays disabled. Discovered $CHOG transfers are chain evidence, not treasury payouts."
      />
      <div className="space-y-6">
        <Suspense fallback={<p className="text-sm text-muted">Reading ChogBank…</p>}>
          <OwnerlessBankLive />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading the economic treasury…</p>}>
          <EconomicOperationsLive searchParams={searchParams} />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading discovered mainnet activity…</p>}>
          <DiscoveredActivityLive searchParams={searchParams} />
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

async function OwnerlessBankLive() {
  await connection();
  const view = await loadOwnerlessChogBank();
  return <ChogBankPanel view={view} />;
}

async function EconomicOperationsLive({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const focus = typeof params.tx === "string" ? params.tx : null;
  const view = await loadEconomicOperations(focus);
  return <EconomicOperationsPanel view={view} />;
}

async function DiscoveredActivityLive({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const focus = typeof params.tx === "string" ? params.tx : null;
  const activity = params.activity;
  const cursor = typeof activity === "string" ? activity : activity == null ? null : "invalid";
  const view = await loadDiscoveredActivity(cursor);
  return <DiscoveredActivityPanel view={view} focusTx={focus} />;
}

async function CivilizationTreasuryLive() {
  await connection();
  const treasury = await loadCivilizationTreasury();
  return <CivilizationTreasuryPanel view={treasury} />;
}
