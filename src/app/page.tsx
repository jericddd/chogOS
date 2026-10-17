import { connection } from "next/server";
import { Suspense } from "react";
import { AiDecisionsLink } from "@/components/world/ai-decisions-link";
import { LivingWorld } from "@/components/world/living-world";
import { loadWorld, realtimeConfig } from "@/lib/world/load";

export default function WorldPage() {
  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="text-xs tracking-[0.18em] text-accent uppercase">Chog Genesis · one civilization</p>
        <h1 className="mt-2 font-serif text-4xl tracking-tight sm:text-5xl">One shared world. Always running.</h1>
        <p className="mt-3 text-base leading-7 text-muted">
          A persistent town for Chog Genesis NFT participants on Monad. The server keeps it running whether anyone
          is watching. An AI mind can choose real actions here. Inspect those outcomes and verify the stored event
          bytes — map goods are simulated, not tokens.
        </p>
        <p className="mt-4">
          <AiDecisionsLink />
        </p>
      </header>
      <Suspense fallback={<WorldLoading />}>
        <WorldLive />
      </Suspense>
    </div>
  );
}

async function WorldLive() {
  await connection();
  const world = await loadWorld();
  return <LivingWorld initial={world} realtime={realtimeConfig()} />;
}

function WorldLoading() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-busy="true">
      <div className="h-[62vh] min-h-[340px] animate-pulse rounded-2xl border border-line bg-card sm:aspect-[3/2] sm:h-auto" />
      <div className="h-64 animate-pulse rounded-xl border border-line bg-card" />
    </div>
  );
}
