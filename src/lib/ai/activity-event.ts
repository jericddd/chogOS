import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { economicPayoutReason } from "@/lib/chogbank/payout-reason";
import { MAINNET_WALLET_FACTORY } from "@/lib/wallets/issuer";
import { classifyTransferReceipt, PUBLIC_TRANSFER_STATES, type PublicTransferState } from "@/lib/ai/transfer-decision";
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
  tokenId?: string | null;
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
  chainStatus: "offchain" | "submitted" | "confirmed";
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

function decisionToken(row: ActivityDecision, output: Record<string, unknown>): string | null {
  return tokenOf(output) ?? (row.tokenId ? tokenOf({ tokenId: row.tokenId }) : null);
}

function citizenAction(output: Record<string, unknown>): string {
  const action = typeof output.action === "string" ? output.action.trim() : "";
  return /^[a-z_]{1,32}$/.test(action) ? action : "";
}

const CITIZEN_TURN_STATUSES = new Set(["proposed", "queued", "accepted", "rejected", "failed", "executed"]);

function citizenTurnDrafts(row: ActivityDecision, output: Record<string, unknown>, worldConfirmed: boolean): AiActivityDraft[] {
  if (!CITIZEN_TURN_STATUSES.has(row.status)) return [];
  const tokenId = decisionToken(row, output);
  const actor = citizenId(row.citizenId);
  const action = citizenAction(output);
  const who = tokenId ? `Chog #${tokenId}` : "a citizen";
  const choice = action || "an action";
  const failed = row.status === "rejected" || row.status === "failed";
  const carriedOut = worldConfirmed && row.status === "executed";
  const summary = failed
    ? `The AI mind recorded a ${row.status} choice for ${who}. The simulation did not carry out an action.`
    : carriedOut
      ? `The AI mind chose ${choice} for ${who}. Completion is recorded on a separate activity row.`
      : row.status === "executed"
        ? `The AI mind chose ${choice} for ${who}. The simulation has not confirmed that this action was carried out.`
        : `The AI mind chose ${choice} for ${who}. This decision is ${row.status}. The simulation has not carried the action out.`;
  const drafts: AiActivityDraft[] = [
    {
      dedupeKey: `ai:citizen-turn:${row.id}`,
      kind: "ai.decision",
      summary,
      citizenId: actor,
      decisionId: row.id,
      chainId: null,
      txHash: null,
      chainStatus: "offchain",
      outcome: "fill",
      payload: basePayload(tokenId, {
        action: action || null,
        stage: row.status,
        executed: false,
        note: "This row is the decision. It is not a completed world action and it did not broadcast a transaction.",
      }),
    },
  ];
  if (carriedOut) {
    drafts.push({
      dedupeKey: `ai:citizen-turn-done:${row.id}`,
      kind: "ai.completed",
      summary: `The simulation carried out ${choice} for ${who}.`,
      citizenId: actor,
      decisionId: row.id,
      chainId: null,
      txHash: null,
      chainStatus: "offchain",
      outcome: "prefer",
      payload: basePayload(tokenId, {
        action: action || null,
        stage: "executed",
        executed: true,
        note: "A world event for this decision confirmed the action. This row is not an onchain transfer.",
      }),
    });
  }
  return drafts;
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

function namedState(value: unknown): PublicTransferState | null {
  return typeof value === "string" && (PUBLIC_TRANSFER_STATES as readonly string[]).includes(value) ? (value as PublicTransferState) : null;
}

function textValue(value: unknown): string | null {
  if (Array.isArray(value)) return textValue(value.filter((item) => typeof item === "string").join(" "));
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 320);
  return text || null;
}

function clipText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function factSentence(output: Record<string, unknown>): string {
  const text = textValue(output.factSummaries);
  return text ? ` Facts: ${text.slice(0, 180)}` : "";
}

