import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "viem";
import { publishDecisionActivity } from "@/lib/ai/activity-event";
import { considerCitizenCommerce, type CitizenCommerceInsert, type CitizenCommerceConsideration } from "@/lib/ai/citizen-commerce";
import type { AiCompletion } from "@/lib/ai/types";
import { readCitizenMonBalances } from "@/lib/ai/treasury-chain";
import {
  assembleTransferWorld,
  type PriorTransfer,
  type PublicTransferState,
  type TransferCitizen,
  type TransferDirection,
} from "@/lib/ai/transfer-decision";
import type { AppConfig } from "@/lib/config/env";

const ROLES = new Set(["farmer", "woodcutter", "stonecutter", "crafter", "merchant", "builder"]);
const ACTIVITIES = new Set(["walking", "working", "gathering", "building", "shopping", "socializing", "resting", "sleeping", "idle", "unavailable"]);
const OPEN = new Set(["proposed", "approved_awaiting_execution"]);

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

function text(value: unknown, length: number): string | null {
  if (typeof value !== "string") return null;
  const clipped = value.replace(/\s+/g, " ").trim().slice(0, length);
  return clipped && !/https?:\/\//i.test(clipped) ? clipped : null;
}

function tokenIdOf(value: unknown): string | null {
  const tokenId = typeof value === "string" || typeof value === "number" ? String(value).split(".")[0] : "";
  return /^[0-9]+$/.test(tokenId) ? tokenId : null;
}

type WorldParts = {
  citizens: TransferCitizen[];
  needs: Array<{ needType: string; status: string; stock: Partial<Record<"food" | "wood" | "stone" | "tools", number>> }>;
  projects: Array<{ id: string; name: string; status: string; projectType: string; justification: string }>;
  events: Array<{ id: string; kind: string; summary: string; tokenId: string | null }>;
  priors: PriorTransfer[];
  gaps: string[];
};

