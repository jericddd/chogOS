import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishDecisionActivity } from "@/lib/ai/activity-event";
import type { TreasuryRosterEntry } from "@/lib/ai/treasury-decision";
import type { TreasuryDecisionInsert } from "@/lib/ai/treasury-run";
import type { AppConfig } from "@/lib/config/env";
import type { SpendRecord, TreasuryAsset } from "@/lib/economy/treasury-policy";

const ADMITTED = new Set(["proposed", "accepted", "queued", "executed"]);
const HASH = /^0x[0-9a-f]{64}$/;

export async function loadTreasuryRoster(client: SupabaseClient, config: AppConfig): Promise<TreasuryRosterEntry[] | null> {
  const { data, error } = await client
    .from("citizens")
    .select("id, token_id, metadata_name")
    .eq("chain_id", 143)
    .eq("nft_contract", config.chogNftAddress)
    .order("token_id")
    .limit(12);
  if (error || !data) return null;
  const roster: TreasuryRosterEntry[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const tokenId = String(row.token_id ?? "").split(".")[0];
    if (!/^[0-9]+$/.test(tokenId) || typeof row.id !== "string") continue;
    const name = typeof row.metadata_name === "string" && row.metadata_name.trim() ? row.metadata_name.trim().slice(0, 80) : `Chog #${tokenId}`;
    roster.push({ tokenId, name, goal: null, citizenId: row.id });
  }
  if (roster.length === 0) return roster;
  const goals = await client
    .from("citizen_goals")
    .select("citizen_id, title, status")
    .in("citizen_id", roster.map((entry) => entry.citizenId).filter((id): id is string => Boolean(id)))
    .limit(24);
  if (!goals.error && goals.data) {
    for (const goal of goals.data as Array<Record<string, unknown>>) {
      const entry = roster.find((candidate) => candidate.citizenId === goal.citizen_id);
      if (!entry || entry.goal || typeof goal.title !== "string") continue;
      if (goal.status === "active" || goal.status === "proposed" || entry.goal == null) {
        entry.goal = goal.title.trim().slice(0, 160);
      }
    }
  }
  return roster;
}

export async function loadTreasuryPrior(client: SupabaseClient): Promise<SpendRecord[] | null> {
  const { data, error } = await client
    .from("ai_decisions")
    .select("status, output")
    .eq("purpose", "treasury_allocation")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error || !data) return null;
  const spent: SpendRecord[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (!ADMITTED.has(String(row.status))) continue;
    const parsed = parseSpend(row.output);
    if (!parsed) return null;
    spent.push(parsed);
  }
  return spent;
}

export async function recordTreasuryDecision(client: SupabaseClient, row: TreasuryDecisionInsert): Promise<boolean> {
  const inserted = await client
    .from("ai_decisions")
    .insert({
      purpose: row.purpose,
      status: row.status,
      citizen_id: row.citizenId,
      rationale: row.rationale,
      validation_result: row.validationResult,
      input_commitment: row.inputCommitment,
      provider: row.provider,
      model: row.model,
      output: row.output,
    })
    .select("id")
    .maybeSingle();
  if (inserted.error) return false;
  if (!inserted.data?.id) return true;
  await publishDecisionActivity(client, {
    id: inserted.data.id,
    citizenId: row.citizenId,
    purpose: row.purpose,
    status: row.status,
    rationale: row.rationale,
    output: row.output,
  });
  return true;
}

function parseSpend(value: unknown): SpendRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const decisionId = typeof body.decisionId === "string" ? body.decisionId : "";
  const tokenId = typeof body.tokenId === "string" ? body.tokenId : "";
  const asset = body.asset === "MON" || body.asset === "CHOG" ? body.asset : null;
  const amountRaw = typeof body.amountRaw === "string" ? body.amountRaw : "";
  const windowId = typeof body.windowId === "string" ? body.windowId : "";
  if (!HASH.test(decisionId) || !/^[0-9]+$/.test(tokenId) || !asset || !/^[0-9]+$/.test(amountRaw) || !/^[0-9]+$/.test(windowId)) {
    return null;
  }
  return {
    decisionId,
    tokenId,
    asset: asset as TreasuryAsset,
    amountRaw: BigInt(amountRaw),
    windowId,
  };
}
