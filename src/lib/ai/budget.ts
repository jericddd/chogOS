import type { AppConfig } from "@/lib/config/env";
import { AiProviderError } from "@/lib/ai/types";

export type UsageSnapshot = {
  hourInvocations: number;
  dayInvocations: number;
  haltUntil: string | null;
  haltReason: string | null;
};

export type BudgetDecision =
  | { ok: true }
  | { ok: false; code: "halted" | "hour" | "day"; reason: string };

function hourStart(now: Date): string {
  const copy = new Date(now);
  copy.setUTCMinutes(0, 0, 0);
  return copy.toISOString();
}

function dayStart(now: Date): string {
  const copy = new Date(now);
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

export function usagePeriods(now: Date = new Date()): { hour: string; day: string } {
  return { hour: hourStart(now), day: dayStart(now) };
}

export function evaluateBudget(config: AppConfig, usage: UsageSnapshot, now: Date = new Date()): BudgetDecision {
  if (usage.haltUntil && Date.parse(usage.haltUntil) > now.getTime()) {
    return {
      ok: false,
      code: "halted",
      reason: usage.haltReason ?? "Inference is halted after a provider quota or billing error.",
    };
  }
  if (usage.hourInvocations >= config.aiMaxDecisionsPerHour) {
    return {
      ok: false,
      code: "hour",
      reason: `Hourly decision budget of ${config.aiMaxDecisionsPerHour} is exhausted.`,
    };
  }
  if (usage.dayInvocations >= config.aiMaxDecisionsPerDay) {
    return {
      ok: false,
      code: "day",
      reason: `Daily decision budget of ${config.aiMaxDecisionsPerDay} is exhausted.`,
    };
  }
  return { ok: true };
}

export function haltFromError(error: AiProviderError, now: Date = new Date()): { until: string; reason: string } | null {
  if (!error.halt) {
    return null;
  }
  const until = new Date(now);
  if (error.code === "rate_limit") {
    until.setUTCMinutes(until.getUTCMinutes() + 15);
  } else if (error.code === "quota") {
    until.setUTCHours(24, 0, 0, 0);
    if (until.getTime() <= now.getTime()) {
      until.setUTCDate(until.getUTCDate() + 1);
    }
  } else {
    until.setUTCHours(until.getUTCHours() + 6);
  }
  return { until: until.toISOString(), reason: error.message };
}

export function assertNoPaidFallback(config: AppConfig): void {
  if (config.aiProvider === "none") {
    throw new AiProviderError("AI_PROVIDER is none.", "disabled", true);
  }
}
