import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/client";
import { emptyLedger, interpretLedgerSnapshot, LEDGER_PENDING, LEDGER_UNREAD, utcDayStart, type EconomyLedger } from "@/lib/economy/ledger";
import { persistEconomyDecision, type EconomyGateway, type PersistResult } from "@/lib/economy/persist";
import type { EconomicProposal, EconomyDecision } from "@/lib/economy/proposal";
import { receiptRpcArgs, settleRpcArgs, type VerifiedReceipt } from "@/lib/economy/receipt";
import type { Hold } from "@/lib/economy/reserve";
import type { TreasurySnapshot } from "@/lib/economy/observe";

const LEDGER_TIMEOUT_MS = 4_000;

type DbError = { code?: string; message?: string };

export function openEconomyClient(): SupabaseClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}

export async function readEconomyLedger(client: SupabaseClient, nowMs: number): Promise<EconomyLedger> {
  const result = await callRpc(client, "economy_ledger_snapshot", { p_since: utcDayStart(nowMs) });
  if (!result.ok) {
    return emptyLedger(result.reason);
  }
  return interpretLedgerSnapshot(result.data);
}

export async function saveEconomyDecision(
  client: SupabaseClient,
  input: {
    proposal: EconomicProposal;
    decision: EconomyDecision;
    holds: readonly Hold[];
    observation: TreasurySnapshot;
  },
): Promise<PersistResult> {
  try {
    return await persistEconomyDecision(supabaseGateway(client), input);
  } catch {
    return { ok: false, reason: "The economic proposal could not be saved.", reserved: false };
  }
}

export async function noteVerifiedReceipt(
  client: SupabaseClient,
  key: string,
  evidence: VerifiedReceipt,
  reason: string,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  const args = receiptRpcArgs(key, evidence, reason);
  if (!args.ok) {
    return args;
  }
  const result = await callRpc(client, "economy_note_receipt", args.args);
  if (!result.ok) {
    return { ok: false, reason: "The receipt could not be recorded." };
  }
  return statusFrom(result.data);
}

export async function settleVerifiedProposal(
  client: SupabaseClient,
  key: string,
  evidence: VerifiedReceipt,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  const args = settleRpcArgs(key, evidence);
  if (!args.ok) {
    return args;
  }
  const result = await callRpc(client, "economy_settle_proposal", args.args);
  if (!result.ok) {
    return { ok: false, reason: "The proposal could not be settled." };
  }
  return statusFrom(result.data);
}

function supabaseGateway(client: SupabaseClient): EconomyGateway {
  return {
    async openProposal(row) {
      const result = await callRpc(client, "economy_open_proposal", { p_row: row });
      if (!result.ok) {
        return { ok: false, reason: "The economic proposal could not be saved." };
      }
      const body = record(result.data);
      if (!body || body.ok !== true || typeof body.id !== "string") {
        return { ok: false, reason: text(body?.reason) || "The economic proposal could not be saved." };
      }
      return { ok: true, id: body.id, created: body.created === true };
    },
    async applyStatus(input) {
      const result = await callRpc(client, "economy_apply_status", {
        p_key: input.key,
        p_status: input.status,
        p_reason: input.reason,
      });
      if (!result.ok) {
        return { ok: false, reason: "The proposal status could not be saved." };
      }
      const body = record(result.data);
      if (!body || body.ok !== true || typeof body.status !== "string") {
        return { ok: false, reason: text(body?.reason) || "The proposal status could not be saved." };
      }
      return { ok: true, status: body.status, duplicate: body.duplicate === true };
    },
    async tryHolds(holds) {
      const result = await callRpc(client, "economy_try_holds", { p_holds: holds });
      if (!result.ok) {
        return { ok: false, outcome: "deferred", reason: "The offchain reservation could not be saved." };
      }
      const body = record(result.data);
      if (!body || body.ok !== true) {
        const outcome = body?.outcome === "insufficient_funds" ? "insufficient_funds" : "deferred";
        return { ok: false, outcome, reason: text(body?.reason) || "The offchain reservation could not be saved." };
      }
      return { ok: true, created: body.created === true };
    },
    async release(proposalId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);
      try {
        const { error } = await client
          .from("economy_reservations")
          .update({ state: "released" })
          .eq("proposal_id", proposalId)
          .eq("state", "held")
          .abortSignal(controller.signal);
        return { ok: !error };
      } catch {
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function callRpc(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);
  try {
    const { data, error } = await client.rpc(fn, args).abortSignal(controller.signal);
    if (error) {
      return { ok: false, reason: reasonFor(error) };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: LEDGER_UNREAD };
  } finally {
    clearTimeout(timer);
  }
}

function reasonFor(error: DbError): string {
  const message = error.message ?? "";
  if (error.code === "PGRST202" || error.code === "PGRST205" || error.code === "42883" || /schema cache|does not exist|could not find the function/i.test(message)) {
    return LEDGER_PENDING;
  }
  return LEDGER_UNREAD;
}

function statusFrom(value: unknown): { ok: true; status: string } | { ok: false; reason: string } {
  const body = record(value);
  if (!body || body.ok !== true || typeof body.status !== "string") {
    return { ok: false, reason: text(body?.reason) || "The proposal could not be updated." };
  }
  return { ok: true, status: body.status };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
