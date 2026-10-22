import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { publishDecisionActivity } from "@/lib/ai/activity-event";
import {
  considerCitizenCommerce,
  type CitizenCommerceInsert,
  type CommerceCitizen,
  type CitizenCommerceConsideration,
} from "@/lib/ai/citizen-commerce";
import type { AiCompletion } from "@/lib/ai/types";
import { submitIntent } from "@/lib/world/intents";

const ADMITTED = new Set(["proposed", "accepted", "queued", "executed"]);

function verifiedWallet(output: unknown): { tokenId: string; wallet: string } | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const body = output as Record<string, unknown>;
  if (body.choice !== "issue" || body.verified !== true || body.onchain !== true) return null;
  const tokenId = typeof body.tokenId === "string" || typeof body.tokenId === "number" ? String(body.tokenId).split(".")[0] : "";
  if (!/^[0-9]+$/.test(tokenId)) return null;
  if (typeof body.address !== "string") return null;
  try {
    return { tokenId, wallet: getAddress(body.address) };
  } catch {
    return null;
  }
}

export async function loadCommerceContext(client: SupabaseClient): Promise<CommerceCitizen[] | null> {
  const wallets = await client
    .from("ai_decisions")
    .select("citizen_id, output")
    .eq("purpose", "wallet_issuance")
    .eq("status", "executed")
    .order("created_at", { ascending: true })
    .limit(400);
  if (wallets.error || !wallets.data) return null;
  const prior = await client
    .from("ai_decisions")
    .select("status, output, purpose")
    .in("purpose", ["citizen_trade", "citizen_return"])
    .order("created_at", { ascending: false })
    .limit(400);
  if (prior.error || !prior.data) return null;
  const traded = new Set<string>();
  const returned = new Set<string>();
  for (const row of prior.data as Array<Record<string, unknown>>) {
    if (!ADMITTED.has(String(row.status))) continue;
    const output = row.output && typeof row.output === "object" ? (row.output as Record<string, unknown>) : {};
    const tokenId = typeof output.tokenId === "string" || typeof output.tokenId === "number" ? String(output.tokenId).split(".")[0] : "";
    if (!/^[0-9]+$/.test(tokenId)) continue;
    if (row.purpose === "citizen_trade") traded.add(tokenId);
    if (row.purpose === "citizen_return") returned.add(tokenId);
  }
  const citizens: CommerceCitizen[] = [];
  const seen = new Set<string>();
  for (const row of wallets.data as Array<Record<string, unknown>>) {
    const wallet = verifiedWallet(row.output);
    if (!wallet || seen.has(wallet.tokenId) || typeof row.citizen_id !== "string") continue;
    seen.add(wallet.tokenId);
    const missing: Array<"trade" | "return"> = [];
    if (!traded.has(wallet.tokenId)) missing.push("trade");
    if (!returned.has(wallet.tokenId)) missing.push("return");
    if (missing.length === 0) continue;
    citizens.push({
      tokenId: wallet.tokenId,
      name: `Chog #${wallet.tokenId}`,
      citizenId: row.citizen_id,
      wallet: wallet.wallet,
      missing,
    });
  }
  citizens.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
  return citizens;
}

export async function recordCitizenCommerce(client: SupabaseClient, row: CitizenCommerceInsert): Promise<boolean> {
  const inserted = await client
    .from("ai_decisions")
    .insert({
      purpose: row.purpose,
      status: "proposed",
      citizen_id: row.citizenId,
      rationale: row.rationale,
      validation_result: row.fromModel
        ? "The model wrote this reason. No transaction was broadcast."
        : "A policy sentence was stored because the model did not return a usable reason. No transaction was broadcast.",
      provider: row.provider,
      model: row.model,
      output: {
        executed: false,
        onchain: false,
        verified: false,
        operation: row.purpose === "citizen_return" ? "return_capital" : "trade",
        tokenId: row.tokenId,
        wallet: row.wallet,
        walletVerified: true,
        chainId: 143,
        txHash: null,
        blockNumber: null,
        broadcast: false,
      },
    })
    .select("id")
    .maybeSingle();
  if (inserted.error || !inserted.data?.id) return false;
  await publishDecisionActivity(client, {
    id: inserted.data.id,
    citizenId: row.citizenId,
    purpose: row.purpose,
    status: "proposed",
    rationale: row.rationale,
    output: {
      tokenId: row.tokenId,
      wallet: row.wallet,
      walletVerified: true,
      executed: false,
      onchain: false,
      txHash: null,
    },
  });
  if (row.purpose === "citizen_trade") {
    try {
      await submitIntent({
        tokenId: row.tokenId,
        action: "shop",
        buildingId: "market",
        source: "ai",
        decisionId: inserted.data.id,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    } catch {
      return true;
    }
  }
  return true;
}

export async function storeCitizenCommerce(
  client: SupabaseClient,
  input: {
    provider: string;
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
    complete: ((request: { system: string; user: string; timeoutMs: number; maxOutputTokens: number }) => Promise<AiCompletion>) | null;
  },
): Promise<CitizenCommerceConsideration> {
  const citizens = await loadCommerceContext(client);
  if (citizens == null) {
    return { status: "failed", detail: "Citizen trade records could not be read. No transaction was broadcast.", promptChars: 0, outputTokens: 0, halt: null };
  }
  return considerCitizenCommerce({
    citizens,
    timeoutMs: input.timeoutMs,
    maxOutputTokens: input.maxOutputTokens,
    provider: input.provider,
    model: input.model,
    complete: input.complete,
    record: (row) => recordCitizenCommerce(client, row),
  });
}
