import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { publishDecisionActivity } from "@/lib/ai/activity-event";
import type { RosterWallet } from "@/lib/ai/treasury-roster";
import type { TreasuryWorldFact } from "@/lib/ai/treasury-decision";
import type { TreasuryDecisionInsert } from "@/lib/ai/treasury-run";
import type { AppConfig } from "@/lib/config/env";
import type { SpendRecord, TreasuryAsset } from "@/lib/economy/treasury-policy";
import { AI_ISSUED_SCHEME } from "@/lib/wallets/authority";

const ADMITTED = new Set(["proposed", "accepted", "queued", "executed"]);
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

function tokenIdOf(value: unknown): string | null {
  const tokenId = typeof value === "string" || typeof value === "number" ? String(value).split(".")[0] : "";
  return /^[0-9]+$/.test(tokenId) ? tokenId : null;
}

function addressOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

export type TreasuryCandidateLoad = {
  wallets: RosterWallet[];
  /** Count of stored treasury reviews. The roster window starts here. */
  cursor: number;
};

/**
 * Citizens with a stored permanent-wallet address. Chain code is checked later.
 * The first twelve token ids are not the roster.
 */
export async function loadTreasuryCandidates(client: SupabaseClient, config: AppConfig): Promise<TreasuryCandidateLoad | null> {
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
  const citizens = new Map<string, { tokenId: string; name: string; citizenId: string; goal: string | null }>();
  const byId = new Map<string, string>();
  for (const row of citizenRows as Array<Record<string, unknown>>) {
    const tokenId = tokenIdOf(row.token_id);
    if (!tokenId || typeof row.id !== "string") continue;
    const name = typeof row.metadata_name === "string" && row.metadata_name.trim() ? row.metadata_name.trim().slice(0, 80) : `Chog #${tokenId}`;
    citizens.set(tokenId, { tokenId, name, citizenId: row.id, goal: null });
    byId.set(row.id, tokenId);
  }
  const addresses = new Map<string, string>();
  const remember = (tokenId: string | null, account: string | null) => {
    if (!tokenId || !account || !citizens.has(tokenId) || addresses.has(tokenId)) return;
    addresses.set(tokenId, account);
  };
  if (citizens.size > 0) {
    const registry = await readPages((from, to) =>
      client
        .from("citizen_wallet_registry")
        .select("citizen_id, status, scheme, account_address")
        .eq("chain_id", 143)
        .eq("scheme", AI_ISSUED_SCHEME)
        .in("status", ["deployed", "verified"])
        .order("citizen_id", { ascending: true })
        .range(from, to),
    );
    if (registry == null) return null;
    for (const row of registry as Array<Record<string, unknown>>) {
      if (row.scheme !== AI_ISSUED_SCHEME) continue;
      if (row.status !== "deployed" && row.status !== "verified") continue;
      remember(byId.get(String(row.citizen_id)) ?? null, addressOf(row.account_address));
    }
    const issuances = await readPages((from, to) =>
      client
        .from("ai_decisions")
        .select("output")
        .eq("purpose", "wallet_issuance")
        .eq("status", "executed")
        .order("created_at", { ascending: false })
        .range(from, to),
    );
    if (issuances == null) return null;
    for (const row of issuances as Array<Record<string, unknown>>) {
      const output = row.output && typeof row.output === "object" && !Array.isArray(row.output) ? (row.output as Record<string, unknown>) : null;
      if (!output || output.verified !== true || output.onchain !== true) continue;
      remember(tokenIdOf(output.tokenId), addressOf(output.address));
    }
    const events = await readPages((from, to) =>
      client
        .from("civilization_events")
        .select("payload")
        .eq("kind", "wallet.created")
        .eq("source", "ai")
        .eq("chain_status", "confirmed")
        .order("seq", { ascending: false })
        .range(from, to),
    );
    if (events == null) return null;
    for (const row of events as Array<Record<string, unknown>>) {
      const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : null;
      if (!payload || payload.walletVerified !== true) continue;
      remember(tokenIdOf(payload.tokenId), addressOf(payload.wallet));
    }
    const ids = [...citizens.values()].map((citizen) => citizen.citizenId);
    for (let index = 0; index < ids.length; index += 100) {
      const slice = ids.slice(index, index + 100);
      const goals = await client.from("citizen_goals").select("citizen_id, title, status").in("citizen_id", slice).limit(200);
      if (goals.error || !goals.data) continue;
      for (const goal of goals.data as Array<Record<string, unknown>>) {
        const tokenId = byId.get(String(goal.citizen_id));
        const citizen = tokenId ? citizens.get(tokenId) : undefined;
        if (!citizen || citizen.goal || typeof goal.title !== "string") continue;
        if (goal.status === "active" || goal.status === "proposed") citizen.goal = goal.title.trim().slice(0, 160);
      }
    }
  }
  const counted = await client.from("ai_decisions").select("id", { count: "exact", head: true }).eq("purpose", "treasury_allocation");
  if (counted.error || counted.count == null) return null;
  const wallets: RosterWallet[] = [];
  for (const [tokenId, accountAddress] of addresses) {
    const citizen = citizens.get(tokenId);
    if (!citizen) continue;
    wallets.push({ ...citizen, accountAddress });
  }
  return { wallets, cursor: counted.count };
}

