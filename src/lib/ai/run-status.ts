import "server-only";
import {
  AI_CITIZEN_PANEL_LIMIT,
  describeAiRun,
  type AiRunView,
  type SchedulerRecord,
  type StoredDecisionRecord,
} from "@/lib/ai/run-record";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function schedulerFrom(row: unknown): SchedulerRecord | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  return {
    lastRunAt: text(record.last_run_at),
    lastSuccessAt: text(record.last_success_at),
    lastError: text(record.last_error),
    haltUntil: text(record.halt_until),
    haltReason: text(record.halt_reason),
  };
}

function decisionFrom(row: unknown): StoredDecisionRecord | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    status: typeof record.status === "string" ? record.status : "",
    purpose: typeof record.purpose === "string" ? record.purpose : "",
    rationale: text(record.rationale),
    output: record.output,
    createdAt: text(record.created_at),
  };
}

function decisionsFrom(data: unknown): StoredDecisionRecord[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const decision = decisionFrom(row);
    return decision ? [decision] : [];
  });
}

const CITIZEN_PANEL_STATUSES = ["queued", "accepted", "proposed", "executed", "rejected", "failed"];

/**
 * Reads the scheduler row, the newest decision of any purpose, and recent citizen turns.
 * The newest row can be a later wallet proposal. Citizen turns are loaded on their own
 * so that row does not hide them. Missing data stays missing.
 */
export async function loadAiRunView(): Promise<AiRunView> {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return describeAiRun({ configured: false, readable: false, scheduler: null, decision: null });
  }
  try {
    const client = createServiceRoleClient({ timeoutMs: 8_000 });
    const [schedulerResult, decisionResult, citizenResult] = await Promise.all([
      client
        .from("ai_scheduler_state")
        .select("last_run_at, last_success_at, last_error, halt_until, halt_reason")
        .eq("singleton", true)
        .maybeSingle(),
      client
        .from("ai_decisions")
        .select("id, status, purpose, rationale, output, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from("ai_decisions")
        .select("id, status, purpose, rationale, output, created_at")
        .eq("purpose", "citizen_turn")
        .in("status", CITIZEN_PANEL_STATUSES)
        .order("created_at", { ascending: false })
        .limit(AI_CITIZEN_PANEL_LIMIT),
    ]);
    if (schedulerResult.error && decisionResult.error) {
      return describeAiRun({ configured: true, readable: false, scheduler: null, decision: null });
    }
    return describeAiRun({
      configured: true,
      readable: true,
      scheduler: schedulerResult.error ? null : schedulerFrom(schedulerResult.data),
      decision: decisionResult.error ? null : decisionFrom(decisionResult.data),
      citizenDecisions: citizenResult.error ? [] : decisionsFrom(citizenResult.data),
    });
  } catch {
    return describeAiRun({ configured: true, readable: false, scheduler: null, decision: null });
  }
}
