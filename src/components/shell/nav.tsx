"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Overview" },
  { href: "/citizens", label: "Citizens" },
  { href: "/economy", label: "Economy" },
  { href: "/businesses", label: "Businesses" },
  { href: "/activity", label: "Activity" },
] as const;

export function CivilizationNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Civilization" className="flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active ? "bg-accent-soft text-foreground" : "text-muted hover:bg-card hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
