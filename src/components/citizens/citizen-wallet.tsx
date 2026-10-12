import type { CitizenWalletView } from "@/lib/wallets/present";

export function CitizenWalletPanel({ view }: { view: CitizenWalletView }) {
  return (
    <section className="mt-8" data-testid="citizen-wallet">
      <h2 className="font-serif text-2xl">Citizen wallet</h2>
      <p className="mt-2 text-sm leading-6">{view.statusText}</p>
      {view.address ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          {view.addressLabel} <span className="font-mono text-xs break-all">{view.address}</span>
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">No wallet address is shown.</p>
      )}
      <p className="mt-3 text-sm leading-6 text-muted">{view.note}</p>
      <p className="mt-3 text-sm leading-6 text-muted">{view.authority}</p>
    </section>
  );
}
