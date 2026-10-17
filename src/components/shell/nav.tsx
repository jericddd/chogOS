"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "World" },
  { href: "/citizens", label: "Citizens" },
  { href: "/treasury", label: "Treasury" },
  { href: "/activity", label: "History" },
  { href: "/verify", label: "Verify" },
  { href: "/enroll", label: "Enroll" },
] as const;

export function CivilizationNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Civilization"
      className="flex flex-nowrap gap-1 overflow-x-auto overscroll-x-contain pb-0.5 sm:gap-2"
    >
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-full px-2.5 py-1.5 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-3 sm:py-2 ${
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
