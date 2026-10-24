import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { economicPayoutReason } from "@/lib/chogbank/payout-reason";
import { MAINNET_WALLET_FACTORY } from "@/lib/wallets/issuer";
import { formatTokenAmount } from "@/lib/wallets/present";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKEN = /^[0-9]+$/;

type JsonValue = string | boolean | null;

export type ActivityDecision = {
  id: string;
  citizenId: string | null;
  purpose: string;
  status: string;
  rationale: string | null;
  output: unknown;
};

export type AiActivityDraft = {
  dedupeKey: string;
  kind: string;
  summary: string;
  citizenId: string | null;
  decisionId: string;
  payload: Record<string, JsonValue>;
  chainId: 143 | null;
  txHash: string | null;
  chainStatus: "offchain" | "confirmed";
  /** fill keeps an existing outcome. prefer points the decision at this chain row. */
  outcome: "fill" | "prefer";
};

function outputOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tokenOf(output: Record<string, unknown>): string | null {
  const tokenId = typeof output.tokenId === "string" || typeof output.tokenId === "number" ? String(output.tokenId).split(".")[0] : "";
  return TOKEN.test(tokenId) ? tokenId : null;
}

function checksum(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function citizenId(value: string | null): string | null {
  return value && UUID.test(value) ? value : null;
}

function basePayload(tokenId: string | null, extra: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    tokenId,
    factory: MAINNET_WALLET_FACTORY,
    genesis: addresses.chogGenesis,
    wallet: null,
    walletVerified: false,
    broadcast: false,
    blockNumber: null,
    asset: null,
    ...extra,
  };
}

/**
 * Activity rows for one stored decision.
 * A confirmed transaction is copied only after the issuer or the payout route has verified the receipt.
 * Trade and return rows stay offchain. A treasury payout row is inserted only for a verified distribution.
 */
