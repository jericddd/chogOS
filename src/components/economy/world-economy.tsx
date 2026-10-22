import Link from "next/link";
import { describeTownNeedsBanner } from "@/lib/world/needs";
import { RESOURCE_LABEL } from "@/lib/world/present";
import type { TownNeedView } from "@/lib/world/types";

const STOCK_ORDER = ["food", "wood", "stone", "tools"] as const;

export function WorldEconomyPanel({
  stock,
  townNeeds,
  townNeedsReady,
  unavailable,
}: {
  stock: Record<string, number> | null;
  townNeeds: readonly TownNeedView[];
  townNeedsReady: boolean;
  unavailable: string | null;
}) {
  const banner = describeTownNeedsBanner(townNeeds, townNeedsReady);
  const entries = stockEntries(stock);
  return (
    <section className="rounded-2xl border border-line bg-card px-5 py-5" data-testid="world-economy">
      <p className="text-xs tracking-[0.16em] text-accent uppercase">Town goods</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">World economy</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
        Food, wood, stone, and tools are simulated counts in the town storehouse. A ChogBank balance is a separate Monad reading.
      </p>
      {unavailable ? <p className="mt-4 text-sm leading-6 text-warning">{unavailable}</p> : null}
      {entries.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">The storehouse has no stock in this reading.</p>
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {entries.map(([resource, amount]) => (
            <li key={resource} className="rounded-xl border border-line px-4 py-3">
              <p className="text-xs tracking-[0.14em] text-muted uppercase">{RESOURCE_LABEL[resource] ?? resource}</p>
              <p className="mt-2 font-serif text-2xl tracking-tight tabular-nums">{amount}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5">
        <h3 className="font-serif text-xl">Town needs</h3>
        <p className="mt-2 text-sm">{banner.title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{banner.detail}</p>
      </div>
      <p className="mt-5 text-sm leading-6 text-muted">
        <Link href="/" className="text-accent">
          Open the world
        </Link>{" "}
        to watch the storehouse change with the town.
      </p>
    </section>
  );
}

function stockEntries(stock: Record<string, number> | null): Array<[string, number]> {
  if (!stock) {
    return [];
  }
  const ordered = STOCK_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(stock, key));
  const rest = Object.keys(stock).filter((key) => !ordered.includes(key as (typeof STOCK_ORDER)[number]));
  return [...ordered, ...rest].map((key) => [key, stock[key] ?? 0]);
}
