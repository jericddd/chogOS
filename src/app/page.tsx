import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { Section } from "@/components/ui/section";
import { addresses } from "@/lib/blockchain/addresses";
import { evidenceLabel, recordedCheck, recordedContracts } from "@/lib/blockchain/recorded-check";
import { sampleCitizens } from "@/lib/placeholder/data";

const facts = [
  { label: "Citizens enrolled", value: "0", detail: "Enrollment is not open." },
  { label: "Treasury wallet", value: "Not deployed", detail: "No shared treasury address exists yet." },
  { label: "Balances shown", value: "None", detail: "This screen does not read wallet balances." },
  { label: "AI execution", value: "Disabled", detail: "The AI has no signer and no spending tools." },
];

export default function OverviewPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Overview"
        lede="One civilization for participating Chog Genesis citizens. This installation is the Phase 0 shell: the structure is here, nobody is enrolled, and nothing on this screen can move assets."
      />
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="rounded-lg border border-line bg-card px-4 py-4">
              <p className="text-xs uppercase tracking-[0.14em] text-muted">{fact.label}</p>
              <p className="mt-2 font-serif text-3xl tracking-tight">{fact.value}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{fact.detail}</p>
            </div>
          ))}
        </section>

        <Section title="Recorded contracts" tone="record">
          <p className="mb-4 text-sm leading-6 text-muted">
            Checked on {recordedCheck.observedOn} against {recordedCheck.mainnetRpc} (chain{" "}
            {recordedCheck.mainnetChainId}) and {recordedCheck.testnetRpc} (chain{" "}
            {recordedCheck.testnetChainId}). Chog Genesis reported {recordedCheck.nft.totalSupply} of{" "}
            {recordedCheck.nft.maxSupply} minted. $CHOG reported a whole-token supply of{" "}
            {recordedCheck.token.totalSupplyWhole}. Neither figure is a civilization holding.
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {recordedContracts.map((contract) => (
              <li key={contract.address} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{contract.name}</p>
                  <p className="text-xs uppercase tracking-[0.12em] text-muted">
                    {evidenceLabel[contract.level]}
                  </p>
                </div>
                <p className="mt-1 font-mono text-xs break-all text-muted">{contract.address}</p>
                <p className="mt-2 text-sm leading-6 text-muted">{contract.detail}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-6 text-muted">
            The mint receiver at{" "}
            <span className="font-mono text-xs break-all">{addresses.chogGenesisMintTreasury}</span> belongs
            to the NFT contract. The civilization treasury is a separate wallet and has not been deployed.
          </p>
        </Section>

        <Section title="Sample citizens" tone="placeholder">
          <PlaceholderNotice />
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {sampleCitizens.map((citizen) => (
              <li key={citizen.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <p className="font-medium">{citizen.label}</p>
                <p className="text-sm text-muted">
                  {citizen.wallet} · {citizen.wealth}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
