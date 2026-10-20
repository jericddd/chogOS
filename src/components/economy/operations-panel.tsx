import type { EconomyOperationsView } from "@/lib/economy/present";

export function EconomicOperationsPanel({ view }: { view: EconomyOperationsView }) {
  return (
    <section className="rounded-2xl border border-line bg-card px-5 py-5" data-testid="economic-operations">
      <p className="text-xs tracking-[0.16em] text-accent uppercase">Economic treasury</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">ChogBank operations</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
        Balances below are read from the configured economic treasury on Monad mainnet. They are separate from
        the Civilization Treasury record and from the ChogTreasury NFT wallet.
      </p>
      <dl className="mt-5 grid gap-4 md:grid-cols-2">
        <Fact label="Execution" value={view.execution} />
        <Fact label="Chain" value={view.chainLabel} />
        <Fact label="Status" value={view.statusLabel} />
        <Fact label="Observed" value={view.observedAt ?? "Not read"} />
        <Fact label="Block" value={view.blockNumber ?? "Not read"} mono={Boolean(view.blockNumber)} />
        <Fact label="Treasury address" value={view.address ?? "Not configured"} mono={Boolean(view.address)} />
      </dl>
      <p className="mt-4 text-sm leading-6 text-muted">{view.addressNote}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{view.freshness}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{view.executionDetail}</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Amount label="MON" text={view.monText} />
        <Amount label="$CHOG" text={view.chogText} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Fact label="Unallocated MON" value={view.unallocatedMon} />
        <Fact label="Unallocated $CHOG" value={view.unallocatedChog} />
        <Fact label="Reserved gas" value={view.reservedGas} />
        <Fact label="Reserved deployment" value={view.reservedDeployment} />
        <Fact label="Allocated MON capital" value={view.allocatedMon} />
        <Fact label="Allocated $CHOG capital" value={view.allocatedChog} />
        <Fact label="Gas exposure" value={view.gasExposure} />
        <Fact label="Allowlist" value={view.allowlist} />
      </div>
      <p className="mt-4 text-sm leading-6 text-muted">{view.budgetNote}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{view.ledgerNote}</p>
      <div className="mt-5">
        <h3 className="font-serif text-xl">Economic activity</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{view.activityNote}</p>
        {view.activities.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {view.activities.map((activity) => (
              <li key={activity.id} className="py-3">
                <p className="text-sm">{activity.summary}</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {activity.status}. {activity.reason}
                </p>
                {activity.href ? (
                  <a className="mt-1 inline-block text-sm text-accent" href={activity.href} rel="noopener noreferrer" target="_blank">
                    View transaction
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-5">
        <h3 className="font-serif text-xl">Realized transfers</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{view.transferNote}</p>
        {view.transfers.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {view.transfers.map((transfer) => (
              <li key={transfer.id} className="py-3">
                <p className="text-sm">
                  {transfer.direction === "in" ? "Incoming" : "Outgoing"} {transfer.amountText}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">{transfer.status}</p>
                {transfer.href ? (
                  <a className="mt-1 inline-block font-mono text-xs break-all text-accent" href={transfer.href} rel="noopener noreferrer" target="_blank">
                    {transfer.txHash}
                  </a>
                ) : (
                  <p className="mt-1 font-mono text-xs break-all text-muted">{transfer.txHash ?? "No transaction hash"}</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {view.blocked.length > 0 ? (
        <div className="mt-5">
          <h3 className="font-serif text-xl">Why spending is blocked</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted">
            {view.blocked.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className={`mt-1 text-sm leading-6 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function Amount({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <p className="text-xs tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className="mt-2 font-serif text-2xl tracking-tight">{text}</p>
    </div>
  );
}
