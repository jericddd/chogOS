import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ProvenancePanel } from "@/components/verify/provenance-panel";
import { SourceBadge } from "@/components/world/event-item";
import { explorerAddressUrl } from "@/lib/blockchain/explorer";
import { formatUtc } from "@/lib/civilization/labels";
import { readAppConfig } from "@/lib/config/env";
import { OFFCHAIN_ROOT_SENTENCE } from "@/lib/verify/anchor";
import { EVENT_HASH_ALG, EVENT_INTEGRITY_SCHEMA } from "@/lib/verify/canonical";
import { TREE_FORMAT } from "@/lib/verify/merkle";
import { buildPublicProvenance } from "@/lib/verify/provenance";
import { loadEventPage } from "@/lib/world/load";
import { CATEGORY_LABEL } from "@/lib/world/present";
import { pickAiConstructionEvent } from "@/lib/world/sync";
import type { EventPage, WorldEventView } from "@/lib/world/types";

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

function featuredAiConstruction(page: EventPage): WorldEventView | null {
  if (page.status !== "ok") {
    return null;
  }
  return pickAiConstructionEvent(page.events);
}

async function VerifyLive() {
  await connection();
  const config = readAppConfig();
  const anchored = Boolean(config.eventAnchorAddress);
  const provenance = buildPublicProvenance();

  return (
    <div>
      <PageHeader
        title="Verifiable history"
        lede="Every sealed event has a canonical encoding and a SHA-256 hash. Batches of those hashes can be committed with an OpenZeppelin standard Merkle tree. A matching hash is evidence about the stored bytes, not about whether the simulation told the truth."
      />
      <Suspense fallback={<p className="text-sm text-muted">Loading the latest recorded AI construction…</p>}>
        <LatestAiConstructionLive />
      </Suspense>
      <div className="mt-8">
        <ProvenancePanel
          provenance={provenance}
          anchorAddress={config.eventAnchorAddress ?? null}
          anchorChainId={config.eventAnchorChainId ?? null}
          anchorExplorerUrl={explorerAddressUrl(config.eventAnchorChainId ?? config.chainId, config.eventAnchorAddress)}
        />
      </div>
      <div className="mt-8 max-w-3xl space-y-6 text-sm leading-6 text-muted">
        <p>
          Status labels are not interchangeable. An event whose hash matches is{" "}
          <span className="text-foreground">event_hash_verified</span>. A matching live prev-hash link is{" "}
          <span className="text-foreground">log_integrity_verified</span>. A matching inclusion proof is{" "}
          <span className="text-foreground">merkle_proof_verified</span>.{" "}
          <span className="text-foreground">onchain_anchor_verified</span> is only used after a live read of the
          deployed contract matches the batch id, root, sequence range, event count, and tree format. A database
          status, a transaction hash, or an explorer link is not that check.
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
              {config.eventAnchorAddress} on chain {config.eventAnchorChainId ?? config.chainId}. A configured address
              is not proof the contract was deployed or that a batch was submitted.
            </span>
          ) : (
            <span>
              prepared, not deployed. No testnet or mainnet root has been published by this app. {OFFCHAIN_ROOT_SENTENCE}
            </span>
          )}
        </p>
        <p>
          Open an event from History and use Verify. Download the JSON export and recompute the hash with the canonical
          encoder in src/lib/verify/canonical.ts, or with the same steps listed on the event page. The API is a data
          source; the event page recomputes in your browser. Do not paste the export into a third-party hashing site.
        </p>
        <p>
          A database operator with the service role or a Postgres superuser can still rewrite rows if they disable
          triggers. External commitments are what make that detectable after publication.
        </p>
      </div>
    </div>
  );
}

async function LatestAiConstructionLive() {
  await connection();
  const history = await loadEventPage({ source: "ai", category: "construction" }, null, 1);
  return <LatestAiConstruction page={history} event={featuredAiConstruction(history)} />;
}

function LatestAiConstruction({
  page,
  event,
}: {
  page: EventPage;
  event: WorldEventView | null;
}) {
  return (
    <section className="max-w-3xl rounded-2xl border border-line bg-card px-4 py-5 sm:px-5">
      <h2 className="font-serif text-2xl tracking-tight">Latest AI construction</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        The newest recorded construction event with source AI, when one exists. Verification below is offchain
        event-chain checking of stored bytes, not an on-chain proof.
      </p>
      {page.status !== "ok" ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          {page.detail} AI construction events appear here once recorded history can be read. This page does not
          invent examples.
        </p>
      ) : event ? (
        <div className="mt-4">
          <p className="flex flex-wrap items-center gap-2">
            <SourceBadge source={event.source} />
            <span>{event.summary}</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            <span className="font-mono text-foreground">{event.kind}</span>
            <span> · {CATEGORY_LABEL[event.category]}</span>
            <span> · {formatUtc(event.occurredAt)}</span>
            <span> · source {event.source}</span>
          </p>
          <p className="mt-3">
            <Link href={`/verify/events/${event.id}`} className="text-sm text-accent hover:underline">
              Verify this event
            </Link>
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm leading-6 text-muted">
          No AI construction events are recorded yet. This page does not invent event ids or verification results.
        </p>
      )}
    </section>
  );
}
