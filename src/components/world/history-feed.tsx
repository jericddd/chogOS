"use client";

import { ActivityFeed } from "@/components/world/activity-feed";
import { GrowthDecisions } from "@/components/world/growth-decisions";
import { useLive } from "@/components/world/live-store";
import { useWorldStore } from "@/components/world/living-world";
import type { EventFilter, RealtimeConfig, WorldLoad } from "@/lib/world/types";

export function HistoryFeed({
  initial,
  realtime,
  filter,
}: {
  initial: WorldLoad;
  realtime: RealtimeConfig | null;
  filter: EventFilter;
}) {
  const store = useWorldStore(initial, realtime);
  const live = useLive(store);
  return (
    <div className="space-y-8">
      <GrowthDecisions clock={live.snapshot?.clock} />
      <ActivityFeed store={store} initialFilter={filter} mode="page" />
    </div>
  );
}
