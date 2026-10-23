import "server-only";
import { randomUUID } from "node:crypto";
import { getAiProvider } from "@/lib/ai/provider";
import { evaluateBudget, haltFromError, isRetriableHaltReason, usagePeriods, type UsageSnapshot } from "@/lib/ai/budget";
import { AI_INVOCATION_DEADLINE_MS, awaitFreeTierSlot, timeoutWithinDeadline } from "@/lib/ai/invocation";
import { buildDecisionContext, contextCommitment, decisionMessages } from "@/lib/ai/context";
import { acceptGrowth, GROWTH_RESPONSE_SCHEMA, growthBlocker, landCanGrow } from "@/lib/ai/growth";
import {
  isActivationAction,
  isCivicAction,
  isEconomyAction,
  isWorldAction,
  jsonSafeDecision,
  parseDecisionOutput,
  type ParsedDecision,
} from "@/lib/ai/schema";
import {
  activationDraftFromDecision,
  evaluateDecisionActivation,
  isActivationDraft,
} from "@/lib/chogbank/from-decision";
import { productionBankRuntime } from "@/lib/chogbank/runtime";
import { readEconomyLedger, saveEconomyDecision } from "@/lib/economy/db";
import { evaluateProductionEconomy } from "@/lib/economy/production";
import { proposalFromDraft } from "@/lib/economy/proposal";
import { publishStoredAiActivity } from "@/lib/ai/activity-event";
import { storeCitizenCommerce } from "@/lib/ai/citizen-commerce-db";
import { observeCitizenWallets, readCitizenMonSpent, readTreasuryChain } from "@/lib/ai/treasury-chain";
import { rosterFromDeployedWallets } from "@/lib/ai/treasury-roster";
import { considerTreasuryAllocation, treasuryReviewInsert } from "@/lib/ai/treasury-run";
import { loadTreasuryCandidates, loadTreasuryPrior, recordTreasuryDecision } from "@/lib/ai/treasury-db";
import { considerWalletIssuance } from "@/lib/ai/wallet-run";
import { loadWalletIssuanceContext, recordWalletIssuance } from "@/lib/ai/wallet-db";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";
import type { PersonalityTraits } from "@/lib/ai/personality";
import { readAppConfig, type AppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { precheckAction, validateProposal, type ActionProposal } from "@/lib/world/actions";
import { civicMenu, readCivicFacts, type CivicFacts } from "@/lib/world/civic";
import { submitIntent } from "@/lib/world/intents";
import {
  activeTownNeeds,
  constructKindForNeed,
  evaluateTownNeeds,
  feasibleConstructKinds,
  jobAddressesNeed,
  materialsAllowBuilderShift,
} from "@/lib/world/needs";
import { planConstruction, surveyedPlots, type ConstructKind } from "@/lib/world/placement";
import {
  completeOverlayTiles,
  eligibleRoadStubs,
  validateRoadStubPlacement,
} from "@/lib/world/roads";
import {
  eligibleProjectCandidates,
  projectMatchesDecision,
} from "@/lib/world/projects";
import {
  ROAD_COLUMNS,
  TOWN_NEED_COLUMNS,
  TOWN_PROJECT_COLUMNS,
  toBuilding,
  toCitizen,
  toRoad,
  toTownNeed,
  toTownProject,
  type BuildingRow,
  type CitizenRow,
  type RoadRow,
  type TownNeedRow,
  type TownProjectRow,
} from "@/lib/world/rows";
import type { BuildingView, CitizenView, TownNeedView, TownProjectView } from "@/lib/world/types";
import type { Tile } from "@/lib/world/layout";

export type MindRunStatus =
  | "disabled"
  | "halted"
  | "budget"
  | "idle"
  | "ran"
  | "error"
  | "unconfigured";

export type MindRunReport = {
  status: MindRunStatus;
  provider: string;
  model: string | null;
  reason?: string;
  claimed: number;
  inferred: number;
  submitted: number;
  constructed: number;
  rejected: number;
  decisions: Array<{ tokenId: string; status: string; detail: string }>;
  treasury?: { status: string; detail: string };
  walletIssuance?: { status: string; detail: string };
  commerce?: { status: string; detail: string };
};

type Client = ReturnType<typeof createServiceRoleClient>;

function emptyReport(status: MindRunStatus, config: AppConfig, reason?: string): MindRunReport {
  return {
    status,
    provider: config.aiProvider,
    model: config.aiModel ?? null,
    reason,
    claimed: 0,
    inferred: 0,
    submitted: 0,
    constructed: 0,
    rejected: 0,
    decisions: [],
  };
}

async function readUsage(client: Client): Promise<UsageSnapshot> {
  const periods = usagePeriods();
  const [{ data: hour }, { data: day }, { data: scheduler }] = await Promise.all([
    client.from("ai_usage_counters").select("invocations").eq("bucket", "hour").eq("period_start", periods.hour).maybeSingle(),
    client.from("ai_usage_counters").select("invocations").eq("bucket", "day").eq("period_start", periods.day).maybeSingle(),
    client.from("ai_scheduler_state").select("halt_until, halt_reason").eq("singleton", true).maybeSingle(),
  ]);
  return {
    hourInvocations: Number((hour as { invocations?: number } | null)?.invocations ?? 0),
    dayInvocations: Number((day as { invocations?: number } | null)?.invocations ?? 0),
    haltUntil: ((scheduler as { halt_until?: string | null } | null)?.halt_until ?? null) as string | null,
    haltReason: ((scheduler as { halt_reason?: string | null } | null)?.halt_reason ?? null) as string | null,
  };
}

async function bumpUsage(client: Client, promptChars: number, outputTokens: number | undefined): Promise<void> {
  const periods = usagePeriods();
  for (const [bucket, period] of [
    ["hour", periods.hour],
    ["day", periods.day],
  ] as const) {
    const { data } = await client
      .from("ai_usage_counters")
      .select("invocations, prompt_chars, output_tokens")
      .eq("bucket", bucket)
      .eq("period_start", period)
      .maybeSingle();
    const row = data as { invocations?: number; prompt_chars?: number; output_tokens?: number } | null;
    if (!row) {
      await client.from("ai_usage_counters").insert({
        bucket,
        period_start: period,
        invocations: 1,
        prompt_chars: promptChars,
        output_tokens: outputTokens ?? 0,
      });
    } else {
      await client
        .from("ai_usage_counters")
        .update({
          invocations: Number(row.invocations ?? 0) + 1,
          prompt_chars: Number(row.prompt_chars ?? 0) + promptChars,
          output_tokens: Number(row.output_tokens ?? 0) + (outputTokens ?? 0),
        })
        .eq("bucket", bucket)
        .eq("period_start", period);
    }
  }
}

async function haltScheduler(client: Client, until: string, reason: string): Promise<void> {
  await client
    .from("ai_scheduler_state")
    .update({ halt_until: until, halt_reason: reason, last_error: reason, last_run_at: new Date().toISOString() })
    .eq("singleton", true);
}

function asTraits(row: Record<string, unknown>): PersonalityTraits {
  const preferred = row.preferred_activity;
  return {
    sociability: Number(row.sociability),
    curiosity: Number(row.curiosity),
    industriousness: Number(row.industriousness),
    cooperation: Number(row.cooperation),
    caution: Number(row.caution),
    planning: Number(row.planning),
    resourcefulness: Number(row.resourcefulness),
    preferredActivity:
      preferred === "shop" || preferred === "socialize" || preferred === "rest" || preferred === "work"
        ? preferred
        : "work",
  };
}

async function loadCitizenBundle(client: Client, citizenId: string): Promise<{
  citizen: CitizenView;
  buildings: BuildingView[];
  worldS: number;
  stock: { wood: number; stone: number; food: number; tools: number };
  personality: PersonalityTraits;
  skills: Array<{ name: string; level: number; experience: number }>;
  goals: Array<{ id: string; kind: string; title: string; status: string; progress: number }>;
  memories: Array<{ content: string; outcome: string | null; importance: number; relatedBuildingId: string | null }>;
  occupiedPlots: Set<string>;
  overlayTiles: Tile[];
  placedStubIds: Set<string>;
  roadsReady: boolean;
} | null> {
  const [state, buildingsRes, world, personality, skills, goals, memories, plots, roadsRes] = await Promise.all([
    client
      .from("citizen_world_state")
      .select("*, citizens!inner(token_id, metadata_name, origin)")
      .eq("citizen_id", citizenId)
      .maybeSingle(),
    client.from("world_buildings").select("*"),
    client.from("world_state").select("last_tick_world_s").maybeSingle(),
    client.from("citizen_personalities").select("*").eq("citizen_id", citizenId).maybeSingle(),
    client.from("citizen_skills").select("name, level, experience").eq("citizen_id", citizenId),
    client
      .from("citizen_goals")
      .select("id, kind, title, status, progress")
      .eq("citizen_id", citizenId)
      .in("status", ["proposed", "active", "blocked"]),
    client
      .from("ai_memories")
      .select("content, outcome, importance, related_building_id")
      .eq("citizen_id", citizenId)
      .order("importance", { ascending: false })
      .limit(8),
    client.from("world_plots").select("id, status"),
    client.from("world_roads").select(ROAD_COLUMNS),
  ]);
  if (!state.data || !buildingsRes.data || !world.data || !personality.data) {
    return null;
  }
  const citizen = toCitizen(state.data as unknown as CitizenRow);
  if (!citizen) {
    return null;
  }
  const buildings = (buildingsRes.data as BuildingRow[]).map(toBuilding);
  const store = buildings.find((building) => building.id === "storehouse")?.stock ?? {};
  const roadsReady = !roadsRes.error;
  const overlayViews = roadsReady
    ? ((roadsRes.data ?? []) as RoadRow[]).map(toRoad).filter((road): road is NonNullable<ReturnType<typeof toRoad>> => road !== null)
    : [];
  return {
    citizen,
    buildings,
    worldS: Number((world.data as { last_tick_world_s: number }).last_tick_world_s),
    stock: {
      wood: store.wood ?? 0,
      stone: store.stone ?? 0,
      food: store.food ?? 0,
      tools: store.tools ?? 0,
    },
    personality: asTraits(personality.data as Record<string, unknown>),
    skills: ((skills.data ?? []) as Array<{ name: string; level: number; experience?: number }>).map((row) => ({
      name: row.name,
      level: row.level,
      experience: row.experience ?? 0,
    })),
    goals: ((goals.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      title: String(row.title),
      status: String(row.status),
      progress: Number(row.progress),
    })),
    memories: ((memories.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      content: String(row.content),
      outcome: (row.outcome as string | null) ?? null,
      importance: Number(row.importance),
      relatedBuildingId: (row.related_building_id as string | null) ?? null,
    })),
    occupiedPlots: new Set(
      ((plots.data ?? []) as Array<{ id: string; status: string }>)
        .filter((plot) => plot.status !== "vacant")
        .map((plot) => plot.id),
    ),
    overlayTiles: completeOverlayTiles(overlayViews),
    placedStubIds: new Set(overlayViews.map((road) => road.id)),
    roadsReady,
  };
}