function treasurySummary(input: {
  paid: boolean;
  sending: boolean;
  publicState: PublicTransferState | null;
  rationale: string | null;
  assetLabel: string;
  who: string;
  reason: string | null;
}): string {
  if (input.paid) return `The AI mind decided to send${input.assetLabel}${input.who}. The Monad receipt is stored with this decision.`;
  if (input.publicState === "approved_awaiting_execution" || input.publicState === "proposed") {
    const because = input.reason ? ` ${clipText(input.reason)}` : "";
    return `Approved and awaiting execution: send${input.assetLabel}${input.who}.${because} No transaction was broadcast.`;
  }
  if (input.publicState === "submitted_pending") {
    return `Submitted and pending confirmation: send${input.assetLabel}${input.who}. The transaction is not confirmed.`;
  }
  if (input.publicState === "failed_execution") {
    return `Failed during execution: the payout${input.who} did not succeed. ${clipText(input.rationale ?? "")}`.trim();
  }
  if (input.publicState === "deferred") {
    return `Deferred: no payout${input.who}. ${clipText(input.rationale ?? "")} No transaction was broadcast.`.replace(/\s+/g, " ").trim();
  }
  if (input.publicState === "no_allocation") {
    return `No allocation was made${input.who}. ${clipText(input.rationale ?? "")} No transaction was broadcast.`.replace(/\s+/g, " ").trim();
  }
  if (input.publicState === "technical_failure" || /not JSON|could not be read/i.test(input.rationale ?? "")) {
    return "Technical failure: the payment proposal could not be read, so no citizen was paid. No transaction was sent.";
  }
  if (input.sending) return `The AI mind decided to send${input.assetLabel}${input.who}. No transaction was broadcast.`;
  return `The AI mind decided not to send funds${input.who}. No transaction was broadcast.`;
}

