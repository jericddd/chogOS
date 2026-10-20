import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/client";
import { emptyLedger, interpretLedgerSnapshot, LEDGER_PENDING, LEDGER_UNREAD, utcDayStart, type EconomyLedger } from "@/lib/economy/ledger";
import { readAppConfig } from "@/lib/config/env";
import { persistEconomyDecision, type EconomyGateway, type PersistResult } from "@/lib/economy/persist";
import type { EconomicProposal, EconomyDecision } from "@/lib/economy/proposal";
import { receiptRpcArgs, settleRpcArgs } from "@/lib/economy/receipt";
import type { Hold } from "@/lib/economy/reserve";
import type { TreasurySnapshot } from "@/lib/economy/observe";
import { jsonRpcCaller, verifyMainnetReceipt, type RpcCaller } from "@/lib/economy/verify-receipt";

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

export type ChainWriteResult =
  | { ok: true; status: string; duplicate: boolean; verified: true }
  | { ok: false; reason: string; verified: boolean };

/**
 * Confirm a submitted proposal from an independent mainnet receipt read.
 * The transaction hash is the only caller input. Receipt fields come from verifyMainnetReceipt.
 */
export async function confirmEconomyReceipt(
  client: SupabaseClient,
  key: string,
  txHash: string,
  call?: RpcCaller,
): Promise<ChainWriteResult> {
  const verified = await verifyMainnetReceipt({ txHash, call: call ?? economyRpc() });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, verified: false };
  }
  const reason =
    verified.receipt.status === "reverted"
      ? "The mainnet receipt reverted. No revenue was realized."
      : "The mainnet receipt succeeded. Settlement still requires a counted journal posting.";
  const args = receiptRpcArgs(key, verified.receipt, reason);
  if (!args.ok) {
    return { ok: false, reason: args.reason, verified: false };
  }
  const result = await callRpc(client, "economy_note_receipt", args.args);
  if (!result.ok) {
    return { ok: false, reason: "The receipt could not be recorded.", verified: true };
  }
  const recorded = statusFrom(result.data);
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, verified: true };
  }
  return { ...recorded, verified: true };
}

/**
 * Settle only after the same read-only check returns a successful receipt.
 * A reverted or unverified transaction never reaches economy_settle_proposal.
 */
export async function settleEconomyProposal(
  client: SupabaseClient,
  key: string,
  txHash: string,
  call?: RpcCaller,
): Promise<ChainWriteResult> {
  const verified = await verifyMainnetReceipt({ txHash, call: call ?? economyRpc() });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, verified: false };
  }
  const args = settleRpcArgs(key, verified.receipt);
  if (!args.ok) {
    return { ok: false, reason: args.reason, verified: true };
  }
  const result = await callRpc(client, "economy_settle_proposal", args.args);
  if (!result.ok) {
    return { ok: false, reason: "The proposal could not be settled.", verified: true };
  }
  const recorded = statusFrom(result.data);
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, verified: true };
  }
  return { ...recorded, verified: true };
}

function economyRpc(): RpcCaller {
  return jsonRpcCaller(readAppConfig().rpcUrl);
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
        const reported = text(body?.outcome);
        const outcome = reported === "insufficient_funds" || reported === "conflict" ? reported : "deferred";
        return { ok: false, outcome, reason: text(body?.reason) || "The offchain reservation could not be saved." };
      }
      const created = body.created === true;
      if (body.createdKeys === undefined) {
        return { ok: true, created };
      }
      return { ok: true, created, createdKeys: body.createdKeys };
    },
    async release(proposalId, keys) {
      const wanted = keys.filter((key) => key.length > 0);
      if (wanted.length === 0) {
        return { ok: true };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);
      try {
        const { error } = await client
          .from("economy_reservations")
          .update({ state: "released" })
          .eq("proposal_id", proposalId)
          .eq("state", "held")
          .in("idempotency_key", wanted)
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

function statusFrom(value: unknown): { ok: true; status: string; duplicate: boolean } | { ok: false; reason: string } {
  const body = record(value);
  if (!body || body.ok !== true || typeof body.status !== "string") {
    return { ok: false, reason: text(body?.reason) || "The proposal could not be updated." };
  }
  return { ok: true, status: body.status, duplicate: body.duplicate === true };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
