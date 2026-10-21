export function PageHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <header className="mb-6">
      <h1 className="font-display text-lg leading-7 text-foreground sm:text-xl">{title}</h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-muted">{lede}</p>
    </header>
  );
}
