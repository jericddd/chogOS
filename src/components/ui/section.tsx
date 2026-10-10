import { Badge } from "@/components/ui/badge";

export function Section({
  title,
  tone = "plain",
  children,
}: {
  title: string;
  tone?: "plain" | "record" | "placeholder";
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-card px-4 py-5 sm:px-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-2xl tracking-tight">{title}</h2>
        {tone === "placeholder" ? <Badge>Placeholder</Badge> : null}
        {tone === "record" ? <Badge>Recorded 10 Oct 2026</Badge> : null}
      </div>
      {children}
    </section>
  );
}