export function activityDrafts(row: ActivityDecision): AiActivityDraft[] {
  if (!UUID.test(row.id)) return [];
  const output = outputOf(row.output);
  const tokenId = tokenOf(output);
  const actor = citizenId(row.citizenId);
  if (row.purpose === "wallet_issuance" && output.choice === "issue" && tokenId) {
    const drafts: AiActivityDraft[] = [
      {
        dedupeKey: `ai:wallet-decided:${row.id}`,
        kind: "wallet.decided",
        summary: `The AI mind decided to create a permanent wallet for Chog #${tokenId}.`,
        citizenId: actor,
        decisionId: row.id,
        chainId: null,
        txHash: null,
        chainStatus: "offchain",
        outcome: "fill",
        payload: basePayload(tokenId, {
          action: "create_wallet",
          note: "The wallet address is published when Monad confirms the wallet.",
        }),
      },
    ];
    const wallet = checksum(output.address);
    if (row.status === "executed" && output.verified === true && output.onchain === true && wallet) {
      const tx = typeof output.txHash === "string" && HASH.test(output.txHash) ? output.txHash.toLowerCase() : null;
      const block = typeof output.blockNumber === "string" && /^[0-9]+$/.test(output.blockNumber) ? output.blockNumber : null;
      drafts.push({
        dedupeKey: `ai:wallet-created:${tokenId}`,
        kind: "wallet.created",
        summary: tx
          ? `The AI mind created the permanent wallet for Chog #${tokenId} on Monad.`
          : `The AI mind confirmed the permanent wallet for Chog #${tokenId}. The wallet code was already on Monad, and this confirmation did not broadcast.`,
        citizenId: actor,
        decisionId: row.id,
        chainId: tx ? 143 : null,
        txHash: tx,
        chainStatus: tx ? "confirmed" : "offchain",
        outcome: "prefer",
        payload: basePayload(tokenId, {
          action: "create_wallet",
          wallet,
          walletVerified: true,
          broadcast: Boolean(tx),
          blockNumber: block,
          note: tx
            ? "Monad receipt matched AccountCreated for this decision."
            : "Wallet code was already on Monad. This confirmation did not broadcast.",
        }),
      });
    }
    return drafts;
  }
  if (row.purpose === "treasury_allocation") {
    const asset = output.asset === "MON" || output.asset === "CHOG" ? output.asset : null;
    const sending = row.status === "proposed" || row.status === "accepted" || row.status === "queued" || row.status === "executed";
    const who = tokenId ? ` to Chog #${tokenId}` : "";
    const assetLabel = asset ? ` ${asset}` : " funds";
    const tx = typeof output.txHash === "string" && HASH.test(output.txHash) ? output.txHash.toLowerCase() : null;
    const paid = row.status === "executed" && output.verified === true && output.onchain === true && tx != null;
    const amountRaw = typeof output.amountRaw === "string" && /^[0-9]+$/.test(output.amountRaw) ? output.amountRaw : null;
    const drafts: AiActivityDraft[] = [
      {
        dedupeKey: `ai:treasury:${row.id}`,
        kind: "treasury.allocation",
        summary: paid
          ? `The AI mind decided to send${assetLabel}${who}. The Monad receipt is stored with this decision.`
          : sending
            ? `The AI mind decided to send${assetLabel}${who}. No transaction was broadcast.`
            : `The AI mind decided not to send funds${who}. No transaction was broadcast.`,
        citizenId: actor,
        decisionId: row.id,
        chainId: null,
        txHash: null,
        chainStatus: "offchain",
        outcome: "fill",
        payload: basePayload(tokenId, {
          action: "send_funds",
          asset,
          note: paid ? "The Monad receipt is on the payout row." : "This decision did not broadcast a Monad transaction.",
        }),
      },
    ];
    if (paid && tokenId && asset && amountRaw) {
      const wallet = checksum(output.address);
      const block = typeof output.blockNumber === "string" && /^[0-9]+$/.test(output.blockNumber) ? output.blockNumber : null;
      const requested = typeof output.requestedAmountRaw === "string" && /^[0-9]+$/.test(output.requestedAmountRaw) ? output.requestedAmountRaw : null;
      const limited = requested != null && requested !== amountRaw;
      const paidLabel = formatTokenAmount(amountRaw, 18, asset === "CHOG" ? "$CHOG" : "MON");
      drafts.push({
        dedupeKey: `ai:treasury-paid:${row.id}`,
        kind: "treasury.paid",
        summary: limited
          ? `The AI mind sent ${paidLabel} to Chog #${tokenId}. The ChogBank cap limited this payment. Monad confirmed the distribution.`
          : `The AI mind sent ${paidLabel} to Chog #${tokenId}. Monad confirmed the ChogBank distribution.`,
        citizenId: actor,
        decisionId: row.id,
        chainId: 143,
        txHash: tx,
        chainStatus: "confirmed",
        outcome: "prefer",
        payload: basePayload(tokenId, {
          action: "send_funds",
          asset,
          amountRaw,
          requestedAmountRaw: requested,
          bank: MAINNET_CHOG_BANK,
          wallet,
          walletVerified: Boolean(wallet),
          broadcast: true,
          blockNumber: block,
          note: economicPayoutReason(output.reason) ?? "The stored world reason could not be shown.",
        }),
      });
    }
    return drafts;
  }
  if ((row.purpose === "citizen_trade" || row.purpose === "citizen_return") && tokenId) {
    const wallet = output.walletVerified === true ? checksum(output.wallet) : null;
    const returning = row.purpose === "citizen_return";
    return [
      {
        dedupeKey: returning ? `ai:citizen-return:${tokenId}` : `ai:citizen-trade:${tokenId}`,
        kind: returning ? "citizen.return" : "citizen.trade",
        summary: returning
          ? `The AI mind decided Chog #${tokenId} should return funds to ChogBank. No transaction was broadcast.`
          : `The AI mind decided Chog #${tokenId} should trade. No transaction was broadcast.`,
        citizenId: actor,
        decisionId: row.id,
        chainId: null,
        txHash: null,
        chainStatus: "offchain",
        outcome: "fill",
        payload: basePayload(tokenId, {
          action: returning ? "return_to_chogbank" : "trade",
          wallet,
          walletVerified: Boolean(wallet),
          note: returning
            ? "This return decision did not broadcast a Monad transaction."
            : "This trade decision did not broadcast a Monad transaction.",
        }),
      },
    ];
  }
  return [];
}

