import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { readAppConfig } from "@/lib/config/env";
import { EVENT_HASH_ALG, EVENT_INTEGRITY_SCHEMA } from "@/lib/verify/canonical";
import { TREE_FORMAT } from "@/lib/verify/merkle";

export const metadata: Metadata = {
  title: "Verify",
};

export default function VerifyPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading verification status…</p>}>
      <VerifyLive />
    </Suspense>
  );
}

async function VerifyLive() {
  await connection();
  const config = readAppConfig();
  const anchored = Boolean(config.eventAnchorAddress);

  return (
    <div>
      <PageHeader
        title="Verifiable history"
        lede="Every sealed event has a canonical encoding and a SHA-256 hash. Batches of those hashes can be committed with an OpenZeppelin standard Merkle tree. A matching hash is evidence about the stored bytes, not about whether the simulation told the truth."
      />
      <div className="max-w-3xl space-y-6 text-sm leading-6 text-muted">
        <p>
          Status labels are not interchangeable. An event whose hash matches is{" "}
          <span className="text-foreground">event_hash_verified</span>. A matching live prev-hash link is{" "}
          <span className="text-foreground">log_integrity_verified</span>. A matching inclusion proof is{" "}
          <span className="text-foreground">merkle_proof_verified</span>.{" "}
          <span className="text-foreground">onchain_anchor_verified</span> is only used after a contract read on the
          recorded chain returns the same root.
        </p>
        <p>
          Schema <span className="font-mono text-foreground">{EVENT_INTEGRITY_SCHEMA}</span>, hash{" "}
          <span className="font-mono text-foreground">{EVENT_HASH_ALG}</span>, tree{" "}
          <span className="font-mono text-foreground">{TREE_FORMAT}</span>. Leaves stay in sequence order
          (`sortLeaves: false`).
        </p>
        <p>
          Anchor contract:{" "}
          {anchored ? (
            <span className="font-mono text-foreground">
              {config.eventAnchorAddress} on chain {config.eventAnchorChainId ?? config.chainId}
            </span>
          ) : (
            <span>prepared, not deployed. No testnet or mainnet root has been published by this app.</span>
          )}
        </p>
        <p>
          Open an event from History and use Verify. Download the JSON export to recompute the hash outside this
          website. The API is a data source; this page recomputes in your browser.
        </p>
        <p>
          A database operator with the service role or a Postgres superuser can still rewrite rows if they disable
          triggers. External commitments are what make that detectable after publication.
        </p>
      </div>
    </div>
  );
}
