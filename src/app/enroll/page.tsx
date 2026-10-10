import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { EnrollPanel } from "@/components/enroll/enroll-panel";
import { PageHeader } from "@/components/ui/page-header";
import { readAppConfig } from "@/lib/config/env";

export const metadata: Metadata = {
  title: "Enroll",
};

export default function EnrollPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Preparing enrollment…</p>}>
      <EnrollLive />
    </Suspense>
  );
}

async function EnrollLive() {
  await connection();
  const config = readAppConfig();
  const persistenceReady = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Enroll a citizen"
        lede="Connect the wallet that currently owns a Chog Genesis NFT. The server checks ownerOf on Monad and asks for a signature before writing a community citizen. Treasury-held NFTs stay founding citizens and are not moved."
      />
      <EnrollPanel chainId={config.chainId} persistenceReady={persistenceReady} />
    </div>
  );
}