async function existingIds(client: SupabaseClient, keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let index = 0; index < keys.length; index += 40) {
    const slice = keys.slice(index, index + 40);
    const { data, error } = await client.from("civilization_events").select("id, dedupe_key").in("dedupe_key", slice);
    if (error || !data) continue;
    for (const row of data as Array<{ id?: string; dedupe_key?: string }>) {
      if (row.id && row.dedupe_key) found.set(row.dedupe_key, row.id);
    }
  }
  return found;
}

async function linkOutcome(client: SupabaseClient, draft: AiActivityDraft, eventId: string): Promise<void> {
  let query = client.from("ai_decisions").update({ outcome_event_id: eventId }).eq("id", draft.decisionId);
  if (draft.outcome === "fill") query = query.is("outcome_event_id", null);
  await query;
}

async function persistDrafts(client: SupabaseClient, drafts: AiActivityDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  const existing = await existingIds(client, drafts.map((draft) => draft.dedupeKey));
  for (const draft of drafts) {
    let id = existing.get(draft.dedupeKey) ?? null;
    if (!id) {
      const inserted = await client
        .from("civilization_events")
        .insert({
          dedupe_key: draft.dedupeKey,
          kind: draft.kind,
          category: "ai",
          source: "ai",
          summary: draft.summary,
          actor_citizen_id: draft.citizenId,
          decision_id: draft.decisionId,
          chain_id: draft.chainId,
          tx_hash: draft.txHash,
          chain_status: draft.chainStatus,
          payload: draft.payload,
          schema_version: 1,
        })
        .select("id")
        .maybeSingle();
      if (inserted.error && inserted.error.code !== "23505") continue;
      id = inserted.data?.id ?? null;
      if (!id && inserted.error?.code === "23505") {
        const again = await client.from("civilization_events").select("id").eq("dedupe_key", draft.dedupeKey).maybeSingle();
        id = (again.data?.id as string | undefined) ?? null;
      }
      if (id) existing.set(draft.dedupeKey, id);
    }
    if (id) await linkOutcome(client, draft, id);
  }
}

export async function publishDecisionActivity(client: SupabaseClient, row: ActivityDecision): Promise<void> {
  try {
    await persistDrafts(client, activityDrafts(row));
  } catch {
    return;
  }
}

/** Writes missing AI activity rows for decisions that are already stored. Safe to repeat. */
export async function publishStoredAiActivity(client: SupabaseClient): Promise<void> {
  try {
    const purposes = ["wallet_issuance", "treasury_allocation", "citizen_trade", "citizen_return"];
    const drafts: AiActivityDraft[] = [];
    for (const purpose of purposes) {
      const { data, error } = await client
        .from("ai_decisions")
        .select("id, citizen_id, purpose, status, rationale, output")
        .eq("purpose", purpose)
        .order("created_at", { ascending: false })
        .limit(400);
      if (error || !data) continue;
      for (const row of data as Array<Record<string, unknown>>) {
        drafts.push(
          ...activityDrafts({
            id: String(row.id ?? ""),
            citizenId: typeof row.citizen_id === "string" ? row.citizen_id : null,
            purpose: String(row.purpose ?? ""),
            status: String(row.status ?? ""),
            rationale: typeof row.rationale === "string" ? row.rationale : null,
            output: row.output,
          }),
        );
      }
    }
    await persistDrafts(client, drafts);
  } catch {
    return;
  }
}
