import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { Section } from "@/components/ui/section";
import { sampleEvents } from "@/lib/placeholder/data";

export const metadata: Metadata = {
  title: "Activity",
};

export default function ActivityPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Activity"
        lede="Shared history will mix civilization events with Monad receipts. The receipt list is empty. Sample rows below are not transactions."
      />
      <div className="space-y-6">
        <Section title="Transaction receipts">
          <p className="text-lg">No receipts stored.</p>
          <p className="mt-2 text-sm leading-6 text-muted">
            Posting a transaction is disabled. A future receipt row has to be copied from a Monad node,
            including the transaction hash and block number.
          </p>
        </Section>

        <Section title="Sample history" tone="placeholder">
          <PlaceholderNotice />
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {sampleEvents.map((event) => (
              <li key={event.summary} className="py-3">
                <p>{event.summary}</p>
                <p className="mt-1 text-sm text-muted">
                  {event.when} · {event.receipt}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
