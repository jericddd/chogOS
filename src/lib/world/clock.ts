import type { ClockView } from "@/lib/world/types";

export const WORLD_DAY_S = 86_400;

export type RunnerHealth = "live" | "delayed" | "stalled" | "paused";

function ms(iso: string): number {
  return Date.parse(iso);
}

/** Seconds after which a missing tick is shown as delayed. */
export function expectedTickSeconds(clock: ClockView): number {
  const gap = clock.lastTickGapS ?? 5;
  return Math.min(60, Math.max(1, gap));
}

export function runnerHealth(clock: ClockView, nowMs: number): RunnerHealth {
  if (clock.status === "paused") {
    return "paused";
  }
  const age = (nowMs - ms(clock.lastTickAt)) / 1000;
  if (age <= Math.max(20, expectedTickSeconds(clock) * 3)) {
    return "live";
  }
  if (age <= clock.maxLagSeconds) {
    return "delayed";
  }
  return "stalled";
}

/**
 * World seconds as the shared clock projects them at `nowMs`.
 * The projection stops where the server would pause the world, so a stopped
 * runner never shows time the simulation did not process.
 */
export function worldSecondsAt(clock: ClockView, nowMs: number): number {
  if (clock.status === "paused") {
    return clock.lastTickWorldS;
  }
  const limit = ms(clock.lastTickAt) + clock.maxLagSeconds * 1000;
  const t = Math.min(nowMs, limit);
  const projected = clock.anchorWorldS + ((t - ms(clock.anchorReal)) / 1000) * clock.speed;
  return Math.max(clock.lastTickWorldS, projected);
}

export function worldDay(worldS: number): number {
  return Math.floor(worldS / WORLD_DAY_S) + 1;
}

export function worldHour(worldS: number): number {
  return (((worldS % WORLD_DAY_S) + WORLD_DAY_S) % WORLD_DAY_S) / 3600;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatWorldClock(worldS: number): string {
  const ofDay = ((Math.floor(worldS) % WORLD_DAY_S) + WORLD_DAY_S) % WORLD_DAY_S;
  return `${pad(Math.floor(ofDay / 3600))}:${pad(Math.floor((ofDay % 3600) / 60))}`;
}

export function formatWorldTime(worldS: number): string {
  return `Day ${worldDay(worldS)} · ${formatWorldClock(worldS)}`;
}

export type DayPhase = "night" | "dawn" | "day" | "dusk";

export function dayPhase(worldS: number): DayPhase {
  const hour = worldHour(worldS);
  if (hour >= 5 && hour < 7) {
    return "dawn";
  }
  if (hour >= 7 && hour < 18.5) {
    return "day";
  }
  if (hour >= 18.5 && hour < 21) {
    return "dusk";
  }
  return "night";
}

/** 0 at full daylight, 1 at deep night. Smooth through dawn and dusk. */
export function darkness(worldS: number): number {
  const hour = worldHour(worldS);
  if (hour >= 7 && hour < 18.5) {
    return 0;
  }
  if (hour >= 5 && hour < 7) {
    return 1 - (hour - 5) / 2;
  }
  if (hour >= 18.5 && hour < 21) {
    return (hour - 18.5) / 2.5;
  }
  return 1;
}

export function formatWorldDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) {
    return `${minutes} world min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} world h` : `${hours} world h ${rest} min`;
}

export function formatRealAgo(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - ms(iso)) / 1000));
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
