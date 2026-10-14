"use client";

import { useMemo } from "react";
import { verifyEventLocally, type VerifyStatus } from "@/lib/verify/chain";
import type { VerifyBundle } from "@/lib/verify/types";
import { SourceBadge } from "@/components/world/event-item";
import type { EventSource } from "@/lib/world/types";

const STATUS_COPY: Record<VerifyStatus, string> = {
  unverified: "Unverified. This row has no stored event hash.",
  event_hash_verified: "Event hash verified in this browser. No live chain neighbors or Merkle proof were confirmed.",
  log_integrity_verified: "Event hash and provided hash-chain links verified in this browser. Not an onchain anchor.",
  merkle_proof_verified: "Event hash and Merkle inclusion verified in this browser against the stored batch root. That root is not an onchain fact until a contract read matches it.",
  onchain_anchor_verified: "Event hash, Merkle proof, and a contract root read for this batch all match. This commits to the data, not to the truth of the simulation.",
  verification_failed: "Verification failed. The stored record does not match a local recomputation.",
};

const STATUS_TONE: Record<VerifyStatus, string> = {
  unverified: "border-line text-muted",
  event_hash_verified: "border-accent/40 text-accent",
  log_integrity_verified: "border-accent/40 text-accent",
  merkle_proof_verified: "border-violet/50 text-violet",
  onchain_anchor_verified: "border-sky-400/50 text-sky-300",
  verification_failed: "border-warning/50 text-warning",
};

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
        anchor: bundle.anchor,
        onchainRoot: null,
        onchainChainId: null,
      }),
    [bundle],
  );

  return (
    <div className="space-y-6">
      <p className={`inline-flex rounded-full border px-3 py-1 text-xs uppercase tracking-[0.14em] ${STATUS_TONE[result.status]}`}>
        {result.status}
      </p>
      <p className="max-w-2xl text-sm leading-6 text-muted">{STATUS_COPY[result.status]}</p>
      <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
        {result.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Event</h2>
        <p className="mt-2">
          <SourceBadge source={bundle.event.source as EventSource} />{" "}
          <span>{bundle.event.summary}</span>
        </p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <Fact label="Id" value={bundle.event.id} mono />
          <Fact label="Sequence" value={String(bundle.event.seq)} mono />
          <Fact label="Kind" value={bundle.event.kind} />
          <Fact label="Category" value={bundle.event.category} />
          <Fact label="Occurred (UTC)" value={bundle.event.occurredAt} />
          <Fact label="Created (UTC)" value={bundle.event.createdAt} />
          <Fact label="World seconds" value={bundle.event.worldS === null || bundle.event.worldS === undefined ? "—" : String(bundle.event.worldS)} />
          <Fact label="Citizen" value={bundle.event.actorCitizenId || "—"} mono />
          <Fact label="Related citizen" value={bundle.event.relatedCitizenId || "—"} mono />
          <Fact label="Building" value={bundle.event.buildingId || "—"} />
          <Fact label="Intent" value={bundle.event.intentId || "—"} mono />
          <Fact label="Decision" value={bundle.event.decisionId || "—"} mono />
          <Fact label="Tick" value={bundle.event.tickSeq === null || bundle.event.tickSeq === undefined ? "—" : String(bundle.event.tickSeq)} />
          <Fact label="Chain status" value={bundle.event.chainStatus} />
          <Fact label="Integrity class" value={bundle.integrityClass ?? "unset"} />
        </dl>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Hashes</h2>
        <dl className="mt-4 grid gap-2 text-sm">
          <Fact label="Stored event hash" value={bundle.storedHash ?? "—"} mono />
          <Fact label="Recomputed event hash" value={result.computedHash ?? "—"} mono />
          <Fact label="Previous event hash" value={bundle.event.prevEventHash ?? "—"} mono />
          <Fact label="Merkle root" value={bundle.batch?.merkleRoot ?? "—"} mono />
        </dl>
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Batch and anchor</h2>
        {bundle.batch ? (
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <Fact label="Batch" value={bundle.batch.id} mono />
            <Fact label="Kind" value={bundle.batch.kind} />
            <Fact label="Tree" value={bundle.batch.treeFormat} />
            <Fact label="Range" value={`${bundle.batch.fromSeq}–${bundle.batch.toSeq}`} />
            <Fact label="Anchor status" value={bundle.batch.anchorStatus} />
            <Fact label="Snapshot committed" value={bundle.batch.snapshotCommittedAt ?? "—"} />
            <Fact label="Anchor chain" value={bundle.anchor ? String(bundle.anchor.chainId) : "not anchored"} />
            <Fact label="Contract" value={bundle.anchor?.contract ?? "—"} mono />
            <Fact label="Transaction" value={bundle.anchor?.txHash ?? "—"} mono />
            <Fact label="Block" value={bundle.anchor?.blockNumber ?? "—"} mono />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted">This event is not in a Merkle batch yet.</p>
        )}
        {bundle.proof ? (
          <p className="mt-3 break-all font-mono text-xs text-muted">
            Inclusion proof ({bundle.proof.format}): {bundle.proof.proof.join(" ")}
          </p>
        ) : null}
        {bundle.explorerTxUrl ? (
          <p className="mt-3 text-sm">
            <a className="text-accent hover:underline" href={bundle.explorerTxUrl} rel="noreferrer" target="_blank">
              Open recorded transaction on the explorer
            </a>
            {bundle.explorerContractUrl ? (
              <>
                {" · "}
                <a className="text-accent hover:underline" href={bundle.explorerContractUrl} rel="noreferrer" target="_blank">
                  Contract
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {bundle.anchor ? (
          <p className="mt-3 text-sm text-muted">
            This page did not call the chain, so it will not show onchain_anchor_verified. Use the JSON export and
            query EventAnchor.getBatch on the recorded network yourself.
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-card px-4 py-4">
        <h2 className="font-serif text-2xl">Notes</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
          {bundle.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <p className="mt-4 text-sm">
          <a className="text-accent hover:underline" href={`/api/verify/events/${bundle.event.id}?export=1`}>
            Download machine-readable export
          </a>
        </p>
      </section>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
