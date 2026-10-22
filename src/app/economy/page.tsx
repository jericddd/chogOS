import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChogBankPanel } from "@/components/economy/chog-bank-panel";
import { WorldEconomyPanel } from "@/components/economy/world-economy";
import { PageHeader } from "@/components/ui/page-header";
import { loadOwnerlessChogBank } from "@/lib/economy/treasury-load";
import { loadWorld } from "@/lib/world/load";

export const metadata: Metadata = {
  title: "Economy",
};

export default function EconomyPage() {
  return (
    <div>
      <PageHeader
        title="Economy"
        lede="ChogBank is the ownerless contract for MON and $CHOG. The world economy is the simulated storehouse. The ChogBank address appears only after deployed Monad mainnet code passes the owner, proxy, chain, and asset checks. Until then there is no funding address. Once that address is shown, MON and $CHOG are the highlighted balances, and any other token the contract holds is listed under them without the highlight. A wallet row is the decision to create a wallet. An allocation row is the decision to pay a citizen. GitHub Actions broadcasts an accepted MON payment, and Verify links that Monad transaction. This site does not sign."
      />
      <div className="space-y-6">
        <Suspense fallback={<p className="text-sm text-muted">Reading ChogBank…</p>}>
          <OwnerlessBankLive />
        </Suspense>
        <Suspense fallback={<p className="text-sm text-muted">Reading the world economy…</p>}>
          <WorldEconomyLive />
        </Suspense>
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