/** Stored town needs, open projects, and recent verified events. A failed read contributes nothing. */
export async function loadEconomicContextFacts(client: SupabaseClient): Promise<TreasuryWorldFact[]> {
  const facts: TreasuryWorldFact[] = [];
  const [needs, projects, events] = await Promise.all([
    client.from("town_needs").select("need_type, status, evidence").eq("status", "active"),
    client.from("town_projects").select("id, name, status, project_type, justification").in("status", ["proposed", "active", "blocked"]).limit(8),
    client
      .from("civilization_events")
      .select("id, kind, summary")
      .in("kind", ["treasury.paid", "work.shift_completed"])
      .order("occurred_at", { ascending: false })
      .limit(8),
  ]);
  if (!needs.error && needs.data) {
    for (const row of needs.data as Array<Record<string, unknown>>) {
      if (row.status !== "active" || typeof row.need_type !== "string") continue;
      const summary = clipFact(`Town need ${row.need_type} is active.${stockText(row.evidence)}`);
      if (summary) facts.push({ id: `need:${row.need_type}`, kind: "need", tokenId: null, summary });
    }
  }
  if (!projects.error && projects.data) {
    for (const row of projects.data as Array<Record<string, unknown>>) {
      if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.status !== "string" || typeof row.project_type !== "string") continue;
      const justification = typeof row.justification === "string" ? row.justification : "";
      const summary = clipFact(`Project ${row.name} (${row.project_type}) is ${row.status}. ${justification}`);
      if (summary) facts.push({ id: `project:${row.id}`, kind: "project", tokenId: null, summary });
    }
  }
  if (!events.error && events.data) {
    for (const row of events.data as Array<Record<string, unknown>>) {
      if (typeof row.id !== "string" || typeof row.kind !== "string") continue;
      const summary = clipFact(`Previous event ${row.kind}: ${typeof row.summary === "string" ? row.summary : ""}`);
      if (summary) facts.push({ id: `event:${row.id}`, kind: "event", tokenId: null, summary });
    }
  }
  return facts;
}

function clipFact(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 180);
  return text && !/https?:\/\//i.test(text) ? text : null;
}

function stockText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const body = value as Record<string, unknown>;
  const parts = ["food", "wood", "stone", "tools"].flatMap((key) =>
    typeof body[key] === "number" && Number.isFinite(body[key]) ? [`${key} ${Math.floor(body[key] as number)}`] : [],
  );
  return parts.length > 0 ? ` Storehouse: ${parts.join(", ")}.` : "";
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
    settled: body.onchain === true && body.verified === true,
  };
}