function citizenSummary(state: PublicTransferState, returning: boolean, route: string, rationale: string | null, confirmed: boolean): string {
  const reason = clipText(rationale ?? "");
  if (confirmed) return `Confirmed successful: ${route}. ${reason}`.trim();
  if (state === "submitted_pending") return `Submitted and pending confirmation: ${route}. The transaction is not confirmed.`;
  if (state === "failed_execution") return `Failed during execution: ${route}. ${reason} No successful receipt was stored.`.replace(/\s+/g, " ").trim();
  if (state === "deferred") return `Deferred: ${route}. ${reason} No transaction was broadcast.`.replace(/\s+/g, " ").trim();
  if (state === "no_allocation") return `No allocation was made. ${reason} No transaction was broadcast.`.replace(/\s+/g, " ").trim();
  if (state === "technical_failure") return `Technical failure: ${reason || "the transfer proposal could not be read."} No citizen transfer was proposed.`;
  if (state === "approved_awaiting_execution") return `Approved and awaiting execution: ${route}. No transaction was broadcast.`;
  return returning
    ? `Proposed: ${route}. No transaction was broadcast. This is not a completed return to ChogBank.`
    : `Proposed: ${route}. No transaction was broadcast. This is not a completed purchase.`;
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
export function activityDrafts(row: ActivityDecision, options?: { worldConfirmed?: boolean }): AiActivityDraft[] {
  if (!UUID.test(row.id)) return [];
  const output = outputOf(row.output);
  const tokenId = decisionToken(row, output);
  const actor = citizenId(row.citizenId);
  if (row.purpose === "citizen_turn") {
    return citizenTurnDrafts(row, output, options?.worldConfirmed === true);
  }
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
    const publicState = paid ? "confirmed" : namedState(output.publicState);
    const drafts: AiActivityDraft[] = [
      {
        dedupeKey: `ai:treasury:${row.id}`,
        kind: "treasury.allocation",
        summary: treasurySummary({
          paid,
          sending,
          publicState,
          rationale: row.rationale,
          assetLabel,
          who,
          reason: typeof output.reason === "string" ? output.reason : null,
        }),
        citizenId: actor,
        decisionId: row.id,
        chainId: null,
        txHash: null,
        chainStatus: "offchain",
        outcome: "fill",
        payload: basePayload(tokenId, {
          action: "send_funds",
          asset,
          publicState,
          direction: "chogbank_to_citizen",
          factSummaries: textValue(output.factSummaries),
          note: paid
            ? "The Monad receipt is on the payout row."
            : publicState === "technical_failure"
              ? (row.rationale ?? "The payment proposal could not be read.").slice(0, 320)
              : "This decision did not broadcast a Monad transaction.",
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
          ? `Confirmed successful. The AI mind sent ${paidLabel} from ChogBank to Chog #${tokenId}. The ChogBank cap limited this payment. Monad confirmed the distribution.${factSentence(output)}`
          : `Confirmed successful. The AI mind sent ${paidLabel} from ChogBank to Chog #${tokenId}. Monad confirmed the ChogBank distribution.${factSentence(output)}`,
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
          publicState: "confirmed",
          direction: "chogbank_to_citizen",
          factSummaries: textValue(output.factSummaries),
          note: economicPayoutReason(output.reason) ?? "The stored world reason could not be shown.",
        }),
      });
    }
    return drafts;
  }
  if (row.purpose === "citizen_trade" || row.purpose === "citizen_return") {
    const wallet = output.walletVerified === true ? checksum(output.wallet) : null;
    const returning = row.purpose === "citizen_return" || output.direction === "citizen_to_chogbank";
    const state = namedState(output.publicState) ?? "proposed";
    const modern = namedState(output.publicState) != null;
    const other = tokenOf({ tokenId: output.recipientTokenId ?? output.relatedTokenId });
    const amountRaw = typeof output.amountRaw === "string" && /^[0-9]+$/.test(output.amountRaw) ? output.amountRaw : null;
    const hash = typeof output.txHash === "string" && HASH.test(output.txHash) ? output.txHash.toLowerCase() : null;
    const sender = checksum(output.wallet);
    const recipient = checksum(output.recipientWallet) ?? (returning ? checksum(output.bank) : null);
    const receiptState =
      state === "confirmed" || state === "submitted_pending" || state === "failed_execution"
        ? classifyTransferReceipt({
            expected: {
              asset: "MON",
              amountRaw: amountRaw ?? "",
              sender: sender ?? "",
              recipient: recipient ?? "",
            },
            receipt: hash
              ? {
                  chainId: output.chainId === 143 ? 143 : 0,
                  txHash: hash,
                  status: output.receiptStatus === "success" || output.receiptStatus === "reverted" || output.receiptStatus === "unknown" ? output.receiptStatus : null,
                  sender,
                  recipient,
                  amountRaw,
                  asset: output.asset === "MON" ? "MON" : null,
                  logMatched: output.logMatched === true,
                }
              : null,
          })
        : "not_confirmed";
    const confirmed = receiptState === "confirmed";
    const pending = state === "submitted_pending" && receiptState === "submitted_pending";
    const shown: PublicTransferState = confirmed
      ? "confirmed"
      : receiptState === "failed_execution" || state === "confirmed"
        ? "failed_execution"
        : pending
          ? "submitted_pending"
          : state;
    const who = tokenId ? `Chog #${tokenId}` : "A citizen";
    const counterparty = other ? `Chog #${other}` : returning ? "ChogBank" : "another citizen";
    const amount = amountRaw ? formatTokenAmount(amountRaw, 18, "MON") : null;
    const route = amount ? `${who} to ${counterparty}, ${amount}` : `${who} to ${counterparty}`;
    const summary = citizenSummary(shown, returning, route, row.rationale, confirmed);
    return [
      {
        dedupeKey: modern
          ? `${returning ? "ai:citizen-return" : "ai:citizen-trade"}:${row.id}`
          : tokenId
            ? returning
              ? `ai:citizen-return:${tokenId}`
              : `ai:citizen-trade:${tokenId}`
            : `ai:citizen-transfer:${row.id}`,
        kind: returning ? "citizen.return" : "citizen.trade",
        summary,
        citizenId: actor,
        decisionId: row.id,
        chainId: confirmed || pending ? 143 : null,
        txHash: confirmed || pending ? hash : null,
        chainStatus: confirmed ? "confirmed" : pending ? "submitted" : "offchain",
        outcome: confirmed ? "prefer" : "fill",
        payload: basePayload(tokenId, {
          action: returning ? "return_to_chogbank" : "trade",
          direction: returning ? "citizen_to_chogbank" : "citizen_to_citizen",
          publicState: shown,
          relatedTokenId: other,
          amountRaw,
          asset: output.asset === "MON" ? "MON" : null,
          wallet,
          walletVerified: Boolean(wallet),
          factSummaries: textValue(output.factSummaries),
          limitation: textValue(output.limitation),
          bank: returning ? MAINNET_CHOG_BANK : null,
          broadcast: confirmed,
          note: confirmed
            ? "Monad receipt matched this citizen transfer."
            : "This row did not broadcast a confirmed Monad transaction.",
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

async function worldEventConfirms(client: SupabaseClient, decisionId: string): Promise<boolean> {
  const { data, error } = await client.from("civilization_events").select("kind").eq("decision_id", decisionId).limit(40);
  if (error || !Array.isArray(data)) return false;
  return data.some((item) => {
    const kind = item && typeof item === "object" && "kind" in item ? String((item as { kind?: unknown }).kind ?? "") : "";
    return kind.length > 0 && kind !== "ai.decision" && kind !== "ai.completed";
  });
}

export async function publishDecisionActivity(client: SupabaseClient, row: ActivityDecision): Promise<void> {
  try {
    const worldConfirmed = row.purpose === "citizen_turn" && row.status === "executed" ? await worldEventConfirms(client, row.id) : false;
    await persistDrafts(client, activityDrafts(row, { worldConfirmed }));
  } catch {
    return;
  }
}

async function tokenIdsFor(client: SupabaseClient, citizenIds: string[]): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const ids = [...new Set(citizenIds.filter((id) => UUID.test(id)))];
  if (ids.length === 0) return tokens;
  const { data, error } = await client.from("citizens").select("id, token_id").in("id", ids);
  if (error || !Array.isArray(data)) return tokens;
  for (const row of data as Array<{ id?: string; token_id?: string | number }>) {
    if (!row.id || row.token_id == null) continue;
    const tokenId = String(row.token_id).split(".")[0];
    if (TOKEN.test(tokenId)) tokens.set(row.id, tokenId);
  }
  return tokens;
}

/** Writes missing AI activity rows for decisions that are already stored. Safe to repeat. */
export async function publishStoredAiActivity(client: SupabaseClient): Promise<void> {
  try {
    const purposes = ["wallet_issuance", "treasury_allocation", "citizen_trade", "citizen_return", "citizen_turn"];
    for (const purpose of purposes) {
      const { data, error } = await client
        .from("ai_decisions")
        .select("id, citizen_id, purpose, status, rationale, output")
        .eq("purpose", purpose)
        .order("created_at", { ascending: false })
        .limit(400);
      if (error || !data) continue;
      const rows = data as Array<Record<string, unknown>>;
      const tokens =
        purpose === "citizen_turn"
          ? await tokenIdsFor(
              client,
              rows.map((row) => (typeof row.citizen_id === "string" ? row.citizen_id : "")),
            )
          : new Map<string, string>();
      for (const row of rows) {
        const citizen = typeof row.citizen_id === "string" ? row.citizen_id : null;
        await publishDecisionActivity(client, {
          id: String(row.id ?? ""),
          citizenId: citizen,
          purpose: String(row.purpose ?? ""),
          status: String(row.status ?? ""),
          rationale: typeof row.rationale === "string" ? row.rationale : null,
          output: row.output,
          tokenId: citizen ? (tokens.get(citizen) ?? null) : null,
        });
      }
    }
  } catch {
    return;
  }
}
