import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WalletIssuanceInsert, WalletRosterEntry } from "@/lib/ai/wallet-run";
import { loadTreasuryRoster } from "@/lib/ai/treasury-db";
import type { AppConfig } from "@/lib/config/env";
import {
  ADMITTED_ISSUANCE_STATUSES,
  isAdmittedIssuanceStatus,
  lifecycleFromWalletStatus,
  openIssuanceProposal,
  promptLifecycle,
  type IssuanceChoice,
  type IssuanceHistoryRow,
  type WalletLifecycle,
} from "@/lib/wallets/issuance";
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
    .in("status", [...ADMITTED_ISSUANCE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(40);
  if (prior.error) return null;
  const admittedDecisionIds = new Set<string>();
  const openProposalTokens = new Set<string>();
  for (const row of (prior.data ?? []) as Array<Record<string, unknown>>) {
    if (!isAdmittedIssuanceStatus(String(row.status))) continue;
    const decisionId = readDecisionId(row.output);
    if (!decisionId) continue;
    admittedDecisionIds.add(decisionId);
    const tokenId = readIssueTokenId(row.output);
    if (tokenId) openProposalTokens.add(tokenId);
  }
  return {
    roster: roster.map((entry) => ({
      tokenId: entry.tokenId,
      name: entry.name,
      goal: entry.goal,
      lifecycle: promptLifecycle(lifecycles.get(entry.tokenId) ?? "citizen_active", openProposalTokens.has(entry.tokenId)),
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
  /** True only for an admitted issue row. A rejected issue is not an open proposal. */
  openProposal: boolean;
};

export async function loadLatestIssuance(client: SupabaseClient, citizenId: string): Promise<StoredIssuance | null | undefined> {
  const admitted = await client
    .from("ai_decisions")
    .select("status, rationale, output")
    .eq("purpose", "wallet_issuance")
    .eq("citizen_id", citizenId)
    .in("status", [...ADMITTED_ISSUANCE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(20);
  if (admitted.error) return undefined;
  const open = openIssuanceProposal(((admitted.data ?? []) as Array<Record<string, unknown>>).map(toHistoryRow));
  if (open && open.choice === "issue" && open.decisionId !== null) return toStored(open, true);

  const latest = await client
    .from("ai_decisions")
    .select("status, rationale, output")
    .eq("purpose", "wallet_issuance")
    .eq("citizen_id", citizenId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latest.error) return undefined;
  const row = ((latest.data ?? []) as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return toStored(toHistoryRow(row), false);
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

function readIssueTokenId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.choice !== "issue") return null;
  const tokenId = typeof body.tokenId === "string" || typeof body.tokenId === "number" ? String(body.tokenId).split(".")[0] : "";
  return /^[0-9]+$/.test(tokenId) ? tokenId : null;
}

function toHistoryRow(row: Record<string, unknown>): IssuanceHistoryRow {
  const output = row.output && typeof row.output === "object" && !Array.isArray(row.output) ? (row.output as Record<string, unknown>) : {};
  const choice: IssuanceChoice | null =
    output.choice === "issue" || output.choice === "defer" || output.choice === "unnecessary" ? output.choice : null;
  return {
    status: typeof row.status === "string" ? row.status : "",
    choice,
    lifecycle: isLifecycle(output.lifecycle) ? output.lifecycle : null,
    rationale: typeof row.rationale === "string" ? row.rationale : null,
    decisionId: typeof output.decisionId === "string" && HASH.test(output.decisionId) ? output.decisionId : null,
  };
}

function toStored(row: IssuanceHistoryRow, openProposal: boolean): StoredIssuance {
  return {
    choice: row.choice,
    lifecycle: row.lifecycle,
    rationale: row.rationale,
    decisionId: row.decisionId,
    openProposal,
  };
}