async function loadTownNeeds(
  client: Client,
  buildings: BuildingView[],
  stock: { food: number; wood: number; stone: number; tools: number },
  occupiedPlots: Set<string>,
  overlay: readonly Tile[] = [],
): Promise<TownNeedView[]> {
  const { data, error } = await client.from("town_needs").select(TOWN_NEED_COLUMNS);
  if (!error && data) {
    return (data as TownNeedRow[]).map(toTownNeed).filter((need): need is TownNeedView => need !== null);
  }
  const plots = surveyedPlots(overlay);
  return evaluateTownNeeds({
    food: stock.food,
    wood: stock.wood,
    stone: stock.stone,
    tools: stock.tools,
    vacantServedLots: plots.filter((plot) => plot.served && !occupiedPlots.has(plot.id)).length,
    reservedLots: plots.filter((plot) => !plot.served).length,
    buildings,
  });
}

async function loadTownProjects(client: Client): Promise<TownProjectView[]> {
  const { data, error } = await client
    .from("town_projects")
    .select(TOWN_PROJECT_COLUMNS)
    .in("status", ["proposed", "active", "blocked"]);
  if (error || !data) {
    return [];
  }
  return (data as TownProjectRow[]).map(toTownProject).filter((project): project is TownProjectView => project !== null);
}

