import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChogBankPanel } from "@/components/economy/chog-bank-panel";
import { DiscoveredActivityPanel } from "@/components/economy/discovered-activity";
import { WorldEconomyPanel } from "@/components/economy/world-economy";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { loadDiscoveredActivity } from "@/lib/economy/discover-load";
import { loadOwnerlessChogBank } from "@/lib/economy/treasury-load";
import { loadWorld } from "@/lib/world/load";

export const metadata: Metadata = {
  title: "Economy",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function EconomyPage({ searchParams }: { searchParams: Search }) {
  return (
    <div>
      <PageHeader
        title="Economy"
        lede="ChogBank is the ownerless contract for MON and $CHOG. The world economy is the simulated storehouse. The ChogBank address appears only after deployed Monad mainnet code passes the owner, proxy, chain, and asset checks. Until then there is no funding address. A wallet-issuance row is a proposal, and an allocation row is not a payment. Payout execution stays disabled. Discovered $CHOG transfers are chain evidence."
      />
      <div className="space-y-6">
        <Suspense fallback={<p className="text-sm text-muted">Reading ChogBank…</p>}>
          <OwnerlessBankLive />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading the world economy…</p>}>
          <WorldEconomyLive />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading discovered mainnet activity…</p>}>
          <DiscoveredActivityLive searchParams={searchParams} />
        </Suspense>
        <Section title="Known assets" tone="record">
          <p className="mb-4 text-sm leading-6 text-muted">
            Configuration from {recordedCheck.observedOn}. Whole $CHOG supply was{" "}
            {recordedCheck.token.totalSupplyWhole}. That figure is the recorded whole supply of the token.
          </p>
          <ul className="divide-y divide-line border-y border-line text-sm">
            <li className="py-3">MON · native currency · a ChogBank balance appears after the deployed contract passes its checks</li>
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

async function WorldEconomyLive() {
  await connection();
  const world = await loadWorld();
  if (world.status !== "ok") {
    return <WorldEconomyPanel stock={null} townNeeds={[]} townNeedsReady={false} unavailable={world.detail} />;
  }
  const storehouse = world.buildings.find((building) => building.kind === "storehouse");
  return (
    <WorldEconomyPanel
      stock={storehouse?.stock ?? null}
      townNeeds={world.townNeeds}
      townNeedsReady={world.townNeedsReady}
      unavailable={null}
    />
  );
}

async function DiscoveredActivityLive({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const focus = typeof params.tx === "string" ? params.tx : null;
  const activity = params.activity;
  const cursor = typeof activity === "string" ? activity : activity == null ? null : "invalid";
  const view = await loadDiscoveredActivity(cursor);
  return <DiscoveredActivityPanel view={view} focusTx={focus} />;
}
