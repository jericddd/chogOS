import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { Section } from "@/components/ui/section";
import { sampleCitizens } from "@/lib/placeholder/data";

export const metadata: Metadata = {
  title: "Citizens",
};

export default function CitizensPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Citizens"
        lede="One eligible Chog Genesis token id will be one citizen of this same civilization. No token is enrolled, and no citizen wallet has been deployed."
      />
      <div className="space-y-6">
        <Section title="Enrollment">
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Status</dt>
              <dd className="mt-1 text-lg">Closed</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Records</dt>
              <dd className="mt-1 text-lg">0 citizens</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Wallets</dt>
              <dd className="mt-1 text-lg">None deployed</dd>
            </div>
          </dl>
        </Section>

        <Section title="Preview of a citizen record" tone="placeholder">
          <PlaceholderNotice />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">Sample citizens, not enrolled token holders</caption>
              <thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Sample</th>
                  <th className="py-2 pr-4 font-medium">Token</th>
                  <th className="py-2 pr-4 font-medium">Life</th>
                  <th className="py-2 pr-4 font-medium">Job</th>
                  <th className="py-2 pr-4 font-medium">Skills</th>
                  <th className="py-2 pr-4 font-medium">Wallet</th>
                  <th className="py-2 font-medium">Wealth</th>
                </tr>
              </thead>
              <tbody>
                {sampleCitizens.map((citizen) => (
                  <tr key={citizen.id} className="border-b border-line">
                    <td className="py-3 pr-4">{citizen.label}</td>
                    <td className="py-3 pr-4">{citizen.token}</td>
                    <td className="py-3 pr-4">{citizen.lifeStatus}</td>
                    <td className="py-3 pr-4">{citizen.job}</td>
                    <td className="py-3 pr-4">{citizen.skills}</td>
                    <td className="py-3 pr-4">{citizen.wallet}</td>
                    <td className="py-3">{citizen.wealth}</td>
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
