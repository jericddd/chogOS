import type { ReactNode } from "react";
import type { CivilizationTreasuryView } from "@/lib/wallets/present";

export function CivilizationTreasuryPanel({
  view,
  action,
}: {
  view: CivilizationTreasuryView;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-card px-5 py-5" data-testid="civilization-treasury">
      <p className="text-xs tracking-[0.16em] text-accent uppercase">Shared funds</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">Civilization Treasury</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
        This is the shared economic wallet for chogOS. It is not the ChogTreasury wallet that holds founding
        NFTs, and it is not a citizen wallet.
      </p>
      <dl className="mt-5 grid gap-4 md:grid-cols-2">
        <Fact label="Status" value={view.statusLabel} />
        <Fact label="Network" value={view.chainLabel} />
        <Fact label="Treasury address" value={view.address ?? "Treasury not configured"} mono={Boolean(view.address)} />
        <Fact label="Address check" value={view.verificationLabel} />
        <Fact label="Wallet type" value={view.accountLabel} />
        <Fact label="Records" value={view.persistenceDetail} />
      </dl>
      {view.detail ? <p className="mt-4 text-sm leading-6 text-muted">{view.detail}</p> : null}
      <p className="mt-4 text-sm leading-6 text-muted">{view.setup}</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {view.balances.map((balance) => (
          <div key={balance.symbol} className="rounded-xl border border-line px-4 py-3">
            <p className="text-xs tracking-[0.14em] text-muted uppercase">{balance.symbol}</p>
            <p className="mt-2 font-serif text-2xl tracking-tight">{balance.text}</p>
            <p className="mt-2 text-sm leading-6 text-muted">{balance.note}</p>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <h3 className="font-serif text-xl">Funding history</h3>
        {view.fundingNote ? <p className="mt-2 text-sm leading-6 text-warning">{view.fundingNote}</p> : null}
        {view.funding.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-muted">No funding transaction has been verified.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {view.funding.map((row) => (
              <li key={row.id} className="py-3">
                <p className="font-mono text-xs break-all">{row.txHash}</p>
                <p className="mt-1 text-sm leading-6 text-muted">{row.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-5 text-sm leading-6 text-muted">
        ChogTreasury NFT wallet{" "}
        <span className="font-mono text-xs break-all">{view.chogTreasuryAddress}</span>. That address holds
        Chog Genesis NFTs. It is a different wallet from the Civilization Treasury.
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
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