export async function loadTransferWorld(client: SupabaseClient): Promise<{ ok: true; parts: WorldParts } | { ok: false; detail: string }> {
  const wallets = await client
    .from("ai_decisions")
    .select("citizen_id, output")
    .eq("purpose", "wallet_issuance")
    .eq("status", "executed")
    .order("created_at", { ascending: true })
    .limit(400);
  if (wallets.error || !wallets.data) {
    return { ok: false, detail: "Citizen wallet records could not be read. No transaction was broadcast." };
  }
  const prior = await client
    .from("ai_decisions")
    .select("status, output, purpose, rationale")
    .in("purpose", ["citizen_trade", "citizen_return"])
    .order("created_at", { ascending: false })
    .limit(400);
  if (prior.error || !prior.data) {
    return { ok: false, detail: "Earlier citizen transfer records could not be read. No transaction was broadcast." };
  }
  const citizens: TransferCitizen[] = [];
  const seen = new Set<string>();
  for (const row of wallets.data as Array<Record<string, unknown>>) {
    const wallet = verifiedWallet(row.output);
    if (!wallet || seen.has(wallet.tokenId) || typeof row.citizen_id !== "string") continue;
    seen.add(wallet.tokenId);
    citizens.push({
      tokenId: wallet.tokenId,
      citizenId: row.citizen_id,
      name: `Chog #${wallet.tokenId}`,
      wallet: wallet.wallet,
      role: null,
      activity: null,
      workId: null,
      goal: null,
      monBalanceRaw: null,
    });
  }
  const ids = citizens.map((citizen) => citizen.citizenId);
  const byId = new Map(citizens.map((citizen) => [citizen.citizenId, citizen]));
  if (ids.length > 0) {
    const [states, goals] = await Promise.all([
      client.from("citizen_world_state").select("citizen_id, role, activity, work_id").in("citizen_id", ids),
      client.from("citizen_goals").select("citizen_id, title, status").in("citizen_id", ids).in("status", ["proposed", "active", "blocked"]).limit(200),
    ]);
    if (!states.error && states.data) {
      for (const row of states.data as Array<Record<string, unknown>>) {
        const citizen = typeof row.citizen_id === "string" ? byId.get(row.citizen_id) : undefined;
        if (!citizen) continue;
        citizen.role = typeof row.role === "string" && ROLES.has(row.role) ? row.role : null;
        citizen.activity = typeof row.activity === "string" && ACTIVITIES.has(row.activity) ? row.activity : null;
        citizen.workId = text(row.work_id, 80);
      }
    }
    if (!goals.error && goals.data) {
      for (const row of goals.data as Array<Record<string, unknown>>) {
        const citizen = typeof row.citizen_id === "string" ? byId.get(row.citizen_id) : undefined;
        if (!citizen || citizen.goal) continue;
        citizen.goal = text(row.title, 120);
      }
    }
  }
  const [needs, projects, events] = await Promise.all([
    client.from("town_needs").select("need_type, status, evidence").eq("status", "active"),
    client.from("town_projects").select("id, name, status, project_type, justification").in("status", ["proposed", "active", "blocked"]).limit(8),
    client
      .from("civilization_events")
      .select("id, kind, summary, payload")
      .in("kind", ["treasury.paid", "work.shift_completed", "citizen.trade", "citizen.return"])
      .order("occurred_at", { ascending: false })
      .limit(12),
  ]);
  const gaps: string[] = [];
  if (needs.error) gaps.push("Town needs could not be read.");
  if (projects.error) gaps.push("Town projects could not be read.");
  if (events.error) gaps.push("Recent economic events could not be read.");
  const priors: PriorTransfer[] = [];
  for (const row of prior.data as Array<Record<string, unknown>>) {
    const output = row.output && typeof row.output === "object" ? (row.output as Record<string, unknown>) : {};
    const key = typeof output.idempotencyKey === "string" ? output.idempotencyKey : "";
    const direction = typeof output.direction === "string" ? output.direction : row.purpose === "citizen_return" ? "citizen_to_chogbank" : "citizen_to_citizen";
    const senderTokenId = tokenIdOf(output.senderTokenId) ?? tokenIdOf(output.tokenId);
    const publicState = typeof output.publicState === "string" ? output.publicState : row.status === "proposed" ? "proposed" : "deferred";
    if (key) priors.push({ key, direction, senderTokenId, publicState });
    else if (senderTokenId && OPEN.has(publicState)) {
      priors.push({ key: "", direction, senderTokenId, publicState });
    }
  }
  return {
    ok: true,
    parts: {
      citizens,
      needs: needs.error
        ? []
        : ((needs.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
            needType: typeof row.need_type === "string" ? row.need_type : "",
            status: typeof row.status === "string" ? row.status : "",
            stock: stock(row.evidence),
          })),
      projects: projects.error
        ? []
        : ((projects.data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
            const id = typeof row.id === "string" ? row.id : "";
            const name = text(row.name, 80);
            const justification = text(row.justification, 180);
            if (!id || !name || !justification || typeof row.status !== "string" || typeof row.project_type !== "string") return [];
            return [{ id, name, status: row.status, projectType: row.project_type, justification }];
          }),
      events: events.error
        ? []
        : ((events.data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
            const id = typeof row.id === "string" ? row.id : "";
            const summary = text(row.summary, 140);
            const payload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
            if (!id || !summary || typeof row.kind !== "string") return [];
            return [{ id, kind: row.kind, summary, tokenId: tokenIdOf(payload.tokenId) }];
          }),
      priors,
      gaps,
    },
  };
}

function stock(value: unknown): Partial<Record<"food" | "wood" | "stone" | "tools", number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const result: Partial<Record<"food" | "wood" | "stone" | "tools", number>> = {};
  for (const key of ["food", "wood", "stone", "tools"] as const) {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) result[key] = body[key];
  }
  return result;
}

