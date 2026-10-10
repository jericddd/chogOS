export function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted">
      {children}
    </span>
  );
}
