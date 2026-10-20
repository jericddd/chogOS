import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEconomyVerifierClient, createServiceRoleClient } from "@/lib/db/client";
import { emptyLedger, interpretLedgerSnapshot, LEDGER_PENDING, LEDGER_UNREAD, utcDayStart, type EconomyLedger } from "@/lib/economy/ledger";
import { readAppConfig } from "@/lib/config/env";
import { persistEconomyDecision, type EconomyGateway, type PersistResult } from "@/lib/economy/persist";
import type { EconomicProposal, EconomyDecision } from "@/lib/economy/proposal";
import { receiptJournalArgs, receiptRpcArgs, settlementReadiness, settleRpcArgs } from "@/lib/economy/receipt";
import type { Hold } from "@/lib/economy/reserve";
import type { TreasurySnapshot } from "@/lib/economy/observe";
import { jsonRpcCaller, verifyMainnetReceipt, type RpcCaller } from "@/lib/economy/verify-receipt";

const LEDGER_TIMEOUT_MS = 4_000;

type DbError = { code?: string; message?: string };

const VERIFIER_UNSET = "The economy verifier is not configured. Set SUPABASE_ECONOMY_VERIFIER_KEY.";

export function openEconomyClient(): SupabaseClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}

/** Receipt, journal, and settlement client. Missing key returns null. It does not use the service role. */
export function openEconomyVerifierClient(): SupabaseClient | null {
  try {
    return createEconomyVerifierClient();
  } catch {
    return null;
  }
}

export type EconomyWriteOptions = {
  call?: RpcCaller;
  verifier?: SupabaseClient | null;
  reader?: SupabaseClient | null;
};

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
  key: string,
  txHash: string,
  options?: EconomyWriteOptions,
): Promise<ChainWriteResult> {
  const verified = await verifyMainnetReceipt({ txHash, call: options?.call ?? economyRpc() });
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
  const verifier = verifierFrom(options);
  if (!verifier) {
    return { ok: false, reason: VERIFIER_UNSET, verified: true };
  }
  const result = await callRpc(verifier, "economy_note_receipt", args.args);
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
  key: string,
  txHash: string,
  options?: EconomyWriteOptions,
): Promise<ChainWriteResult> {
  const verified = await verifyMainnetReceipt({ txHash, call: options?.call ?? economyRpc() });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, verified: false };
  }
  const args = settleRpcArgs(key, verified.receipt);
  if (!args.ok) {
    return { ok: false, reason: args.reason, verified: true };
  }
  const journal = receiptJournalArgs(verified.receipt);
  if (!journal.ok) {
    return { ok: false, reason: journal.reason, verified: true };
  }
  const verifier = verifierFrom(options);
  if (!verifier) {
    return { ok: false, reason: VERIFIER_UNSET, verified: true };
  }
  const reader = readerFrom(options);
  if (!reader) {
    return { ok: false, reason: "The proposal could not be read.", verified: true };
  }
  const current = await readSettlementRow(reader, key);
  if (!current.ok) {
    return { ok: false, reason: current.reason, verified: true };
  }
  const ready = settlementReadiness(current.row, verified.receipt.txHash);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason, verified: true };
  }
  const posted = await callRpc(verifier, "economy_append_journal", journal.args);
  if (!posted.ok) {
    return { ok: false, reason: "The receipt journal could not be recorded.", verified: true };
  }
  const journalBody = record(posted.data);
  if (!journalBody || journalBody.ok !== true) {
    return { ok: false, reason: text(journalBody?.reason) || "The receipt journal could not be recorded.", verified: true };
  }
  const result = await callRpc(verifier, "economy_settle_proposal", args.args);
  if (!result.ok) {
    return { ok: false, reason: "The proposal could not be settled.", verified: true };
  }
  const recorded = statusFrom(result.data);
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, verified: true };
  }
  return { ...recorded, verified: true };
}

function verifierFrom(options?: EconomyWriteOptions): SupabaseClient | null {
  if (options) {
    return options.verifier ?? null;
  }
  return openEconomyVerifierClient();
}

function readerFrom(options?: EconomyWriteOptions): SupabaseClient | null {
  if (options) {
    return options.reader ?? null;
  }
  return openEconomyClient();
}

async function readSettlementRow(
  client: SupabaseClient,
  key: string,
): Promise<{ ok: true; row: { status: string; txHash: string | null } | null } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);
  try {
    const { data, error } = await client
      .from("economy_proposals")
      .select("status, tx_hash")
      .eq("idempotency_key", key)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (error) {
      return { ok: false, reason: "The proposal could not be read." };
    }
    if (!data) {
      return { ok: true, row: null };
    }
    const body = data as { status?: unknown; tx_hash?: unknown };
    return {
      ok: true,
      row: {
        status: typeof body.status === "string" ? body.status : "",
        txHash: typeof body.tx_hash === "string" ? body.tx_hash : null,
      },
    };
  } catch {
    return { ok: false, reason: "The proposal could not be read." };
  } finally {
    clearTimeout(timer);
  }
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
    async tryHolds(holds, operationId) {
      const result = await callRpc(client, "economy_try_holds", {
        p_holds: { operationId, holds },
      });
      if (!result.ok) {
        return { ok: false, outcome: "deferred", reason: "The offchain reservation could not be saved." };
      }
      const body = record(result.data);
      if (!body || body.ok !== true) {
        const reported = text(body?.outcome);
        const outcome = reported === "insufficient_funds" || reported === "conflict" ? reported : "deferred";
        return { ok: false, outcome, reason: text(body?.reason) || "The offchain reservation could not be saved." };
      }
      return {
        ok: true,
        created: body.created === true,
        createdKeys: body.createdKeys,
        heldKeys: body.heldKeys,
        operationId: body.operationId,
      };
    },
    async release(proposalId, operationId) {
      const result = await callRpc(client, "economy_release_operation", {
        p_operation: operationId,
        p_proposal: proposalId,
      });
      if (!result.ok) {
        return { ok: false };
      }
      const body = record(result.data);
      return { ok: Boolean(body && body.ok === true) };
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
