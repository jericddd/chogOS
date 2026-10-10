"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "World" },
  { href: "/citizens", label: "Citizens" },
  { href: "/treasury", label: "Treasury" },
  { href: "/activity", label: "History" },
  { href: "/enroll", label: "Enroll" },
  { href: "/economy", label: "Economy" },
  { href: "/businesses", label: "Businesses" },
] as const;

export function CivilizationNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Civilization" className="flex flex-wrap gap-2">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
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
