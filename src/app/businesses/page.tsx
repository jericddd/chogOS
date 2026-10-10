import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { Section } from "@/components/ui/section";
import { sampleBusiness } from "@/lib/placeholder/data";

export const metadata: Metadata = {
  title: "Businesses",
};

export default function BusinessesPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Businesses"
        lede="Businesses are not limited by the size of the Chog Genesis collection. None have been recorded, and none have a wallet or a verified ledger entry."
      />
      <div className="space-y-6">
        <Section title="Recorded businesses">
          <p className="text-lg">None.</p>
          <p className="mt-2 text-sm leading-6 text-muted">
            A business becomes financially real when its wallet activity has a Monad transaction receipt.
            The database can store a proposal before that, and it must mark the entry unverified.
          </p>
        </Section>

        <Section title="Ledger preview" tone="placeholder">
          <PlaceholderNotice />
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Name</dt>
              <dd className="mt-1">{sampleBusiness.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Status</dt>
              <dd className="mt-1">{sampleBusiness.status}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Founder</dt>
              <dd className="mt-1">{sampleBusiness.founder}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Ledger amount</dt>
              <dd className="mt-1">{sampleBusiness.ledger}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.14em] text-muted">Receipt</dt>
              <dd className="mt-1">{sampleBusiness.receipt}</dd>
            </div>
          </dl>
        </Section>
      </div>
    </div>
  );
}
