import {
  FLASH_DAILY_CAP,
  FLASH_GAP_MS,
  FLASH_RPM,
  LITE_DAILY_CAP,
  LITE_RPM,
  modelTier,
} from "@/lib/ai/model-route";
import { AiProviderError } from "@/lib/ai/types";

export type ModelTier = "flash" | "lite";
export type QuotaCode = "day" | "spacing" | "rpm" | "invalid";

export type QuotaDecision = {
  ok: boolean;
  code?: QuotaCode;
  attempts: number;
  minuteAttempts: number;
  retryAtMs?: number;
};

type DaySlot = { attempts: number; lastAtMs: number | null };

export type QuotaState = {
  days: Map<string, DaySlot>;
  minutes: Map<string, number>;
};

const PACIFIC = "America/Los_Angeles";

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

/** Start of the Google quota day: midnight in America/Los_Angeles, including daylight-saving time. */
export function pacificDayStartMs(nowMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const local = formatter.formatToParts(new Date(nowMs));
  const year = part(local, "year");
  const month = part(local, "month");
  const day = part(local, "day");
  const probe = Date.parse(`${year}-${month}-${day}T12:00:00Z`);
  const probed = formatter.formatToParts(new Date(probe));
  const hour = Number(part(probed, "hour") === "24" ? "0" : part(probed, "hour"));
  const minute = Number(part(probed, "minute"));
  const localMinutes = hour * 60 + minute;
  const probeDay = `${part(probed, "year")}-${part(probed, "month")}-${part(probed, "day")}`;
  const target = `${year}-${month}-${day}`;
  return probeDay === target ? probe - localMinutes * 60_000 : probe + (24 * 60 - localMinutes) * 60_000;
}

function caps(tier: ModelTier): { day: number; rpm: number; gapMs: number } {
  if (tier === "flash") return { day: FLASH_DAILY_CAP, rpm: FLASH_RPM, gapMs: FLASH_GAP_MS };
  return { day: LITE_DAILY_CAP, rpm: LITE_RPM, gapMs: 0 };
}

function dayKey(tier: ModelTier, nowMs: number): string {
  return `${tier}:${pacificDayStartMs(nowMs)}`;
}

function minuteKey(tier: ModelTier, nowMs: number): string {
  return `${tier}:${Math.floor(nowMs / 60_000) * 60_000}`;
}

export function createQuotaState(): QuotaState {
  return { days: new Map(), minutes: new Map() };
}

/**
 * Same admission rules as ai_reserve_model_attempt.
 * A refused call does not increment either counter.
 */
export function reserveOnLedger(state: QuotaState, tier: ModelTier, nowMs: number): QuotaDecision {
  const limit = caps(tier);
  const dayId = dayKey(tier, nowMs);
  const minuteId = minuteKey(tier, nowMs);
  const day = state.days.get(dayId) ?? { attempts: 0, lastAtMs: null };
  const minuteAttempts = state.minutes.get(minuteId) ?? 0;
  if (day.attempts >= limit.day) {
    return { ok: false, code: "day", attempts: day.attempts, minuteAttempts };
  }
  if (limit.gapMs > 0 && day.lastAtMs != null && nowMs < day.lastAtMs + limit.gapMs) {
    return {
      ok: false,
      code: "spacing",
      attempts: day.attempts,
      minuteAttempts,
      retryAtMs: day.lastAtMs + limit.gapMs,
    };
  }
  if (minuteAttempts >= limit.rpm) {
    return { ok: false, code: "rpm", attempts: day.attempts, minuteAttempts };
  }
  const nextDay = { attempts: day.attempts + 1, lastAtMs: limit.gapMs > 0 ? nowMs : day.lastAtMs };
  state.days.set(dayId, nextDay);
  state.minutes.set(minuteId, minuteAttempts + 1);
  return { ok: true, attempts: nextDay.attempts, minuteAttempts: minuteAttempts + 1 };
}

/** Serializes overlapping reserves the way the SQL row lock does. */
export class SharedQuotaLedger {
  private readonly state = createQuotaState();
  private tail: Promise<void> = Promise.resolve();

  reserve(tier: ModelTier, nowMs: number): Promise<QuotaDecision> {
    const run = this.tail.then(() => reserveOnLedger(this.state, tier, nowMs));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  closeDay(tier: ModelTier, nowMs: number): void {
    const limit = caps(tier);
    const id = dayKey(tier, nowMs);
    const day = this.state.days.get(id) ?? { attempts: 0, lastAtMs: null };
    this.state.days.set(id, { attempts: Math.max(day.attempts, limit.day), lastAtMs: day.lastAtMs });
  }
}

export type ModelQuotaClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

function readBody(data: unknown): { ok?: boolean; code?: string } | null {
  if (typeof data === "string") {
    try {
      return readBody(JSON.parse(data) as unknown);
    } catch {
      return null;
    }
  }
  if (data && typeof data === "object") return data as { ok?: boolean; code?: string };
  return null;
}

/** Reserves one outbound attempt. A missing ledger or a closed slot throws before any network call. */
export async function reserveModelAttempt(client: ModelQuotaClient, model: string, now: Date = new Date()): Promise<void> {
  const tier = modelTier(model);
  let data: unknown;
  let error: { message?: string } | null = null;
  try {
    const result = await client.rpc("ai_reserve_model_attempt", { p_tier: tier, p_now: now.toISOString() });
    data = result.data;
    error = result.error;
  } catch {
    throw new AiProviderError("The shared model ledger is unavailable, so this request was not sent.", "unavailable", false);
  }
  if (error) {
    throw new AiProviderError("The shared model ledger is unavailable, so this request was not sent.", "unavailable", false);
  }
  const body = readBody(data);
  if (body?.ok === true) return;
  if (body?.code === "day") {
    throw new AiProviderError("The shared daily model budget is closed for this model.", "quota", false);
  }
  if (body?.code === "spacing" || body?.code === "rpm") {
    throw new AiProviderError("The shared model slot is not open.", "rate_limit", false);
  }
  throw new AiProviderError("The shared model ledger is unavailable, so this request was not sent.", "unavailable", false);
}

/** Stops the rest of this quota day for one tier after Google reports that tier's daily cap. */
export async function closeModelDay(client: ModelQuotaClient, modelOrTier: string, now: Date = new Date()): Promise<void> {
  const tier = modelOrTier === "flash" || modelOrTier === "lite" ? modelOrTier : modelTier(modelOrTier);
  try {
    await client.rpc("ai_close_model_day", { p_tier: tier, p_now: now.toISOString() });
  } catch {
    return;
  }
}
