"use client";

import { ActivityFeed } from "@/components/world/activity-feed";
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
  return <ActivityFeed store={store} initialFilter={filter} mode="page" />;
}
