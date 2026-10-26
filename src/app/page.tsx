import { connection } from "next/server";
import { Suspense } from "react";
import { LivingWorld } from "@/components/world/living-world";
import { loadAiRunView } from "@/lib/ai/run-status";
import { loadWorld, realtimeConfig } from "@/lib/world/load";

export default function WorldPage() {
  return (
    <Suspense fallback={<WorldLoading />}>
      <WorldLive />
    </Suspense>
  );
}

async function WorldLive() {
  await connection();
  const [world, aiRun] = await Promise.all([loadWorld(), loadAiRunView()]);
  return <LivingWorld initial={world} realtime={realtimeConfig()} aiRun={aiRun} />;
}

function WorldLoading() {
  return (
    <div className="world-stage h-[calc(100dvh-var(--shell-header))] min-h-[24rem] animate-pulse bg-[#07140c]" aria-busy="true" />
  );
}
