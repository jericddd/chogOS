import { connection } from "next/server";
import { Suspense } from "react";
import { CivilizationNav } from "@/components/shell/nav";
import { aiStatusLabel, readAppConfig } from "@/lib/config/env";

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
        <div className="mx-auto flex max-w-7xl items-end justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs tracking-[0.22em] text-accent uppercase">Monad · one civilization</p>
            <p className="mt-1 font-serif text-3xl leading-none tracking-tight sm:text-4xl">chogOS</p>
          </div>
          <Suspense
            fallback={
              <p className="text-right text-xs leading-5 text-muted">
                Always running
              </p>
            }
          >
            <HeaderStatus />
          </Suspense>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-3 sm:px-6">
          <Suspense fallback={<nav aria-label="Civilization" className="h-9" />}>
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

async function HeaderStatus() {
  await connection();
  let status: string | null = null;
  try {
    const label = aiStatusLabel(readAppConfig());
    if (!label.startsWith("Awaiting")) {
      status = label;
    }
  } catch {
    status = null;
  }
  return (
    <p className="shrink-0 text-right text-xs leading-5 text-muted">
      Always running
      {status ? (
        <>
          <br />
          {status}
        </>
      ) : null}
    </p>
  );
}
