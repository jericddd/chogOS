"use client";

import { useSyncExternalStore } from "react";

const channels = new Map<number, { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> }>();

function subscribe(intervalMs: number, listener: () => void): () => void {
  let channel = channels.get(intervalMs);
  if (!channel) {
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
      for (const notify of listeners) {
        notify();
      }
    }, intervalMs);
    channel = { listeners, timer };
    channels.set(intervalMs, channel);
  }
  channel.listeners.add(listener);
  const current = channel;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      channels.delete(intervalMs);
    }
  };
}

/**
 * Browser time rounded down to `intervalMs`, so repeated reads within one
 * interval return the same value. Returns 0 during server rendering and
 * hydration so time-dependent text never mismatches.
 */
export function useNow(intervalMs = 1_000): number {
  return useSyncExternalStore(
    (listener) => subscribe(intervalMs, listener),
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}
