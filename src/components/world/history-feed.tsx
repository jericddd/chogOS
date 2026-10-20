"use client";

import { ActivityFeed } from "@/components/world/activity-feed";
import { GrowthDecisions } from "@/components/world/growth-decisions";
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
  return (
    <div className="space-y-8">
      <GrowthDecisions />
      <ActivityFeed store={store} initialFilter={filter} mode="page" />
    </div>
  );
}
