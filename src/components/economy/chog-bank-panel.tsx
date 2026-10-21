import type { ChogBankPublicView } from "@/lib/economy/treasury-public";

export function ChogBankPanel({ view }: { view: ChogBankPublicView }) {
  return (
    <section className="rounded-2xl border border-line bg-card px-5 py-5" data-testid="ownerless-chogbank" data-funding-ready={view.fundingReady ? "yes" : "no"}>
      <p className="text-xs tracking-[0.16em] text-accent uppercase">Ownerless treasury</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">ChogBank</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">{view.summary}</p>
      <dl className="mt-5 grid gap-4 md:grid-cols-2">
        <Fact label="Network" value={view.networkLabel} />
        <Fact label="Payout execution" value={view.execution} />
        <Fact label="Funding address" value={view.fundingAddress ?? "Not ready"} mono={Boolean(view.fundingAddress)} />
        <Fact label="Deployment transaction" value={view.deploymentTxHref ? "Monadscan receipt" : "Not recorded"} href={view.deploymentTxHref} />
        <Fact label="Source verification" value={view.sourceNote} />
        <Fact label="Owner and admin" value={view.ownerStatus} />
        <Fact label="Proxy" value={view.proxyStatus} />
        <Fact label="Spending authority" value={view.authorizerStatus} />
      </dl>
      {view.explorerContractHref ? (
        <a className="mt-4 inline-block text-sm text-accent" href={view.explorerContractHref} rel="noopener noreferrer" target="_blank">
          View contract on Monadscan
        </a>
      ) : (
        <p className="mt-4 text-sm leading-6 text-muted">No contract explorer link is shown until the deployed code passes the checks.</p>
      )}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Amount label="MON" text={view.monText} />
        <Amount label="$CHOG" text={view.chogText} />
      </div>
      {view.warnings.length > 0 ? (
        <ul className="mt-5 list-disc space-y-2 pl-5 text-sm leading-6 text-muted">
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-5">
        <h3 className="font-serif text-xl">Spending policy</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted">
          {view.policy.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="mt-5">
        <h3 className="font-serif text-xl">Funding</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted">
          {view.funding.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-6 text-muted">{view.fundingNote}</p>
        {view.fundingRows.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {view.fundingRows.map((row) => (
              <li key={`${row.txHash}-${row.kind}-${row.amountRaw}`} className="py-3">
                <p className="text-sm">
                  {row.label}. {row.amountText}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">Block {row.blockNumber}. From {row.from}.</p>
                {row.href ? (
                  <a className="mt-1 inline-block text-sm text-accent" href={row.href} rel="noopener noreferrer" target="_blank">
                    View funding transaction
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-5">
        <h3 className="font-serif text-xl">Allocation decisions</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{view.decisionsNote}</p>
        {view.decisions.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {view.decisions.map((decision) => (
              <li key={decision.id} className="py-3">
                <p className="text-sm">{decision.headline}</p>
                <p className="mt-1 text-sm leading-6 text-muted">{decision.detail}</p>
                {decision.amountText ? <p className="mt-1 text-sm">{decision.amountText}</p> : null}
                {decision.citizen ? <p className="mt-1 text-sm text-muted">{decision.citizen}</p> : null}
                {decision.recipient ? <p className="mt-1 font-mono text-xs break-all text-muted">{decision.recipient}</p> : null}
                {decision.txHref ? (
                  <a className="mt-1 inline-block text-sm text-accent" href={decision.txHref} rel="noopener noreferrer" target="_blank">
                    View payout receipt
                  </a>
                ) : (
                  <p className="mt-1 text-sm text-muted">No payout transaction.</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function Fact({ label, value, mono = false, href = null }: { label: string; value: string; mono?: boolean; href?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className={`mt-1 text-sm leading-6 ${mono ? "font-mono text-xs break-all" : "text-pretty"}`}>
        {href ? (
          <a className="text-accent" href={href} rel="noopener noreferrer" target="_blank">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
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