async function linkTownProject(
  client: Client,
  projects: readonly TownProjectView[],
  decision: { action: string; buildKind?: string; roadStubId?: string; projectId?: string | null },
  decisionId: string,
  citizenId: string,
): Promise<void> {
  const listed = eligibleProjectCandidates(projects);
  const match = listed.find((candidate) => {
    const project = projects.find((item) => item.id === candidate.projectId);
    if (!project || !projectMatchesDecision(project, decision)) {
      return false;
    }
    if (decision.projectId) {
      return candidate.projectId === decision.projectId;
    }
    return true;
  }) ?? listed.find((candidate) => {
    const project = projects.find((item) => item.id === candidate.projectId);
    return project ? projectMatchesDecision(project, decision) : false;
  });
  if (!match) {
    return;
  }
  await client.rpc("world_link_town_project", {
    p_project: match.projectId,
    p_decision: decisionId,
    p_citizen: citizenId,
  });
}

async function linkTownNeed(
  client: Client,
  needs: readonly TownNeedView[],
  citizen: CitizenView,
  action: string,
  buildKind: ConstructKind | "none",
  decisionId: string,
): Promise<void> {
  const match = activeTownNeeds(needs).find((need) => {
    if (action === "build") {
      return constructKindForNeed(need) === buildKind;
    }
    if (action === "work") {
      return jobAddressesNeed(citizen.role, need.needType);
    }
    return false;
  });
  if (!match) {
    return;
  }
  await client.rpc("world_link_town_need", { p_need: match.needType, p_decision: decisionId });
}

async function loadCivicFacts(client: Client): Promise<CivicFacts | null> {
  const { data, error } = await client.rpc("world_civic_snapshot");
  if (error || data == null) {
    return null;
  }
  return readCivicFacts(data);
}

async function citizenByToken(client: Client, tokenId: string | null): Promise<string | null> {
  if (!tokenId) {
    return null;
  }
  const { data } = await client.from("citizens").select("id").eq("token_id", tokenId).limit(1).maybeSingle();
  const id = data && typeof data === "object" && "id" in data ? data.id : null;
  return typeof id === "string" ? id : null;
}

async function latestBreachCitizen(client: Client): Promise<string | null> {
  const { data } = await client
    .from("civilization_events")
    .select("actor_citizen_id")
    .eq("kind", "civic.breach")
    .not("actor_citizen_id", "is", null)
    .order("seq", { ascending: false })
    .limit(1);
  const row = Array.isArray(data) ? data[0] : null;
  const id = row && typeof row === "object" && "actor_citizen_id" in row ? row.actor_citizen_id : null;
  return typeof id === "string" ? id : null;
}

type CivicApply =
  | { ok: true; detail: string; queued: boolean; intentId: string | null }
  | { ok: false; detail: string };

