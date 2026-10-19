"use client";

import { useMemo } from "react";
import { ExternalAnchor, HashField } from "@/components/verify/hash-field";
import { SourceBadge } from "@/components/world/event-item";
import { OFFCHAIN_ROOT_SENTENCE } from "@/lib/verify/anchor";
import { canonicalEventDocument } from "@/lib/verify/canonical";
import { verifyEventLocally, type VerifyStatus } from "@/lib/verify/chain";
import { LEAF_ENCODING } from "@/lib/verify/merkle";
import type { VerifyBundle } from "@/lib/verify/types";
import type { EventSource } from "@/lib/world/types";

const STATUS_COPY: Record<VerifyStatus, string> = {
  unverified: "Unverified. This row has no stored event hash, so there is nothing to recompute.",
  event_hash_verified:
    "event_hash_verified. The stored SHA-256 matches a local recomputation. Neighbors and a Merkle proof were not confirmed. This is not an onchain transaction.",
  log_integrity_verified:
    "log_integrity_verified. The event hash and the provided hash-chain links match. This is not an onchain anchor.",
  merkle_proof_verified:
    "merkle_proof_verified. The event hash and inclusion proof match the supplied batch root. A matching proof is not an onchain root and it is not proof the event happened.",
  onchain_anchor_verified:
    "onchain_anchor_verified. A read-only call found deployed bytecode and a matching EventAnchor batch on the expected chain. The contract stores roots. It does not prove the event happened.",
  verification_failed: "verification_failed. A specific check did not match. This is not a partial success.",
};

const STATUS_TONE: Record<VerifyStatus, string> = {
  unverified: "border-line text-muted",
  event_hash_verified: "border-accent/40 text-accent",
  log_integrity_verified: "border-accent/40 text-accent",
  merkle_proof_verified: "border-violet/50 text-violet",
  onchain_anchor_verified: "border-sky-400/50 text-sky-300",
  verification_failed: "border-warning/50 text-warning",
};

function evidenceClass(bundle: VerifyBundle): { title: string; body: string } {
  if (bundle.transfer?.canonical) {
    return {
      title: "Real chain activity",
      body: "This is a confirmed Chog Genesis transfer observed by the watcher. The transaction, block, and log are chain evidence. The event hash is a separate check of the stored record.",
    };
  }
  if (bundle.transfer) {
    return {
      title: "Watcher transfer, not canonical",
      body: "The watcher recorded this transfer and does not treat it as part of the current canonical chain. Explorer links are withheld. This is not confirmed onchain activity.",
    };
  }
  return {
    title: "Recorded world event",
    body: "This is a recorded simulation or world event. Its hash and any Merkle proof check stored bytes. They do not make this event a blockchain transaction.",
  };
}

