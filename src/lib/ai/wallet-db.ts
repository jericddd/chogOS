import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WalletIssuanceInsert, WalletRosterEntry } from "@/lib/ai/wallet-run";
import type { AppConfig } from "@/lib/config/env";
import { AI_ISSUED_SCHEME } from "@/lib/wallets/authority";
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
const PAGE = 1000;
const MAX_PAGES = 5;

type PageResult = { data: unknown[] | null; error: { message: string } | null };

async function readPages(load: (from: number, to: number) => PromiseLike<PageResult>): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    const result = await load(from, from + PAGE - 1);
    if (result.error || !result.data) return null;
    rows.push(...result.data);
    if (result.data.length < PAGE) break;
  }
  return rows;
}

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

/** Active citizens on the official collection. Older placeholder wallet rows do not count as a permanent wallet. */
export async function loadWalletIssuanceContext(
  client: SupabaseClient,
  config: AppConfig,
): Promise<WalletIssuanceContext | null> {
  const citizenRows = await readPages((from, to) =>
    client
      .from("citizens")
      .select("id, token_id, metadata_name")
      .eq("chain_id", 143)
      .eq("nft_contract", config.chogNftAddress)
      .eq("enrollment_status", "active")
      .order("token_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (citizenRows == null) return null;
  const roster: Array<Omit<WalletRosterEntry, "lifecycle">> = [];
  for (const row of citizenRows as Array<Record<string, unknown>>) {
    const tokenId = String(row.token_id ?? "").split(".")[0];
    if (!/^[0-9]+$/.test(tokenId) || typeof row.id !== "string") continue;
    const name = typeof row.metadata_name === "string" && row.metadata_name.trim() ? row.metadata_name.trim().slice(0, 80) : `Chog #${tokenId}`;
    roster.push({ tokenId, name, goal: null, citizenId: row.id });
  }
  const lifecycles = new Map<string, WalletLifecycle>();
  for (const entry of roster) lifecycles.set(entry.tokenId, "citizen_active");
  const byId = new Map(roster.map((entry) => [entry.citizenId, entry.tokenId]));
  if (roster.length > 0) {
    const registry = await readPages((from, to) =>
      client
        .from("citizen_wallet_registry")
        .select("citizen_id, status, scheme")
        .eq("chain_id", 143)
        .eq("scheme", AI_ISSUED_SCHEME)
        .order("citizen_id", { ascending: true })
        .range(from, to),
    );
    if (registry == null) return null;
    for (const row of registry as Array<Record<string, unknown>>) {
      if (row.scheme !== AI_ISSUED_SCHEME) continue;
      const tokenId = byId.get(String(row.citizen_id));
      if (!tokenId) continue;
      const next = lifecycleFromWalletStatus(isWalletStatus(row.status) ? row.status : null);
      const previous = lifecycles.get(tokenId) ?? "citizen_active";
      if (RANK[next] >= RANK[previous]) lifecycles.set(tokenId, next);
    }
    for (let index = 0; index < roster.length; index += 100) {
      const ids = roster.slice(index, index + 100).map((entry) => entry.citizenId).filter((id): id is string => Boolean(id));
      const goals = await client.from("citizen_goals").select("citizen_id, title, status").in("citizen_id", ids).limit(200);
      if (goals.error || !goals.data) continue;
      for (const goal of goals.data as Array<Record<string, unknown>>) {
        const entry = roster.find((candidate) => candidate.citizenId === goal.citizen_id);
        if (!entry || entry.goal || typeof goal.title !== "string") continue;
        if (goal.status === "active" || goal.status === "proposed" || entry.goal == null) {
          entry.goal = goal.title.trim().slice(0, 160);
        }
      }
    }
  }
  const prior = await readPages((from, to) =>
    client
      .from("ai_decisions")
      .select("status, output")
      .eq("purpose", "wallet_issuance")
      .in("status", [...ADMITTED_ISSUANCE_STATUSES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (prior == null) return null;
  const admittedDecisionIds = new Set<string>();
  const openProposalTokens = new Set<string>();
  for (const row of prior as Array<Record<string, unknown>>) {
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
