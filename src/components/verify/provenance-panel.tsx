import { CopyButton, ExternalAnchor } from "@/components/verify/hash-field";
import { OFFCHAIN_ROOT_SENTENCE } from "@/lib/verify/anchor";
import type { PublicProvenance } from "@/lib/verify/provenance";

export function ProvenancePanel({
  provenance,
  anchorAddress,
  anchorChainId,
  anchorExplorerUrl,
}: {
  provenance: PublicProvenance;
  anchorAddress: string | null;
  anchorChainId: number | null;
  anchorExplorerUrl: string | null;
}) {
  const sha = provenance.revision.sha;
  return (
    <section className="max-w-3xl rounded-2xl border border-line bg-card px-4 py-5 sm:px-5">
      <h2 className="font-serif text-2xl tracking-tight">Source provenance</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Public build identity only. A deployment URL does not prove a contract was deployed or that a transaction occurred.
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-[0.14em] text-muted">Repository</dt>
          <dd className="mt-0.5">
            <ExternalAnchor href={provenance.repository}>{provenance.repository}</ExternalAnchor>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.14em] text-muted">Build revision</dt>
          <dd className="mt-0.5 break-all font-mono text-xs">
            {sha ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{sha}</span>
                <CopyButton value={sha} label="build revision" />
                {provenance.commitUrl ? <ExternalAnchor href={provenance.commitUrl}>Commit</ExternalAnchor> : null}
                <span className="font-sans text-muted">{provenance.revision.label}</span>
              </span>
            ) : (
              provenance.revision.label
            )}
          </dd>
        </div>
      </dl>
      <ul className="mt-4 space-y-1 text-sm">
        {provenance.sources.map((source) => (
          <li key={source.path} className="break-all font-mono text-xs">
            {source.url ? <ExternalAnchor href={source.url}>{source.path}</ExternalAnchor> : source.path}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm leading-6 text-muted">
        {anchorAddress ? (
          <>
            Configured anchor address{" "}
            {anchorExplorerUrl ? (
              <ExternalAnchor href={anchorExplorerUrl}>{anchorAddress}</ExternalAnchor>
            ) : (
              <span className="font-mono text-foreground">{anchorAddress}</span>
            )}
            {anchorChainId ? ` on chain ${anchorChainId}` : ""}. A configured address is not proof of deployment or of an
            anchored batch.
          </>
        ) : (
          <>
            No anchor contract is configured. {OFFCHAIN_ROOT_SENTENCE}
          </>
        )}
      </p>
    </section>
  );
}
