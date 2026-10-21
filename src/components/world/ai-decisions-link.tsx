import Link from "next/link";

/** Discovery link to genuine `source=ai` history. No invented counts. */
export function AiDecisionsLink() {
  return (
    <Link
      href="/activity?source=ai"
      className="inline-flex max-w-full items-center border border-violet/50 px-3 py-1.5 text-xs whitespace-nowrap text-violet hover:bg-card"
    >
      AI decisions
    </Link>
  );
}
