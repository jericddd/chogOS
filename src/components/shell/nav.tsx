"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { civilizationNavItems } from "@/components/shell/nav-items";

export function CivilizationNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Civilization"
      className="flex flex-nowrap gap-0.5 overflow-x-auto overscroll-x-contain pb-1 touch-pan-x [scrollbar-width:thin] [scrollbar-color:var(--line)_transparent] sm:gap-2 sm:pb-0.5 [&::-webkit-scrollbar]:h-0.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-line"
    >
      {civilizationNavItems.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-8 shrink-0 items-center rounded-full px-2 py-1.5 text-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:min-h-0 sm:px-3 sm:py-2 sm:text-sm ${
              active ? "bg-accent-soft text-accent" : "text-muted hover:bg-card hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
