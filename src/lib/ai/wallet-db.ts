import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WalletIssuanceInsert, WalletRosterEntry } from "@/lib/ai/wallet-run";
import { loadTreasuryRoster } from "@/lib/ai/treasury-db";
import type { AppConfig } from "@/lib/config/env";
import { isAdmittedIssuanceStatus, lifecycleFromWalletStatus, type WalletLifecycle } from "@/lib/wallets/issuance";
import type { WalletStatus } from "@/lib/wallets/lifecycle";

const HASH = /^0x[0-9a-f]{64}$/;

const RANK: Record<WalletLifecycle, number> = {
  citizen_active: 0,
  wallet_issuance_proposed: 1,
  wallet_blocked: 2,
  wallet_assigned: 3,
  wallet_deployed: 4,
  wallet_ready: 5,
};

export type WalletIssuanceContext = {
  roster: WalletRosterEntry[];
  admittedDecisionIds: Set<string>;
};

export async function loadWalletIssuanceContext(
  client: SupabaseClient,
  config: AppConfig,
): Promise<WalletIssuanceContext | null> {
  const roster = await loadTreasuryRoster(client, config);
  if (roster == null) return null;
  const lifecycles = new Map<string, WalletLifecycle>();
  for (const entry of roster) lifecycles.set(entry.tokenId, "citizen_active");
  if (roster.length > 0) {
    const ids = roster.map((entry) => entry.citizenId).filter((id): id is string => Boolean(id));
    const registry = await client
      .from("citizen_wallet_registry")
      .select("citizen_id, status")
      .in("citizen_id", ids)
      .eq("chain_id", 143)
      .limit(48);
    if (registry.error) return null;
    const byId = new Map(roster.map((entry) => [entry.citizenId, entry.tokenId]));
    for (const row of (registry.data ?? []) as Array<Record<string, unknown>>) {
      const tokenId = byId.get(String(row.citizen_id));
      if (!tokenId) continue;
      const next = lifecycleFromWalletStatus(isWalletStatus(row.status) ? row.status : null);
      const previous = lifecycles.get(tokenId) ?? "citizen_active";
      if (RANK[next] >= RANK[previous]) lifecycles.set(tokenId, next);
    }
  }
  const prior = await client
    .from("ai_decisions")
    .select("status, output")
    .eq("purpose", "wallet_issuance")
    .order("created_at", { ascending: false })
    .limit(40);
  if (prior.error) return null;
  const admittedDecisionIds = new Set<string>();
  for (const row of (prior.data ?? []) as Array<Record<string, unknown>>) {
    if (!isAdmittedIssuanceStatus(String(row.status))) continue;
    const decisionId = readDecisionId(row.output);
    if (decisionId) admittedDecisionIds.add(decisionId);
  }
  return {
    roster: roster.map((entry) => ({
      tokenId: entry.tokenId,
      name: entry.name,
      goal: entry.goal,
      lifecycle: lifecycles.get(entry.tokenId) ?? "citizen_active",
      citizenId: entry.citizenId,
    })),
    admittedDecisionIds,
  };
}

export async function recordWalletIssuance(client: SupabaseClient, row: WalletIssuanceInsert): Promise<boolean> {
  const { error } = await client.from("ai_decisions").insert({
    purpose: row.purpose,
    status: row.status,
    citizen_id: row.citizenId,
    rationale: row.rationale,
    validation_result: row.validationResult,
    input_commitment: row.inputCommitment,
    provider: row.provider,
    model: row.model,
    output: row.output,
  });
  return !error;
}

export type StoredIssuance = {
  choice: "issue" | "defer" | "unnecessary" | null;
  lifecycle: WalletLifecycle | null;
  rationale: string | null;
  decisionId: string | null;
};

export async function loadLatestIssuance(client: SupabaseClient, citizenId: string): Promise<StoredIssuance | null | undefined> {
  const { data, error } = await client
    .from("ai_decisions")
    .select("rationale, output")
    .eq("purpose", "wallet_issuance")
    .eq("citizen_id", citizenId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return undefined;
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const output = row.output && typeof row.output === "object" && !Array.isArray(row.output) ? (row.output as Record<string, unknown>) : {};
  const choice = output.choice === "issue" || output.choice === "defer" || output.choice === "unnecessary" ? output.choice : null;
  const lifecycle = isLifecycle(output.lifecycle) ? output.lifecycle : null;
  const decisionId = typeof output.decisionId === "string" && HASH.test(output.decisionId) ? output.decisionId : null;
  const rationale = typeof row.rationale === "string" ? row.rationale : null;
  return { choice, lifecycle, rationale, decisionId };
}

function isWalletStatus(value: unknown): value is WalletStatus {
  return (
    value === "not_configured" ||
    value === "pending" ||
    value === "address_predicted" ||
    value === "deployment_pending" ||
    value === "deployed" ||
    value === "verified" ||
    value === "failed"
  );
}

function isLifecycle(value: unknown): value is WalletLifecycle {
  return (
    value === "citizen_active" ||
    value === "wallet_issuance_proposed" ||
    value === "wallet_assigned" ||
    value === "wallet_deployed" ||
    value === "wallet_ready" ||
    value === "wallet_blocked"
  );
}

function readDecisionId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.choice !== "issue") return null;
  const decisionId = typeof body.decisionId === "string" ? body.decisionId.toLowerCase() : "";
  return HASH.test(decisionId) ? decisionId : null;
}
