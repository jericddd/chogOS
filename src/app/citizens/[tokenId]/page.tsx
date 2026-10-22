import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenProfile } from "@/components/citizens/citizen-profile";

export const metadata: Metadata = {
  title: "Citizen",
};

export default function CitizenPage({ params }: { params: Promise<{ tokenId: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Opening citizen…</p>}>
      {params.then(({ tokenId }) => (
        <CitizenProfile tokenId={tokenId} />
      ))}
    </Suspense>
  );
}