export async function recordCitizenCommerce(client: SupabaseClient, row: CitizenCommerceInsert): Promise<boolean> {
  const status = row.publicState === "technical_failure" || row.publicState === "failed_execution"
    ? "failed"
    : row.publicState === "proposed"
      ? "proposed"
      : "rejected";
  const inserted = await client
    .from("ai_decisions")
    .insert({
      purpose: row.purpose,
      status,
      citizen_id: row.citizenId,
      rationale: row.rationale,
      validation_result: row.publicState,
      provider: row.provider,
      model: row.model,
      output: {
        executed: false,
        onchain: false,
        verified: false,
        broadcast: false,
        publicState: row.publicState satisfies PublicTransferState,
        direction: row.direction satisfies TransferDirection | null,
        action: row.action,
        operation: row.purpose === "citizen_return" ? "return_capital" : "trade",
        tokenId: row.tokenId,
        senderTokenId: row.tokenId,
        recipientTokenId: row.counterpartyTokenId,
        relatedTokenId: row.counterpartyTokenId,
        wallet: row.wallet,
        recipientWallet: row.recipientWallet,
        walletVerified: row.wallet != null,
        amountRaw: row.amountRaw,
        asset: row.asset,
        factIds: row.factIds.join(","),
        factSummaries: row.factSummaries.join(" "),
        explanation: row.rationale,
        limitation: row.limitation,
        prerequisites: row.prerequisites.join(" "),
        idempotencyKey: row.idempotencyKey,
        executable: false,
        chainId: 143,
        txHash: null,
        blockNumber: null,
      },
    })
    .select("id")
    .maybeSingle();
  if (inserted.error || !inserted.data?.id) return false;
  await publishDecisionActivity(client, {
    id: inserted.data.id,
    citizenId: row.citizenId,
    purpose: row.purpose,
    status,
    rationale: row.rationale,
    output: {
      tokenId: row.tokenId,
      senderTokenId: row.tokenId,
      recipientTokenId: row.counterpartyTokenId,
      relatedTokenId: row.counterpartyTokenId,
      wallet: row.wallet,
      recipientWallet: row.recipientWallet,
      walletVerified: row.wallet != null,
      executed: false,
      onchain: false,
      verified: false,
      txHash: null,
      publicState: row.publicState,
      direction: row.direction,
      amountRaw: row.amountRaw,
      asset: row.asset,
      factSummaries: row.factSummaries.join(" "),
      explanation: row.rationale,
      limitation: row.limitation,
      bank: row.direction === "citizen_to_chogbank" ? row.recipientWallet : null,
    },
  });
  return true;
}

export async function storeCitizenCommerce(
  client: SupabaseClient,
  input: {
    provider: string;
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
    config: AppConfig;
    complete: ((request: {
      system: string;
      user: string;
      timeoutMs: number;
      maxOutputTokens: number;
      responseSchema?: Record<string, unknown>;
    }) => Promise<AiCompletion>) | null;
  },
): Promise<CitizenCommerceConsideration> {
  const loaded = await loadTransferWorld(client);
  if (!loaded.ok) {
    return { status: "failed", detail: loaded.detail, promptChars: 0, outputTokens: 0, halt: null };
  }
  let balances = new Map<string, bigint | null>();
  try {
    balances = await readCitizenMonBalances(
      input.config,
      loaded.parts.citizens.flatMap((citizen) => (citizen.wallet ? [{ tokenId: citizen.tokenId, wallet: citizen.wallet }] : [])),
    );
  } catch {
    balances = new Map();
  }
  const citizens = loaded.parts.citizens.slice(0, 12).map((citizen) => {
    const balance = balances.get(citizen.tokenId);
    return { ...citizen, monBalanceRaw: balance == null ? null : balance.toString(10) };
  });
  const world = assembleTransferWorld({ ...loaded.parts, citizens });
  return considerCitizenCommerce({
    world,
    timeoutMs: input.timeoutMs,
    maxOutputTokens: input.maxOutputTokens,
    provider: input.provider,
    model: input.model,
    complete: input.complete,
    record: (row) => recordCitizenCommerce(client, row),
  });
}