export function EventVerifier({ bundle }: { bundle: VerifyBundle }) {
  const result = useMemo(
    () =>
      verifyEventLocally({
        event: bundle.event,
        storedHash: bundle.storedHash,
        integrityClass: bundle.integrityClass,
        previous: bundle.previous,
        next: bundle.next,
        proof: bundle.proof,
        expectedRoot: bundle.batch?.merkleRoot ?? null,
        batchSpan: bundle.batch
          ? { fromSeq: bundle.batch.fromSeq, toSeq: bundle.batch.toSeq, eventCount: bundle.batch.eventCount }
          : null,
        anchor: bundle.anchor,
        recordedAnchorStatus: bundle.batch?.anchorStatus ?? null,
        anchorIssue: bundle.anchorIssue,
        anchorObservation: bundle.anchorObservation,
      }),
    [bundle],
  );
  const canonical = useMemo(() => {
    try {
      return { text: canonicalEventDocument(bundle.event), error: null as string | null };
    } catch (error) {
      return { text: null, error: error instanceof Error ? error.message : "The canonical document could not be encoded." };
    }
  }, [bundle.event]);
  const evidence = evidenceClass(bundle);
  const offchain = result.reasons.includes(OFFCHAIN_ROOT_SENTENCE);
  const transfer = bundle.transfer;

  return (
    <div className="max-w-3xl space-y-6">
      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">{evidence.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{evidence.body}</p>
      </section>

      <p className={`inline-flex rounded-full border px-3 py-1 text-xs tracking-[0.14em] ${STATUS_TONE[result.status]}`}>
        {result.status}
      </p>
      <p className="text-sm leading-6 text-muted">{STATUS_COPY[result.status]}</p>
      {offchain ? (
        <p className="rounded-xl border border-line bg-card px-3 py-3 text-sm leading-6">{OFFCHAIN_ROOT_SENTENCE}</p>
      ) : null}
      {result.status === "verification_failed" ? (
        <p className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-3 text-sm leading-6 text-warning">
          Verification failed. The reason is listed below. A database status of confirmed is not a successful live read.
        </p>
      ) : null}
      <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
        {result.reasons.filter((reason) => reason !== OFFCHAIN_ROOT_SENTENCE).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Event</h2>
        <p className="mt-2">
          <SourceBadge source={bundle.event.source as EventSource} /> <span>{bundle.event.summary}</span>
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <HashField label="Id" value={bundle.event.id} />
          <Fact label="Sequence" value={String(bundle.event.seq)} />
          <Fact label="Kind" value={bundle.event.kind} />
          <Fact label="Category" value={bundle.event.category} />
          <Fact label="Source" value={bundle.event.source} />
          <Fact label="Occurred (UTC)" value={bundle.event.occurredAt} />
          <Fact label="Created (UTC)" value={bundle.event.createdAt} />
          <Fact label="World seconds" value={bundle.event.worldS == null ? "—" : String(bundle.event.worldS)} />
          <HashField label="Citizen" value={bundle.event.actorCitizenId ?? null} />
          <HashField label="Related citizen" value={bundle.event.relatedCitizenId ?? null} />
          <Fact label="Building" value={bundle.event.buildingId || "—"} />
          <HashField label="Intent" value={bundle.event.intentId ?? null} />
          <HashField label="Decision" value={bundle.event.decisionId ?? null} />
          <Fact label="Tick" value={bundle.event.tickSeq == null ? "—" : String(bundle.event.tickSeq)} />
          <Fact label="Chain status" value={bundle.event.chainStatus} />
          <Fact label="Integrity class" value={bundle.integrityClass ?? "unset"} />
        </dl>
        <div className="mt-4">
          <h3 className="text-xs uppercase tracking-[0.14em] text-muted">Canonical event data</h3>
          {canonical.error ? (
            <p className="mt-2 text-sm text-warning">{canonical.error}</p>
          ) : (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-accent">Show canonical document</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line p-3 font-mono text-xs leading-5">
                {canonical.text}
              </pre>
            </details>
          )}
        </div>
      </section>

      {transfer ? (
        <section className="rounded-2xl border border-line bg-card px-4 py-4">
          <h2 className="font-serif text-2xl">Chain evidence</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {transfer.canonical
              ? "These fields come from the watcher log stored on this activity. Confirmed means the log is still in the canonical watcher snapshot."
              : "Links are withheld because this transfer is not a confirmed canonical log."}
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <Fact label="Chain id" value={transfer.chainId == null ? "—" : String(transfer.chainId)} />
            <Fact label="Canonical" value={transfer.canonical ? "yes" : "no"} />
            <Fact label="Row matches payload hash" value={transfer.consistent ? "yes" : "no"} />
            <HashField label="Transaction hash" value={transfer.txHash} href={transfer.links.transaction} linkLabel="Transaction" />
            <HashField label="Block number" value={transfer.blockNumber} href={transfer.links.block} linkLabel="Block" />
            <HashField label="Block hash" value={transfer.blockHash} />
            <Fact label="Transaction index" value={transfer.txIndex ?? "not recorded on this activity"} />
            <Fact label="Log index" value={transfer.logIndex ?? "—"} />
            <HashField label="NFT contract" value={transfer.contract} href={transfer.links.contract} linkLabel="Contract" />
            <HashField label="Token id" value={transfer.tokenId} href={transfer.links.token} linkLabel="Token" />
            <HashField label="From" value={transfer.from} href={transfer.links.from} linkLabel="From address" />
            <HashField label="To" value={transfer.to} href={transfer.links.to} linkLabel="To address" />
            <HashField label="Payload transaction hash" value={transfer.payloadTxHash} />
          </dl>
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Hashes</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Offchain hashes stay on this page, in the canonical document, and in the JSON export. They are not explorer objects.
        </p>
        <dl className="mt-4 grid gap-3">
          <HashField label="Stored event hash" value={bundle.storedHash} />
          <HashField label="Recomputed event hash" value={result.computedHash} />
          <HashField label="Previous event hash" value={bundle.previous?.hash ?? bundle.event.prevEventHash ?? null} />
          <HashField label="Next event hash" value={bundle.next?.hash ?? null} />
          <HashField label="Merkle batch id" value={bundle.batch?.id ?? null} />
          <HashField label="Merkle root" value={bundle.batch?.merkleRoot ?? null} />
        </dl>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Merkle proof</h2>
        {bundle.batch ? (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <Fact label="Tree format" value={bundle.batch.treeFormat} />
            <Fact label="Leaf encoding" value={(bundle.proof?.leafEncoding ?? [...LEAF_ENCODING]).join(", ")} />
            <Fact label="Sort leaves" value="false" />
            <Fact label="Sequence range" value={`${bundle.batch.fromSeq}–${bundle.batch.toSeq}`} />
            <Fact label="Event count" value={String(bundle.batch.eventCount)} />
            <Fact label="Batch kind" value={bundle.batch.kind} />
            <Fact label="Database anchor status" value={bundle.batch.anchorStatus} />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted">This event is not in a Merkle batch yet.</p>
        )}
        {bundle.proof ? (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Inclusion proof ({bundle.proof.format})</p>
            {bundle.proof.proof.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Empty proof. A single-leaf tree has no sibling hashes.</p>
            ) : (
              <ol className="mt-2 space-y-2">
                {bundle.proof.proof.map((step, index) => (
                  <li key={`${index}-${step}`}>
                    <HashField label={`Proof step ${index + 1}`} value={step} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">No inclusion proof is stored for this event yet.</p>
        )}
        <p className="mt-3 text-sm leading-6 text-muted">
          Leaf encoding is bytes32 in an OpenZeppelin standard tree with sortLeaves false. A valid proof matches the supplied root only.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Anchor read</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{bundle.anchorRead.reason}</p>
        {bundle.anchor ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <Fact label="Expected chain" value={String(bundle.anchor.chainId)} />
            <HashField label="Anchor contract" value={bundle.anchor.contract} href={bundle.explorerContractUrl} linkLabel="Contract" />
            <HashField label="Anchor transaction" value={bundle.anchor.txHash} href={bundle.explorerTxUrl} linkLabel="Transaction" />
            <HashField label="Anchor block" value={bundle.anchor.blockNumber} href={bundle.explorerBlockUrl} linkLabel="Block" />
          </dl>
        ) : (
          <p className="mt-3 text-sm leading-6 text-muted">No validated anchor transaction is attached to this batch.</p>
        )}
        {bundle.anchorObservation ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <Fact label="Observed chain" value={bundle.anchorObservation.observedChainId == null ? "—" : String(bundle.anchorObservation.observedChainId)} />
            <Fact label="Bytecode bytes" value={bundle.anchorObservation.codeBytes == null ? "not read" : String(bundle.anchorObservation.codeBytes)} />
            <Fact label="Receipt" value={bundle.anchorObservation.receiptStatus ?? "not read"} />
            <Fact label="Receipt block" value={bundle.anchorObservation.receiptBlock ?? "—"} />
            <HashField label="Event batch id" value={bundle.anchorObservation.event?.batchId ?? null} />
            <HashField label="Event root" value={bundle.anchorObservation.event?.merkleRoot ?? null} />
            <HashField label="Stored root" value={bundle.anchorObservation.storedBatch?.merkleRoot ?? null} />
            <Fact label="Stored anchored at" value={bundle.anchorObservation.storedBatch?.anchoredAt ?? "—"} />
          </dl>
        ) : null}
        <p className="mt-3 text-sm leading-6 text-muted">
          This page reassesses the observation included in the export. It does not open a second RPC from the browser. Repeat getBatch
          on the recorded contract before treating the root as published. EventAnchor does not check the inclusion proof.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Deployment artifacts</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Creation-code hashes kept by this repository. A predicted address is not a deployed wallet.
        </p>
        <div className="mt-4 space-y-3">
          {bundle.artifacts.map((artifact) => (
            <div key={artifact.id}>
              <p className="text-sm">{artifact.label}</p>
              <dl className="mt-2 grid gap-2">
                {artifact.hash ? <HashField label={artifact.hashKind} value={artifact.hash} /> : null}
                <HashField label="Address" value={artifact.address} href={artifact.explorerUrl} linkLabel="Address on explorer" />
              </dl>
              <p className="mt-1 text-xs leading-5 text-muted">{artifact.codeLabel}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Source</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {bundle.provenance.revision.sha ? bundle.provenance.revision.label : "Build revision unavailable"}
        </p>
        {bundle.provenance.commitUrl ? (
          <p className="mt-2 text-sm">
            <ExternalAnchor href={bundle.provenance.commitUrl}>{bundle.provenance.revision.sha}</ExternalAnchor>
          </p>
        ) : null}
        <ul className="mt-3 space-y-1">
          {bundle.provenance.sources.map((source) => (
            <li key={source.path} className="break-all font-mono text-xs">
              {source.url ? <ExternalAnchor href={source.url}>{source.path}</ExternalAnchor> : source.path}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm">
          <a className="text-accent hover:underline" href={`/api/verify/events/${bundle.event.id}?export=1`}>
            Download machine-readable export
          </a>
        </p>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
          {bundle.reviewerChecks.map((check) => (
            <li key={check}>{check}</li>
          ))}
          {bundle.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-0.5 break-all text-sm">{value}</dd>
    </div>
  );
}
