import { Suspense } from "react";
import { CivilizationNav } from "@/components/shell/nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full text-foreground">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4 px-4 py-5 sm:px-6">
          <div>
            <p className="text-xs tracking-[0.22em] text-accent uppercase">Monad · one civilization</p>
            <p className="mt-1 font-serif text-4xl leading-none tracking-tight">chogOS</p>
          </div>
          <p className="text-right text-xs leading-5 text-muted">
            Genesis founded
            <br />
            Awaiting AI activation
          </p>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-4 sm:px-6">
          <Suspense fallback={<nav aria-label="Civilization" className="h-10" />}>
            <CivilizationNav />
          </Suspense>
        </div>
      </header>
      <main id="content" className="mx-auto min-w-0 max-w-7xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