async function applyCivicDecision(
  client: Client,
  decisionId: string,
  tokenId: string,
  citizenId: string,
  decision: ParsedDecision,
  bundle: {
    citizen: CitizenView;
    buildings: BuildingView[];
    worldS: number;
    stock: { wood: number; stone: number };
  },
): Promise<CivicApply> {
  if (decision.action === "visit" || decision.action === "watch") {
    const building = bundle.buildings.find((item) => item.id === decision.buildingId);
    const proposal: ActionProposal = {
      tokenId,
      action: decision.action,
      buildingId: decision.buildingId,
      source: "ai",
      decisionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    const shape = validateProposal(proposal);
    if (!shape.ok) {
      return { ok: false, detail: shape.reason };
    }
    const precheck = precheckAction(proposal, bundle.citizen, building, bundle.worldS, bundle.stock);
    if (!precheck.ok) {
      return { ok: false, detail: precheck.reason };
    }
    const submitted = await submitIntent(proposal);
    if (!submitted.ok) {
      return { ok: false, detail: submitted.detail };
    }
    return { ok: true, detail: `${decision.action} at ${decision.buildingId}`, queued: true, intentId: submitted.intentId };
  }

  if (decision.action === "proclaim" || decision.action === "amend" || decision.action === "pardon") {
    if (!decision.lawCode) {
      return { ok: false, detail: "that is not an open law in the catalog" };
    }
    const reason = decision.rationale.trim();
    const { data, error } =
      decision.action === "proclaim"
        ? await client.rpc("world_proclaim_law", {
            p_code: decision.lawCode,
            p_reason: reason,
            p_citizen: citizenId,
            p_decision: decisionId,
          })
        : await client.rpc("world_amend_law", {
            p_code: decision.lawCode,
            p_reason: reason,
            p_citizen: citizenId,
            p_decision: decisionId,
            p_pardon: decision.action === "pardon",
          });
    return civicRpcResult(data, error, decision.action === "proclaim" ? `Proclaimed ${decision.lawCode}` : `${decision.action} ${decision.lawCode}`);
  }

  if (decision.action === "levy" || decision.action === "detain") {
    const subject = (await citizenByToken(client, decision.subjectTokenId)) ?? (await latestBreachCitizen(client));
    if (!subject) {
      return { ok: false, detail: "no breach is stored" };
    }
    const { data, error } =
      decision.action === "levy"
        ? await client.rpc("world_levy_fine", { p_citizen: subject, p_decision: decisionId })
        : await client.rpc("world_detain_citizen", { p_citizen: subject, p_decision: decisionId });
    return civicRpcResult(data, error, decision.action === "levy" ? "Levied the ration fine" : "Sentenced a citizen to the jail");
  }

  return { ok: false, detail: "unsupported action" };
}

function civicRpcResult(
  data: unknown,
  error: { message?: string } | null,
  detail: string,
): CivicApply {
  if (error) {
    return { ok: false, detail: "the civic record could not be written" };
  }
  const body = data && typeof data === "object" ? (data as { ok?: boolean; reason?: string }) : null;
  if (!body?.ok) {
    return { ok: false, detail: body?.reason ?? "the civic record could not be written" };
  }
  return { ok: true, detail, queued: false, intentId: null };
}

export async function runAiMind(
  config: AppConfig = readAppConfig(),
  deadlineMs: number = AI_INVOCATION_DEADLINE_MS,
): Promise<MindRunReport> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return emptyReport("unconfigured", config, "Supabase is not configured.");
  }
  if (!config.aiRunnerEnabled) {
    return emptyReport("disabled", config, "AI_RUNNER_ENABLED is not true. The mind stays off.");
  }
  if (config.aiProvider === "none" || config.aiProvider === "ajax") {
    return emptyReport("disabled", config, "No hosted inference provider is configured.");
  }
  if (!config.aiApiKey || !config.aiModel) {
    return emptyReport("disabled", config, "AI_API_KEY and AI_MODEL must be set.");
  }

  const client = createServiceRoleClient();
  const report: MindRunReport = emptyReport("ran", config);
  const runId = randomUUID();

  try {
    await client.rpc("world_ensure_minds");
    await publishStoredAiActivity(client);
    let usage = await readUsage(client);
    if (isRetriableHaltReason(usage.haltReason)) {
      await client
        .from("ai_scheduler_state")
        .update({ halt_until: null, halt_reason: null, last_error: null })
        .eq("singleton", true);
      usage = { ...usage, haltUntil: null, haltReason: null };
    }
    const budget = evaluateBudget(config, usage);
    if (!budget.ok) {
      await client
        .from("ai_scheduler_state")
        .update({ last_run_at: new Date().toISOString(), last_error: budget.reason })
        .eq("singleton", true);
      return { ...emptyReport(budget.code === "halted" ? "halted" : "budget", config, budget.reason) };
    }

    const provider = getAiProvider(config);
    const startedAt = Date.now();
    let lastModelStartedAt = 0;
    let endRun = false;
    let treasuryConsidered = false;
    let walletIssuanceConsidered = false;
    let commerceConsidered = false;

    async function attachWalletIssuance(): Promise<void> {
      if (walletIssuanceConsidered) return;
      walletIssuanceConsidered = true;
      if (report.status === "halted" || report.status === "budget") {
        report.walletIssuance = {
          status: "skipped",
          detail: "The mind run is halted or out of budget, so no wallet was requested.",
        };
        return;
      }
      if (timeoutWithinDeadline(startedAt, config.aiRequestTimeoutMs, Date.now(), deadlineMs) === null) {
        report.walletIssuance = { status: "skipped", detail: "Stopped before the host timeout. No wallet was requested." };
        return;
      }
      const gate = evaluateBudget(config, await readUsage(client));
      if (!gate.ok) {
        report.walletIssuance = { status: "skipped", detail: gate.reason };
        if (gate.code === "halted") {
          report.status = "halted";
          report.reason = gate.reason;
        }
        return;
      }
      const context = await loadWalletIssuanceContext(client, config);
      if (context == null) {
        report.walletIssuance = { status: "failed", detail: "Earlier wallet records could not be read. The model was not called." };
        return;
      }
      if (context.roster.length === 0) {
        report.walletIssuance = { status: "skipped", detail: "No enrolled citizen is eligible, so no wallet was requested." };
        return;
      }
      const slot = await takeModelSlot();
      if (!slot) {
        report.walletIssuance = { status: "skipped", detail: "No model time remained for a wallet decision." };
        return;
      }
      try {
        const result = await considerWalletIssuance({
          roster: context.roster,
          admittedDecisionIds: context.admittedDecisionIds,
          deploymentPathReady: false,
          timeoutMs: slot.timeoutMs,
          maxOutputTokens: config.aiMaxOutputTokens,
          provider: config.aiProvider,
          model: config.aiModel ?? "",
          complete: async (request) =>
            provider.complete({
              purpose: "wallet_issuance",
              messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.user },
              ],
              timeoutMs: request.timeoutMs,
              maxOutputTokens: request.maxOutputTokens,
            }),
          record: (row) => recordWalletIssuance(client, row),
        });
        if (result.promptChars > 0) {
          await bumpUsage(client, result.promptChars, result.outputTokens);
        }
        report.walletIssuance = { status: result.status, detail: result.detail };
        if (result.halt) {
          await haltScheduler(client, result.halt.until, result.halt.reason);
          report.status = "halted";
          report.reason = result.halt.reason;
        }
      } catch {
        if (report.status !== "halted") {
          report.walletIssuance = {
            status: "failed",
            detail: "The wallet review failed before a deployment. No wallet was created.",
          };
        }
      }
    }

    async function noteTreasury(
      status: "skipped" | "rejected" | "failed",
      detail: string,
      stored: "rejected" | "failed",
    ): Promise<void> {
      const saved = await recordTreasuryDecision(
        client,
        treasuryReviewInsert({
          provider: config.aiProvider,
          model: config.aiModel ?? "",
          status: stored,
          stage: stored,
          rationale: detail,
        }),
      );
      report.treasury = saved
        ? { status, detail }
        : { status: "failed", detail: `${detail} The review was not stored.` };
    }

    async function attachTreasury(): Promise<void> {
      if (treasuryConsidered) return;
      treasuryConsidered = true;
      if (report.status === "halted" || report.status === "budget") {
        await noteTreasury(
          "skipped",
          "The mind run is halted or out of budget, so no treasury allocation was requested.",
          "failed",
        );
        return;
      }
      if (timeoutWithinDeadline(startedAt, config.aiRequestTimeoutMs, Date.now(), deadlineMs) === null) {
        await noteTreasury("skipped", "Stopped before the host timeout. No treasury allocation was requested.", "failed");
        return;
      }
      const gate = evaluateBudget(config, await readUsage(client));
      if (!gate.ok) {
        await noteTreasury("skipped", gate.reason, "failed");
        if (gate.code === "halted") {
          report.status = "halted";
          report.reason = gate.reason;
        }
        return;
      }
      const chain = await readTreasuryChain(config);
      if (!chain.ok) {
        await noteTreasury("failed", chain.reason, "failed");
        return;
      }
      const loaded = await loadTreasuryCandidates(client, config);
      const prior = await loadTreasuryPrior(client);
      if (loaded == null || prior == null) {
        await noteTreasury("failed", "Earlier treasury records could not be read. The model was not called.", "failed");
        return;
      }
      const observed = await observeCitizenWallets(config, loaded.wallets);
      if (observed == null) {
        await noteTreasury("failed", "Citizen wallet code was not read, so no allocation was requested.", "failed");
        return;
      }
      const selected = rosterFromDeployedWallets({
        wallets: loaded.wallets,
        code: observed,
        cursor: loaded.cursor,
      });
      if (selected.status === "unreadable") {
        await noteTreasury("failed", "Citizen wallet code was not read, so no allocation was requested.", "failed");
        return;
      }
      if (selected.status === "none") {
        await noteTreasury(
          "skipped",
          "No eligible citizen has a deployed wallet whose stored token id matches, so no allocation was requested.",
          "rejected",
        );
        return;
      }
      const citizenSpent = await readCitizenMonSpent(
        config,
        selected.roster.map((citizen) => citizen.tokenId),
        chain.facts.windowId,
      );
      if (citizenSpent == null) {
        await noteTreasury("failed", "Citizen MON spending was not read, so no allocation was requested.", "failed");
        return;
      }
      const slot = await takeModelSlot();
      if (!slot) {
        await noteTreasury("skipped", "No model time remained for a treasury allocation.", "failed");
        return;
      }
      try {
        const result = await considerTreasuryAllocation({
          nowMs: Date.now(),
          roster: selected.roster,
          prior,
          monBalance: chain.facts.monBalance,
          chogBalance: chain.facts.chogBalance,
          chogDecimals: chain.facts.chogDecimals,
          monPerTx: chain.facts.maxPerTxMon,
          monCitizen: chain.facts.maxCitizenWindowMon,
          monAggregate: chain.facts.maxAggregateWindowMon,
          monSpentInWindow: chain.facts.observedWindowSpentMon,
          chogCap: chain.facts.maxPerTxChog,
          walletDeployed: true,
          citizenSpentMon: citizenSpent,
          timeoutMs: slot.timeoutMs,
          maxOutputTokens: config.aiMaxOutputTokens,
          provider: config.aiProvider,
          model: config.aiModel ?? "",
          complete: async (request) =>
            provider.complete({
              purpose: "treasury_allocation",
              messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.user },
              ],
              timeoutMs: request.timeoutMs,
              maxOutputTokens: request.maxOutputTokens,
            }),
          record: (row) => recordTreasuryDecision(client, row),
        });
        if (result.promptChars > 0) {
          await bumpUsage(client, result.promptChars, result.outputTokens);
        }
        report.treasury = { status: result.status, detail: result.detail };
        if (result.halt) {
          await haltScheduler(client, result.halt.until, result.halt.reason);
          report.status = "halted";
          report.reason = result.halt.reason;
        }
      } catch {
        if (report.status !== "halted") {
          await noteTreasury("failed", "The treasury review failed before a payment. No transaction was created.", "failed");
        }
      }
    }

    async function attachCitizenCommerce(): Promise<void> {
      if (commerceConsidered) return;
      commerceConsidered = true;
      if (report.status === "halted" || report.status === "budget") {
        report.commerce = { status: "skipped", detail: "The mind run is halted or out of budget, so no trade or return was requested." };
        return;
      }
      const slot = await takeModelSlot();
      if (!slot) {
        report.commerce = { status: "skipped", detail: "No model time remained for a trade or return decision. No transaction was broadcast." };
        return;
      }
      try {
        const result = await storeCitizenCommerce(client, {
          provider: config.aiProvider,
          model: config.aiModel ?? "",
          timeoutMs: slot.timeoutMs,
          maxOutputTokens: config.aiMaxOutputTokens,
          complete: async (request) =>
            provider.complete({
              purpose: "citizen_trade",
              messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.user },
              ],
              timeoutMs: request.timeoutMs,
              maxOutputTokens: request.maxOutputTokens,
            }),
        });
        if (result.promptChars > 0) await bumpUsage(client, result.promptChars, result.outputTokens);
        report.commerce = { status: result.status, detail: result.detail };
        if (result.halt) {
          await haltScheduler(client, result.halt.until, result.halt.reason);
          report.status = "halted";
          report.reason = result.halt.reason;
        }
      } catch {
        report.commerce = {
          status: "failed",
          detail: "Citizen trade and return decisions were not stored. No transaction was broadcast.",
        };
      }
    }

    async function takeModelSlot(): Promise<{ timeoutMs: number } | null> {
      const slot = await awaitFreeTierSlot(
        lastModelStartedAt,
        startedAt,
        config.aiRequestTimeoutMs,
        Date.now(),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        deadlineMs,
      );
      if (!slot) {
        return null;
      }
      lastModelStartedAt = slot.startedAtMs;
      return { timeoutMs: slot.timeoutMs };
    }

    function deferForDeadline(tokenId: string): void {
      endRun = true;
      report.reason = report.reason ?? "Stopped remaining citizens before the host timeout.";
      report.decisions.push({
        tokenId,
        status: "deferred",
        detail: "stopped before the host timeout",
      });
    }

    // Treasury review runs before citizen decisions, so a full citizen queue cannot exhaust the deadline first.
    await attachTreasury();

    while (!endRun) {
      if (timeoutWithinDeadline(startedAt, config.aiRequestTimeoutMs, Date.now(), deadlineMs) === null) {
        break;
      }
      const gate = evaluateBudget(config, await readUsage(client));
      if (!gate.ok) {
        report.reason = gate.reason;
        report.status = gate.code === "halted" ? "halted" : "budget";
        break;
      }

      const { data: claimed, error: claimError } = await client.rpc("ai_claim_citizens", {
        p_run: runId,
        p_limit: config.aiDecisionsPerRun,
        p_interval: `${config.aiMinDecisionIntervalSeconds} seconds`,
      });
      if (claimError) {
        if (report.claimed === 0) {
          await attachCitizenCommerce();
          return emptyReport("error", config, "The decision claim failed.");
        }
        report.reason = report.reason ?? "The decision claim failed.";
        break;
      }
      const queue = (claimed ?? []) as Array<{ claimed_citizen_id: string; token_id: string }>;
      if (queue.length === 0) {
        if (report.claimed === 0) {
          await attachTreasury();
          await attachWalletIssuance();
          await attachCitizenCommerce();
          await client
            .from("ai_scheduler_state")
            .update({ last_run_at: new Date().toISOString(), last_error: report.reason ?? null })
            .eq("singleton", true);
          if (report.status === "halted" || report.status === "budget") return report;
          return { ...report, status: "idle", reason: report.reason ?? "No eligible citizens." };
        }
        break;
      }
      report.claimed += queue.length;

      for (const row of queue) {
      let decided = false;
      try {
        if (endRun) {
          continue;
        }
        const providerTimeoutMs = timeoutWithinDeadline(startedAt, config.aiRequestTimeoutMs, Date.now(), deadlineMs);
        if (providerTimeoutMs === null) {
          deferForDeadline(row.token_id);
          continue;
        }

        const currentUsage = await readUsage(client);
        const still = evaluateBudget(config, currentUsage);
        if (!still.ok) {
          report.reason = still.reason;
          report.status = still.code === "halted" ? "halted" : "budget";
          endRun = true;
          continue;
        }

        const bundle = await loadCitizenBundle(client, row.claimed_citizen_id);
        if (!bundle || bundle.citizen.activity === "unavailable") {
          report.decisions.push({ tokenId: row.token_id, status: "skipped", detail: "citizen context unavailable" });
          continue;
        }

        const overlay = bundle.overlayTiles;
        const buildingRects = bundle.buildings.map((building) => ({
          x: building.x,
          y: building.y,
          w: building.w,
          h: building.h,
        }));
        const plots = surveyedPlots(overlay);
        const townNeeds = await loadTownNeeds(client, bundle.buildings, bundle.stock, bundle.occupiedPlots, overlay);
        const townProjects = await loadTownProjects(client);
        const civic = await loadCivicFacts(client);
        let canBuildKinds = feasibleConstructKinds(bundle.buildings, bundle.occupiedPlots, bundle.stock, overlay);
        if (
          civic &&
          civicMenu(civic).raiseJail &&
          materialsAllowBuilderShift(bundle.stock) &&
          !bundle.buildings.some((building) => building.kind === "jail")
        ) {
          const jailPlan = planConstruction(bundle.buildings, bundle.occupiedPlots, "jail", overlay);
          if (jailPlan.ok) {
            canBuildKinds = [...canBuildKinds, "jail"];
          }
        }
        const eligibleStubs = bundle.roadsReady
          ? eligibleRoadStubs({
              placedStubIds: bundle.placedStubIds,
              overlayTiles: overlay,
              buildings: buildingRects,
              stock: bundle.stock,
            })
          : [];
        const context = buildDecisionContext({
          citizenId: row.claimed_citizen_id,
          citizen: bundle.citizen,
          buildings: bundle.buildings,
          worldS: bundle.worldS,
          stock: bundle.stock,
          personality: bundle.personality,
          skills: bundle.skills,
          goals: bundle.goals,
          memories: bundle.memories,
          canBuild: canBuildKinds.length > 0 || eligibleStubs.length > 0,
          canBuildKinds,
          townNeeds,
          vacantServedLots: plots.filter((plot) => plot.served && !bundle.occupiedPlots.has(plot.id)).length,
          reservedLots: plots.filter((plot) => !plot.served).length,
          eligibleRoadStubs: eligibleStubs.map((stub) => ({
            id: stub.id,
            name: stub.name,
            servesPlotIds: stub.servesPlotIds,
          })),
          completedRoadIds: [...bundle.placedStubIds],
          townProjects,
          civic: civic ?? undefined,
        });
        const commitment = contextCommitment(context);
        const messages = decisionMessages(context, config.aiMaxPromptChars);

        if (!landCanGrow(context)) {
          const reason = growthBlocker(context);
          const { error: blockedError } = await client.from("ai_decisions").insert({
            citizen_id: row.claimed_citizen_id,
            purpose: "citizen_turn",
            status: "rejected",
            provider: config.aiProvider,
            model: config.aiModel,
            input_commitment: commitment,
            validation_result: reason,
          });
          if (blockedError) {
            report.decisions.push({ tokenId: row.token_id, status: "failed", detail: "could not persist the decision row" });
            continue;
          }
          decided = true;
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "blocked", detail: reason });
          continue;
        }

        const slot = await takeModelSlot();
        if (!slot) {
          deferForDeadline(row.token_id);
          continue;
        }

        const { data: inserted, error: insertError } = await client
          .from("ai_decisions")
            .insert({
            citizen_id: row.claimed_citizen_id,
            purpose: "citizen_turn",
            status: "draft",
            provider: config.aiProvider,
            model: config.aiModel,
            input_commitment: commitment,
          })
          .select("id")
          .single();
        if (insertError || !inserted) {
          report.decisions.push({ tokenId: row.token_id, status: "failed", detail: "could not persist the decision row" });
          continue;
        }
        const decisionId = inserted.id as string;

        let completion;
        try {
          completion = await provider.complete({
            purpose: "citizen_turn",
            messages: [
              { role: "system", content: messages.system },
              { role: "user", content: messages.user },
            ],
            responseSchema: GROWTH_RESPONSE_SCHEMA,
            timeoutMs: slot.timeoutMs,
            maxOutputTokens: config.aiMaxOutputTokens,
          });
        } catch (error) {
          const providerError =
            error instanceof AiProviderError
              ? error
              : new AiProviderError(error instanceof Error ? error.message : "provider failed", "unavailable", false);
          await client
            .from("ai_decisions")
            .update({ status: "failed", last_error: providerError.message })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "failed", detail: providerError.message });
          if (providerError.halt) {
            const halt = haltFromError(providerError);
            if (halt) {
              await haltScheduler(client, halt.until, halt.reason);
              report.status = providerError.code === "quota" || providerError.code === "billing" ? "halted" : "halted";
              report.reason = halt.reason;
            }
            endRun = true;
            continue;
          }
          continue;
        }

        report.inferred += 1;
        decided = true;
        await bumpUsage(client, completion.promptChars ?? messages.system.length + messages.user.length, completion.outputTokens);

        let parsed: { ok: true; decision: ParsedDecision } | { ok: false; reason: string } = parseDecisionOutput(completion.text);
        let accepted = parsed.ok ? acceptGrowth(parsed.decision, context) : parsed;
        if (!accepted.ok) {
          const retrySlot = await takeModelSlot();
          if (retrySlot) {
            let retry: AiCompletion;
            try {
              retry = await provider.complete({
                purpose: "citizen_turn",
                messages: [
                  { role: "system", content: messages.system },
                  {
                    role: "user",
                    content: `${messages.user}\n\nThe land did not accept the last answer (${accepted.reason}). Read the description again and decide how this town grows. Daily life is already simulated.`,
                  },
                ],
                responseSchema: GROWTH_RESPONSE_SCHEMA,
                timeoutMs: retrySlot.timeoutMs,
                maxOutputTokens: config.aiMaxOutputTokens,
              });
            } catch (error) {
              const providerError =
                error instanceof AiProviderError
                  ? error
                  : new AiProviderError(error instanceof Error ? error.message : "provider failed", "unavailable", false);
              await client
                .from("ai_decisions")
                .update({ status: "failed", last_error: providerError.message })
                .eq("id", decisionId);
              report.rejected += 1;
              report.decisions.push({ tokenId: row.token_id, status: "failed", detail: providerError.message });
              if (providerError.halt) {
                const halt = haltFromError(providerError);
                if (halt) {
                  await haltScheduler(client, halt.until, halt.reason);
                  report.status = "halted";
                  report.reason = halt.reason;
                }
                endRun = true;
                continue;
              }
              continue;
            }
            report.inferred += 1;
            completion = retry;
            await bumpUsage(client, retry.promptChars ?? messages.system.length + messages.user.length, retry.outputTokens);
            parsed = parseDecisionOutput(retry.text);
            accepted = parsed.ok ? acceptGrowth(parsed.decision, context) : parsed;
          }
        }
        if (!accepted.ok) {
          await client
            .from("ai_decisions")
            .update({
              status: "rejected",
              rationale: null,
              output: { raw: completion.text.slice(0, 500) },
              validation_result: accepted.reason,
              model: completion.model,
            })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: accepted.reason });
          continue;
        }
        parsed = { ok: true, decision: accepted.decision };

        await client
          .from("ai_decisions")
          .update({
            status: "proposed",
            rationale: parsed.decision.rationale,
            output: jsonSafeDecision(parsed.decision),
            proposed_action: jsonSafeDecision(parsed.decision),
            model: completion.model,
            provider: completion.provider,
          })
          .eq("id", decisionId);

        if (isCivicAction(parsed.decision.action)) {
          const applied = await applyCivicDecision(
            client,
            decisionId,
            String(row.token_id),
            row.claimed_citizen_id,
            parsed.decision,
            bundle,
          );
          if (!applied.ok) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: applied.detail })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: applied.detail });
            continue;
          }
          await client
            .from("ai_decisions")
            .update({
              status: applied.queued ? "queued" : "executed",
              intent_id: applied.intentId,
              validation_result: applied.queued ? null : applied.detail,
            })
            .eq("id", decisionId);
          report.submitted += 1;
          report.decisions.push({
            tokenId: row.token_id,
            status: applied.queued ? "queued" : "executed",
            detail: applied.detail,
          });
          continue;
        }

        if (isActivationAction(parsed.decision.action)) {
          const draft = activationDraftFromDecision({
            id: decisionId,
            citizenId: row.claimed_citizen_id,
            tokenId: bundle.citizen.tokenId,
            nftContract: config.chogNftAddress,
            decisionId,
            decision: parsed.decision,
            createdAt: new Date().toISOString(),
          });
          if (!isActivationDraft(draft)) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: draft.reason })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: draft.reason });
            continue;
          }
          const evaluated = evaluateDecisionActivation({
            request: draft,
            existing: null,
            runtime: productionBankRuntime(config),
          });
          const detail =
            evaluated.decision.action === "approve"
              ? "ChogBank approved the request; deployment still requires a later authorized job"
              : evaluated.decision.reason;
          await client
            .from("ai_decisions")
            .update({
              status: evaluated.decision.action === "reject" ? "rejected" : "queued",
              validation_result: detail,
              output: {
                ...jsonSafeDecision(parsed.decision),
                bank: {
                  action: evaluated.decision.action,
                  reason: "reason" in evaluated.decision ? evaluated.decision.reason : null,
                  state: evaluated.request.state,
                },
              },
            })
            .eq("id", decisionId);
          if (evaluated.decision.action === "reject") {
            report.rejected += 1;
          } else {
            report.submitted += 1;
          }
          report.decisions.push({
            tokenId: row.token_id,
            status: evaluated.request.state,
            detail,
          });
          continue;
        }

        if (parsed.decision.action === "build") {
          const buildKind = parsed.decision.buildKind;
          if (buildKind === "none") {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: "unsupported build kind" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: "unsupported build kind" });
            continue;
          }
          if (!materialsAllowBuilderShift(bundle.stock)) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: "not enough wood and stone in the Storehouse" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({
              tokenId: row.token_id,
              status: "rejected",
              detail: "not enough wood and stone in the Storehouse",
            });
            continue;
          }
          if (buildKind === "road") {
            const stubId = parsed.decision.roadStubId;
            if (stubId === "none") {
              await client
                .from("ai_decisions")
                .update({ status: "rejected", validation_result: "unknown road stub" })
                .eq("id", decisionId);
              report.rejected += 1;
              report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: "unknown road stub" });
              continue;
            }
            const check = validateRoadStubPlacement({
              stubId,
              placedStubIds: bundle.placedStubIds,
              overlayTiles: overlay,
              buildings: buildingRects,
            });
            if (!check.ok) {
              await client
                .from("ai_decisions")
                .update({ status: "rejected", validation_result: check.reason })
                .eq("id", decisionId);
              report.rejected += 1;
              report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: check.reason });
              continue;
            }
            const { data: placedRoad, error: roadError } = await client.rpc("world_place_road", {
              p_stub: stubId,
              p_source: "ai",
              p_decision: decisionId,
              p_citizen: row.claimed_citizen_id,
            });
            const roadResult = placedRoad as { ok?: boolean; reason?: string } | null;
            if (roadError || !roadResult?.ok) {
              await client
                .from("ai_decisions")
                .update({ status: "rejected", validation_result: roadResult?.reason ?? "placement rejected" })
                .eq("id", decisionId);
              report.rejected += 1;
              report.decisions.push({
                tokenId: row.token_id,
                status: "rejected",
                detail: roadResult?.reason ?? "placement rejected",
              });
              continue;
            }
            report.constructed += 1;
            await linkTownProject(
              client,
              townProjects,
              parsed.decision,
              decisionId,
              row.claimed_citizen_id,
            );
            report.decisions.push({
              tokenId: row.token_id,
              status: "constructed",
              detail: `Placed ${check.stub.name}`,
            });
            continue;
          }
          if (!canBuildKinds.includes(buildKind as ConstructKind)) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: "construction is not available for that kind" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({
              tokenId: row.token_id,
              status: "rejected",
              detail: "construction is not available for that kind",
            });
            continue;
          }
          const plan = planConstruction(bundle.buildings, bundle.occupiedPlots, buildKind as ConstructKind, overlay);
          if (!plan.ok) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: plan.reason })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: plan.reason });
            continue;
          }
          const { data: placed, error: placeError } = await client.rpc("world_place_building", {
            p_plot: plan.plan.plotId,
            p_kind: plan.plan.kind,
            p_id: plan.plan.buildingId,
            p_name: parsed.decision.placeName ?? plan.plan.name,
            p_door_x: plan.plan.door.x,
            p_door_y: plan.plan.door.y,
            p_routes: plan.plan.routes,
            p_source: "ai",
            p_decision: decisionId,
            p_citizen: row.claimed_citizen_id,
          });
          const result = placed as { ok?: boolean; reason?: string; buildingId?: string } | null;
          if (placeError || !result?.ok) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: result?.reason ?? "placement rejected" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({
              tokenId: row.token_id,
              status: "rejected",
              detail: result?.reason ?? "placement rejected",
            });
            continue;
          }
          report.constructed += 1;
          await linkTownNeed(client, townNeeds, bundle.citizen, "build", buildKind, decisionId);
          await linkTownProject(client, townProjects, parsed.decision, decisionId, row.claimed_citizen_id);
          const workTarget = result.buildingId ?? plan.plan.buildingId;
          const workProposal: ActionProposal = {
            tokenId: row.token_id,
            action: "work",
            buildingId: workTarget,
            source: "ai",
            decisionId,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          };
          const precheck = precheckAction(
            workProposal,
            { ...bundle.citizen, role: bundle.citizen.role ?? "builder", workId: workTarget },
            {
              ...bundle.buildings[0]!,
              id: workTarget,
              kind: plan.plan.kind,
              name: plan.plan.name,
              status: "under_construction",
              role: "builder",
              constructionProgress: 0,
            },
            bundle.worldS,
            bundle.stock,
          );
          if (precheck.ok) {
            const submitted = await submitIntent(workProposal);
            if (submitted.ok) {
              await client
                .from("ai_decisions")
                .update({ status: "queued", intent_id: submitted.intentId, validation_result: null })
                .eq("id", decisionId);
              report.submitted += 1;
            }
          }
          report.decisions.push({
            tokenId: row.token_id,
            status: "constructed",
            detail: `Started ${parsed.decision.placeName ?? plan.plan.name} on ${plan.plan.plotId}`,
          });
          continue;
        }

        if (isEconomyAction(parsed.decision.action)) {
          const draft = parsed.decision.economy;
          if (!draft) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: "economic proposal is required" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: "economic proposal is required" });
            continue;
          }
          const proposal = proposalFromDraft(draft, {
            id: decisionId,
            idempotencyKey: `economy:${decisionId}`,
            citizenId: row.claimed_citizen_id,
            tokenId: String(bundle.citizen.tokenId),
            nftContract: config.chogNftAddress,
            nowMs: Date.now(),
          });
          const nowMs = Date.now();
          let outcome = "deferred";
          let detail = "The economic proposal could not be saved.";
          let reserved = false;
          let executed = false;
          let observation = "unavailable";
          try {
            const ledger = await readEconomyLedger(client, nowMs);
            const evaluated = await evaluateProductionEconomy({
              config,
              proposal,
              nowMs,
              holds: ledger.complete ? ledger.holds : [],
              dailyGasWei: ledger.complete ? BigInt(ledger.dailyGasRaw) : 0n,
              dailyGasKnown: ledger.complete,
            });
            const persisted = await saveEconomyDecision(client, {
              proposal,
              decision: evaluated.decision,
              holds: evaluated.holds,
              observation: evaluated.observation,
            });
            outcome = persisted.ok ? persisted.status : evaluated.decision.outcome;
            reserved = persisted.ok ? persisted.reserved : false;
            executed = evaluated.decision.executed;
            observation = evaluated.observation.status;
            detail = persisted.ok ? evaluated.decision.reason : `${evaluated.decision.reason} ${persisted.reason}`;
          } catch {
            detail = "The economic proposal could not be saved.";
          }
          await client
            .from("ai_decisions")
            .update({
              status: outcome === "rejected" ? "rejected" : "queued",
              validation_result: detail,
              output: {
                ...jsonSafeDecision(parsed.decision),
                economyDecision: {
                  outcome,
                  reason: detail,
                  reserved,
                  executed,
                  observation,
                },
              },
            })
            .eq("id", decisionId);
          if (outcome === "rejected") {
            report.rejected += 1;
          } else {
            report.submitted += 1;
          }
          report.decisions.push({ tokenId: row.token_id, status: outcome, detail });
          continue;
        }

        if (!isWorldAction(parsed.decision.action)) {
          await client
            .from("ai_decisions")
            .update({ status: "rejected", validation_result: "unsupported action" })
            .eq("id", decisionId);
          report.rejected += 1;
          continue;
        }

        const allowed = context.feasible.some(
          (option) => option.action === parsed.decision.action && option.buildingId === parsed.decision.buildingId,
        );
        if (!allowed) {
          await client
            .from("ai_decisions")
            .update({ status: "rejected", validation_result: "action is not currently feasible" })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: "action is not currently feasible" });
          continue;
        }

        const proposal: ActionProposal = {
          tokenId: row.token_id,
          action: parsed.decision.action,
          buildingId: parsed.decision.buildingId,
          source: "ai",
          decisionId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
        const shape = validateProposal(proposal);
        if (!shape.ok) {
          await client
            .from("ai_decisions")
            .update({ status: "rejected", validation_result: shape.reason })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: shape.reason });
          continue;
        }
        const building = bundle.buildings.find((item) => item.id === proposal.buildingId);
        const precheck = precheckAction(proposal, bundle.citizen, building, bundle.worldS, bundle.stock);
        if (!precheck.ok) {
          await client
            .from("ai_decisions")
            .update({ status: "rejected", validation_result: precheck.reason })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: precheck.reason });
          continue;
        }
        const submitted = await submitIntent(proposal);
        if (!submitted.ok) {
          await client
            .from("ai_decisions")
            .update({ status: "rejected", validation_result: submitted.detail })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: submitted.detail });
          continue;
        }
        await client
          .from("ai_decisions")
          .update({ status: "queued", intent_id: submitted.intentId, validation_result: null })
          .eq("id", decisionId);
        report.submitted += 1;
        await linkTownNeed(client, townNeeds, bundle.citizen, proposal.action, "none", decisionId);
        await linkTownProject(client, townProjects, parsed.decision, decisionId, row.claimed_citizen_id);
        report.decisions.push({
          tokenId: row.token_id,
          status: "queued",
          detail: `${proposal.action} at ${proposal.buildingId}`,
        });
      } finally {
        await client.rpc("world_release_claim", {
          p_citizen: row.claimed_citizen_id,
          p_run: runId,
          p_decided: decided,
        });
      }
      }
    }

    await attachTreasury();
    await attachWalletIssuance();
    await attachCitizenCommerce();
    const schedulerPatch: Record<string, unknown> = {
      last_run_at: new Date().toISOString(),
      last_error: report.reason ?? null,
      consecutive_failures: report.inferred === 0 && report.rejected > 0 ? 1 : 0,
    };
    if (report.inferred > 0) {
      schedulerPatch.last_success_at = new Date().toISOString();
    }
    await client.from("ai_scheduler_state").update(schedulerPatch).eq("singleton", true);
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The AI runner failed.";
    await client
      .from("ai_scheduler_state")
      .update({ last_run_at: new Date().toISOString(), last_error: message })
      .eq("singleton", true);
    return emptyReport("error", config, message);
  }
}

