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
  return utcStamp(iso);
}

/** Real ages at or above this span use `Day N · HH:MM`. */
const LONG_REAL_SPAN_MS = 48 * 60 * 60 * 1000;

function utcStamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

export type WorldSecondSample = { atMs: number; worldS: number };

/**
 * World seconds on the current anchor segment. `world_s_at` uses this same
 * formula. A real time before `anchorReal` is an earlier segment, so this
 * returns null instead of skipping a paused gap. It does not clamp to the last tick.
 */
export function worldSecondsFromClock(
  clock: Pick<ClockView, "anchorReal" | "anchorWorldS" | "speed">,
  realMs: number,
): number | null {
  const anchor = ms(clock.anchorReal);
  if (!Number.isFinite(anchor) || !Number.isFinite(realMs) || !(clock.speed > 0) || realMs < anchor) {
    return null;
  }
  const projected = clock.anchorWorldS + Math.floor(((realMs - anchor) / 1000) * clock.speed);
  if (!Number.isFinite(projected) || projected < 0) {
    return null;
  }
  return projected;
}

/**
 * Project from a stored world second when the real gap is inside one runner
 * interval. A wider gap can hide a pause, so the caller keeps the row unset.
 */
export function worldSecondBesideSample(
  occurredMs: number,
  samples: readonly WorldSecondSample[],
  speed: number,
  maxGapSeconds: number,
): number | null {
  if (!Number.isFinite(occurredMs) || !(speed > 0) || !(maxGapSeconds >= 0)) {
    return null;
  }
  let best: WorldSecondSample | null = null;
  let bestGap = Infinity;
  for (const sample of samples) {
    if (!Number.isFinite(sample.atMs) || !Number.isFinite(sample.worldS)) {
      continue;
    }
    const gap = Math.abs(occurredMs - sample.atMs) / 1000;
    if (gap < bestGap) {
      best = sample;
      bestGap = gap;
    }
  }
  if (!best || bestGap > maxGapSeconds) {
    return null;
  }
  const projected = best.worldS + Math.floor(((occurredMs - best.atMs) / 1000) * speed);
  if (!Number.isFinite(projected) || projected < 0) {
    return null;
  }
  return projected;
}

export function resolveEventWorldSecond(
  occurredAt: string,
  storedWorldS: number | null,
  samples: readonly WorldSecondSample[],
  clock: Pick<ClockView, "anchorReal" | "anchorWorldS" | "speed" | "maxLagSeconds"> | null,
): number | null {
  if (storedWorldS != null && Number.isFinite(storedWorldS) && storedWorldS >= 0) {
    return storedWorldS;
  }
  const occurredMs = ms(occurredAt);
  if (!Number.isFinite(occurredMs) || !clock || !(clock.speed > 0)) {
    return null;
  }
  const near = worldSecondBesideSample(occurredMs, samples, clock.speed, clock.maxLagSeconds);
  if (near != null) {
    return near;
  }
  return worldSecondsFromClock(clock, occurredMs);
}

/**
 * A short real age stays relative. A span of two days or more uses
 * `Day N · HH:MM` from the stored world second, then from the current anchor.
 */
export function formatEventWhen(
  occurredAt: string,
  nowMs: number,
  worldS: number | null,
  clock?: ClockView | null,
): string {
  const parsed = ms(occurredAt);
  if (!(nowMs > 0) || !Number.isFinite(parsed)) {
    return utcStamp(occurredAt);
  }
  if (nowMs - parsed < LONG_REAL_SPAN_MS) {
    return formatRealAgo(occurredAt, nowMs);
  }
  const seconds = worldS ?? (clock ? worldSecondsFromClock(clock, parsed) : null);
  if (seconds == null) {
    return utcStamp(occurredAt);
  }
  return formatWorldTime(seconds);
}

/** Tick age. A stall of two real days or more shows the world time of that tick. */
export function formatTickAge(clock: ClockView, nowMs: number): string {
  const parsed = ms(clock.lastTickAt);
  if (!(nowMs > 0) || !Number.isFinite(parsed)) {
    return utcStamp(clock.lastTickAt);
  }
  if (nowMs - parsed < LONG_REAL_SPAN_MS) {
    return formatRealAgo(clock.lastTickAt, nowMs);
  }
  return formatWorldTime(clock.lastTickWorldS);
}
