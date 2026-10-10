import { placeholderNotice } from "@/lib/placeholder/data";

export function PlaceholderNotice() {
  return (
    <aside
      role="note"
      className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm leading-6"
    >
      <p className="font-medium text-warning">Placeholder data</p>
      <p className="mt-1 text-foreground">{placeholderNotice}</p>
    </aside>
  );
}
