import Link from "next/link";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";

export const metadata: Metadata = {
  title: "Economy",
};

export default function EconomyPage() {
  return (
    <div>
      <PageHeader
        title="Economy"
        lede="The shared economic treasury is not deployed and is not funded. ChogTreasury NFT holdings are a separate fact, shown on the Genesis Treasury page. They are not a $CHOG balance."
      />
      <div className="space-y-6">
        <Section title="Shared economic treasury">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs tracking-[0.14em] text-muted uppercase">Wallet</dt>
              <dd className="mt-1">Not deployed</dd>
            </div>
            <div>
              <dt className="text-xs tracking-[0.14em] text-muted uppercase">Funding</dt>
              <dd className="mt-1">No administrator transfer has been recorded</dd>
            </div>
            <div>
              <dt className="text-xs tracking-[0.14em] text-muted uppercase">$CHOG balance</dt>
              <dd className="mt-1">Not read</dd>
            </div>
            <div>
              <dt className="text-xs tracking-[0.14em] text-muted uppercase">AI spending</dt>
              <dd className="mt-1">No permission granted</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm leading-6 text-muted">
            ChogTreasury at <span className="font-mono text-xs break-all">{addresses.chogTreasury}</span> holds
            Chog Genesis NFTs. That wallet is not this economic treasury.{" "}
            <Link href="/treasury" className="text-accent">
              Open the Genesis Treasury
            </Link>
            .
          </p>
        </Section>
        <Section title="Known assets" tone="record">
          <p className="mb-4 text-sm leading-6 text-muted">
            Configuration from {recordedCheck.observedOn}. Whole $CHOG supply was{" "}
            {recordedCheck.token.totalSupplyWhole}. That supply is not a civilization holding.
          </p>
          <ul className="divide-y divide-line border-y border-line text-sm">
            <li className="py-3">MON · native currency · balance not read</li>
            <li className="py-3 font-mono text-xs break-all">$CHOG · {addresses.chogToken}</li>
            <li className="py-3 font-mono text-xs break-all">Chog Genesis NFT · {addresses.chogGenesis}</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
