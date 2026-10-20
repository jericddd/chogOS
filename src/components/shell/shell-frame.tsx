"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CivilizationNav } from "@/components/shell/nav";

export function ShellFrame({ status, children }: { status: ReactNode; children: ReactNode }) {
  const home = usePathname() === "/";
  return (
    <div className="flex min-h-dvh flex-col text-foreground">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-40 focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-[var(--shell-header)] items-center gap-3 border-b-4 border-[var(--pixel-gold)] bg-[#1a2233] px-3">
        <Link href="/" className="font-display shrink-0 text-[0.7rem] leading-tight text-accent">
          chogOS
        </Link>
        <div className="min-w-0 flex-1">
          <CivilizationNav />
        </div>
        <div className="hidden shrink-0 sm:block">{status}</div>
      </header>
      <main id="content" className={home ? "min-w-0 flex-1" : "mx-auto min-w-0 w-full max-w-7xl flex-1 px-4 py-6 sm:px-6"}>
        {children}
      </main>
    </div>
  );
}
