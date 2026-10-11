import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";

export const metadata: Metadata = {
  title: "Economy",
};

const rows = [
  {
    asset: "MON",
    address: "Native currency",
    note: "Chain currency. Balance not read.",
  },
  {
    asset: "CHOG",
    address: addresses.chogToken,
    note: `Observed token. Whole supply ${recordedCheck.token.totalSupplyWhole}. Not a treasury holding.`,
  },
  {
    asset: "Chog Genesis",
    address: addresses.chogGenesis,
    note: `ERC-721 collection of ${recordedCheck.nft.totalSupply}. Not a balance.`,
  },
];

export default function EconomyPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Economy and treasury"
        lede="The shared treasury will be a separate smart wallet from citizen wallets. It has not been deployed, and the administrator has not funded it. No balance on this page comes from Monad."
      />
      <div className="space-y-6">
        <Section title="Shared treasury">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Wallet</dt>
              <dd className="mt-1">Not deployed</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Funding</dt>
              <dd className="mt-1">Waiting for a manual administrator transfer</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Balance</dt>
              <dd className="mt-1">Not read from chain</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">AI spending</dt>
              <dd className="mt-1">No permission granted</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm leading-6 text-muted">
            Chog Genesis treasury() returns {addresses.chogGenesisMintTreasury}. That address is the
            collection mint receiver. It is not this civilization&apos;s treasury, and this dashboard does
            not display its balance.
          </p>
        </Section>

        <Section title="Known assets" tone="record">
          <p className="mb-4 text-sm leading-6 text-muted">
            These are configuration records from {recordedCheck.observedOn}. They are not holdings.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <caption className="sr-only">Known Monad assets without balances</caption>
              <thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Asset</th>
                  <th className="py-2 pr-4 font-medium">Address</th>
                  <th className="py-2 font-medium">What this row means</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.asset} className="border-b border-line align-top">
                    <td className="py-3 pr-4 font-medium">{row.asset}</td>
                    <td className="py-3 pr-4 font-mono text-xs break-all">{row.address}</td>
                    <td className="py-3 text-muted">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  );
}
