import { CivilizationNav } from "@/components/shell/nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-background text-foreground">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-4 py-5 sm:px-6">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Monad · one civilization</p>
            <p className="mt-1 font-serif text-3xl leading-none tracking-tight">Chog Civilization</p>
          </div>
          <p className="text-right text-xs leading-5 text-muted">
            Phase 0
            <br />
            Execution disabled
          </p>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:items-start">
        <CivilizationNav />
        <main id="content" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
