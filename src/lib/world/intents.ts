import "server-only";
import { getAddress } from "viem";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { validateProposal, type ActionProposal } from "@/lib/world/actions";

export type SubmitResult =
  | { ok: true; intentId: string }
  | { ok: false; reason: "invalid" | "unknown_citizen" | "pending_exists" | "unavailable"; detail: string };

/**
 * Queues a proposal for the next tick. Server-only and unused in Phase 3.
 * There is deliberately no HTTP route for this; the public cannot steer citizens.
 */
export async function submitIntent(proposal: ActionProposal): Promise<SubmitResult> {
  const valid = validateProposal(proposal);
  if (!valid.ok) {
    return { ok: false, reason: "invalid", detail: valid.reason };
  }
  const config = readAppConfig();
  const client = createServiceRoleClient();
  const { data: citizen, error: lookupError } = await client
    .from("citizens")
    .select("id")
    .eq("chain_id", config.chainId)
    .eq("nft_contract", getAddress(config.chogNftAddress))
    .eq("token_id", proposal.tokenId)
    .maybeSingle();
  if (lookupError) {
    return { ok: false, reason: "unavailable", detail: lookupError.message };
  }
  if (!citizen) {
    return { ok: false, reason: "unknown_citizen", detail: `No citizen holds token ${proposal.tokenId}.` };
  }
  const { data, error } = await client
    .from("world_intents")
    .insert({
      citizen_id: citizen.id,
      action: proposal.action,
      building_id: proposal.buildingId,
      source: proposal.source,
      decision_id: proposal.decisionId ?? null,
      expires_at: proposal.expiresAt ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      return { ok: false, reason: "pending_exists", detail: "This citizen already has a pending intent." };
    }
    return { ok: false, reason: "unavailable", detail: error.message };
  }
  return { ok: true, intentId: data.id as string };
}
