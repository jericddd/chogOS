import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { EventVerifier } from "@/components/verify/event-verifier";
import { loadVerifyBundle } from "@/lib/verify/load";

export const metadata: Metadata = {
  title: "Verify event",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function VerifyEventPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading event…</p>}>
      {params.then(({ id }) => (
        <VerifyEventLive id={id} />
      ))}
    </Suspense>
  );
}

async function VerifyEventLive({ id }: { id: string }) {
  await connection();
  if (!UUID.test(id)) {
    return <PageHeader title="Verify event" lede="That id is not a UUID." />;
  }
  const bundle = await loadVerifyBundle(id);
  if ("status" in bundle && bundle.status === "missing") {
    return <PageHeader title="Verify event" lede="No civilization event has that id." />;
  }
  if ("status" in bundle && bundle.status === "unconfigured") {
    return <PageHeader title="Verify event" lede={bundle.detail} />;
  }
  if ("status" in bundle) {
    return <PageHeader title="Verify event" lede="The event could not be read." />;
  }
  return (
    <div>
      <PageHeader
        title="Verify event"
        lede="Hashes and proofs below are recomputed in your browser from the exported fields. A green-looking label is not used merely because the API returned 200."
      />
      <EventVerifier bundle={bundle} />
    </div>
  );
}
