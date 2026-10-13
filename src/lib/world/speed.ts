/**
 * Simulation speed. The running value lives in world_state.speed and is read
 * from the database by every viewer. This module only supplies the value used
 * when the world is first initialized and the operator presets.
 *
 * Default 60x: one world hour is one real minute and one world day is 24 real
 * minutes. Chosen from `npm run world:speed-report` on the real engine with 59
 * citizens. In daytime 5-minute windows every citizen makes two or more
 * transitions and 17 to 27 events are written per minute. Between about 00:30
 * and 04:30 world time almost everyone sleeps, which is about 4 quiet minutes.
 */
export const SPEED_PRESETS = {
  demo: 60,
  calm: 20,
} as const;

export const DEFAULT_WORLD_SPEED = SPEED_PRESETS.demo;
export const MIN_WORLD_SPEED = 1;
export const MAX_WORLD_SPEED = 1000;

export function parseWorldSpeed(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_WORLD_SPEED;
  }
  if (value in SPEED_PRESETS) {
    return SPEED_PRESETS[value as keyof typeof SPEED_PRESETS];
  }
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < MIN_WORLD_SPEED || speed > MAX_WORLD_SPEED) {
    throw new Error(`Invalid world speed. Use a number from ${MIN_WORLD_SPEED} to ${MAX_WORLD_SPEED}, demo, or calm.`);
  }
  return Math.round(speed * 100) / 100;
}

/** "1 world hour = 1 min" style label for a speed multiplier. */
export function describeSpeed(speed: number): string {
  const realSecondsPerHour = 3600 / speed;
  const hour =
    realSecondsPerHour >= 60
      ? `${Math.round((realSecondsPerHour / 60) * 10) / 10} min`
      : `${Math.round(realSecondsPerHour)} s`;
  const dayMinutes = (24 * 3600) / speed / 60;
  const day = dayMinutes >= 120 ? `${Math.round((dayMinutes / 60) * 10) / 10} h` : `${Math.round(dayMinutes)} min`;
  return `${speed}× · 1 world hour = ${hour} · 1 world day = ${day}`;
}
