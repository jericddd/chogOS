import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenGallery } from "@/components/citizens/citizen-gallery";
import { PageHeader } from "@/components/ui/page-header";
import { loadWorldSnapshot } from "@/lib/civilization/load-world";

export const metadata: Metadata = {
  title: "Citizens",
};

export default function CitizensPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Reading the roster…</p>}>
      <CitizensLive />
    </Suspense>
  );
}

async function CitizensLive() {
  await connection();
  const world = await loadWorldSnapshot();
  return (
    <div>
      <PageHeader
        title="Citizens"
        lede="Every portrait is a Chog Genesis token verified on Monad or stored from a previous verification. Founding citizens come from ChogTreasury. Community citizens are enrolled by their owners. All of them belong to chogOS."
      />
      <CitizenGallery citizens={world.display} />
    </div>
  );
}
