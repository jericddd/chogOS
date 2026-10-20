import Link from "next/link";
import type { DiscoveredActivityItem, DiscoveredActivityPage } from "@/lib/economy/discover-activity";

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function DiscoveredActivityPanel({
  view,
  focusTx = null,
}: {
  view: DiscoveredActivityPage;
  focusTx?: string | null;
}) {
  const older = view.nextCursor ? olderHref(view.nextCursor, focusTx) : null;
  return (
    <section className="rounded-2xl border border-line bg-card px-5 py-5" data-testid="discovered-activity">
      <p className="text-xs tracking-[0.16em] text-accent uppercase">Read-only chain evidence</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">Discovered Mainnet Activity</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">{view.accountingNote}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{view.headline}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{view.detail}</p>
      {view.coverageNote ? <p className="mt-2 text-sm leading-6 text-muted">{view.coverageNote}</p> : null}
      <p className="mt-2 text-sm leading-6 text-muted">{view.decimalsNote}</p>
      {view.items.length > 0 ? (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {view.items.map((item) => (
            <li key={`${item.txHash}:${item.logIndex}`} className="py-4">
              <p className="text-sm">{item.verificationLabel}</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <Fact label="Status" value={item.cached ? "Verified from cache" : "Verified now"} />
                <Fact label="Checked" value={item.checkedAt} />
                <Fact label="Block" value={item.blockNumber} mono />
                <Fact label="Log index" value={String(item.logIndex)} />
                <Fact label="Block hash" value={item.blockHash} mono />
                <Fact label="$CHOG token" value={item.token} mono />
                <Fact label="From" value={item.from} mono />
                <Fact label="To" value={item.to} mono />
                <Fact label="Raw amount" value={item.amountRaw} mono />
                <Fact label="Amount" value={item.amountText} />
                <Fact label="Treasury direction" value={directionLabel(item)} />
              </dl>
              <p className="mt-2 font-mono text-xs break-all text-muted">{item.txHash}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{item.directionNote}</p>
              <p className="mt-2 text-sm leading-6 text-muted">Not included in treasury totals.</p>
              {item.explorerHref ? (
                <a className="mt-2 inline-block text-sm text-accent" href={item.explorerHref} rel="noopener noreferrer" target="_blank">
                  View transaction
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {older ? (
        <Link href={older} className="mt-4 inline-block text-sm text-accent">
          Older activity
        </Link>
      ) : null}
    </section>
  );
}

function directionLabel(item: DiscoveredActivityItem): string {
  if (item.direction === "unattributed") {
    return "Unattributed. The economic treasury address is not configured.";
  }
  if (item.direction === "treasury_in") {
    return "Toward the configured economic treasury. Not counted as income.";
  }
  if (item.direction === "treasury_out") {
    return "From the configured economic treasury. Not counted as expenditure.";
  }
  if (item.direction === "external") {
    return "External. Not treasury income or expenditure.";
  }
  return "Ambiguous. Not treasury income or expenditure.";
}

function olderHref(cursor: string, focusTx: string | null): string {
  const params = new URLSearchParams();
  if (focusTx && HASH.test(focusTx.trim())) {
    params.set("tx", focusTx.trim().toLowerCase());
  }
  params.set("activity", cursor);
  return `/economy?${params.toString()}`;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className={`mt-1 text-sm leading-6 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
