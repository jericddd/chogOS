import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";

export const metadata: Metadata = {
  title: "Businesses",
};

export default function BusinessesPage() {
  return (
    <div>
      <PageHeader
        title="Businesses"
        lede="No business has been recorded. A future business is not limited by the Chog Genesis supply, and it does not become financially real until a Monad receipt exists."
      />
      <Section title="Recorded businesses">
        <p className="text-lg">None.</p>
        <p className="mt-2 text-sm leading-6 text-muted">
          Phase 1 does not invent workshops, ledgers, or revenue. The AI mind is not launching businesses.
        </p>
      </Section>
    </div>
  );
}
