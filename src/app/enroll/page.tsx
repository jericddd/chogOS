import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenProfile } from "@/components/citizens/citizen-profile";
import { EnrollPanel } from "@/components/enroll/enroll-panel";
import { PageHeader } from "@/components/ui/page-header";
import { readAppConfig } from "@/lib/config/env";

export const metadata: Metadata = {
  title: "Enroll",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

export default function EnrollPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Preparing enrollment…</p>}>
      <EnrollLive searchParams={searchParams} />
    </Suspense>
  );
}

async function EnrollLive({ searchParams }: { searchParams: Search }) {
  await connection();
  const params = await searchParams;
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const tokenId = raw && /^[0-9]+$/.test(raw) ? raw : null;
  const config = readAppConfig();
  const persistenceReady = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
  return (
    <div>
      <div className="max-w-3xl">
        <PageHeader
          title="Enroll a citizen"
          lede="Connect the wallet that currently owns a Chog Genesis NFT. The Chogs in that wallet are listed here. Choose one to join. After it joins, this page shows the joined date and the same profile as the citizen page. Treasury-held NFTs stay founding citizens."
        />
        <EnrollPanel chainId={config.chainId} persistenceReady={persistenceReady} focusedTokenId={tokenId} />
      </div>
      {tokenId ? (
        <div className="mt-10">
          <Suspense fallback={<p className="text-sm text-muted">Opening this Chog…</p>}>
            <CitizenProfile tokenId={tokenId} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
