import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD_SPEED, describeSpeed, parseWorldSpeed } from "@/lib/world/speed";
import { measureWindow } from "@/lib/world/speed-eval";

describe("default simulation speed", () => {
  it("is 60x and reads as one world hour per real minute", () => {
    expect(DEFAULT_WORLD_SPEED).toBe(60);
    expect(describeSpeed(60)).toBe("60× · 1 world hour = 1 min · 1 world day = 24 min");
    expect(parseWorldSpeed(undefined)).toBe(60);
    expect(parseWorldSpeed("calm")).toBe(20);
    expect(() => parseWorldSpeed("0")).toThrow();
    expect(() => parseWorldSpeed("5000")).toThrow();
  });

  it("shows movement within the first minute after setup", async () => {
    const window = await measureWindow(DEFAULT_WORLD_SPEED, 5 + 40 / 60, "setup", 120);
    expect(window.failed).toBe(0);
    expect(window.citizensChangedFirstMinute).toBeGreaterThanOrEqual(20);
    expect(window.peakWalking).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("gives a 5-minute daytime demo several transitions per citizen without flooding the feed", async () => {
    const window = await measureWindow(DEFAULT_WORLD_SPEED, 12, "midday", 300);
    expect(window.failed).toBe(0);
    expect(window.worldHoursElapsed).toBe(5);
    expect(window.citizensWithTwoTransitions).toBeGreaterThanOrEqual(50);
    expect(window.eventKinds).toBeGreaterThanOrEqual(5);
    expect(window.eventsPerMinute).toBeGreaterThanOrEqual(8);
    expect(window.eventsPerMinute).toBeLessThanOrEqual(45);
  }, 90_000);
});
