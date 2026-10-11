import Link from "next/link";
import { CivilizationScene } from "@/components/world/civilization-scene";

const entries = [
  { href: "/citizens", label: "Citizens" },
  { href: "/treasury", label: "Genesis Treasury" },
  { href: "/activity", label: "Civilization History" },
  { href: "/enroll", label: "Enroll" },
] as const;

export function WorldStage({
  foundingCount,
  communityCount,
  treasuryCount,
  networkLabel,
  syncLabel,
  aiLabel,
  persistenceLabel,
  discrepancy,
  countLabel,
}: {
  foundingCount: number | null;
  communityCount: number | null;
  treasuryCount: number | null;
  networkLabel: string;
  syncLabel: string;
  aiLabel: string;
  persistenceLabel: string;
  discrepancy: string | null;
  countLabel: string;
}) {
  return (
    <div
      data-testid="world-stage"
      className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <div>
        <div className="overflow-hidden rounded-2xl border border-line bg-[#070d11] shadow-[0_30px_80px_rgb(0_0_0_/_0.35)]">
          <CivilizationScene
            foundingCount={foundingCount}
            communityCount={communityCount}
            treasuryCount={treasuryCount}
          />
        </div>
        <nav aria-label="World entries" className="mt-4 flex flex-wrap gap-2">
          {entries.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="rounded-full border border-line px-3 py-2 text-sm text-foreground hover:border-accent hover:text-accent"
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      </div>
      <aside className="rounded-2xl border border-line bg-card p-5">
        <p className="text-xs tracking-[0.18em] text-accent uppercase">Civilization status</p>
        <h2 className="mt-2 font-serif text-3xl tracking-tight">chogOS</h2>
        <p className="mt-3 text-sm leading-6 text-muted">{countLabel}</p>
        {discrepancy ? <p className="mt-3 text-sm leading-6 text-warning">{discrepancy}</p> : null}
        <dl className="mt-5 space-y-4 text-sm">
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Network</dt>
            <dd className="mt-1">{networkLabel}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Roster</dt>
            <dd className="mt-1">{syncLabel}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Records</dt>
            <dd className="mt-1">{persistenceLabel}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">AI mind</dt>
            <dd className="mt-1">{aiLabel}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
