import "server-only";
import { randomUUID } from "node:crypto";
import { getAiProvider } from "@/lib/ai/provider";
import { evaluateBudget, haltFromError, isRetriableHaltReason, usagePeriods, type UsageSnapshot } from "@/lib/ai/budget";
import { timeoutWithinDeadline } from "@/lib/ai/invocation";
import { buildDecisionContext, contextCommitment, decisionMessages } from "@/lib/ai/context";
import { DECISION_RESPONSE_SCHEMA, isWorldAction, parseDecisionOutput } from "@/lib/ai/schema";
import { AiProviderError } from "@/lib/ai/types";
import type { PersonalityTraits } from "@/lib/ai/personality";
import { readAppConfig, type AppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { precheckAction, validateProposal, type ActionProposal } from "@/lib/world/actions";
import { submitIntent } from "@/lib/world/intents";
import { planHousePlacement } from "@/lib/world/placement";
import { toBuilding, toCitizen, type BuildingRow, type CitizenRow } from "@/lib/world/rows";
import type { BuildingView, CitizenView } from "@/lib/world/types";

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
} | null> {
  const [state, buildingsRes, world, personality, skills, goals, memories, plots] = await Promise.all([
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
  };
}

export async function runAiMind(config: AppConfig = readAppConfig()): Promise<MindRunReport> {
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

    const { data: claimed, error: claimError } = await client.rpc("ai_claim_citizens", {
      p_run: runId,
      p_limit: config.aiDecisionsPerRun,
      p_interval: `${config.aiMinDecisionIntervalSeconds} seconds`,
    });
    if (claimError) {
      return emptyReport("error", config, "The decision claim failed.");
    }
    const queue = (claimed ?? []) as Array<{ claimed_citizen_id: string; token_id: string }>;
    report.claimed = queue.length;
    if (queue.length === 0) {
      await client
        .from("ai_scheduler_state")
        .update({ last_run_at: new Date().toISOString(), last_error: null })
        .eq("singleton", true);
      return { ...report, status: "idle", reason: "No eligible citizens." };
    }

    const provider = getAiProvider(config);
    const startedAt = Date.now();

    for (const row of queue) {
      let decided = false;
      try {
        const providerTimeoutMs = timeoutWithinDeadline(startedAt, config.aiRequestTimeoutMs);
        if (providerTimeoutMs === null) {
          report.reason = report.reason ?? "Stopped remaining citizens before the host timeout.";
          report.decisions.push({
            tokenId: row.token_id,
            status: "deferred",
            detail: "stopped before the host timeout",
          });
          continue;
        }

        const currentUsage = await readUsage(client);
        const still = evaluateBudget(config, currentUsage);
        if (!still.ok) {
          report.reason = still.reason;
          report.status = still.code === "halted" ? "halted" : "budget";
          break;
        }

        const bundle = await loadCitizenBundle(client, row.claimed_citizen_id);
        if (!bundle || bundle.citizen.activity === "unavailable") {
          report.decisions.push({ tokenId: row.token_id, status: "skipped", detail: "citizen context unavailable" });
          continue;
        }

        const canBuild = planHousePlacement(bundle.buildings, bundle.occupiedPlots).ok;
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
          canBuild,
        });
        const commitment = contextCommitment(context);
        const messages = decisionMessages(context, config.aiMaxPromptChars);

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
            responseSchema: DECISION_RESPONSE_SCHEMA,
            timeoutMs: providerTimeoutMs,
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
            break;
          }
          continue;
        }

        report.inferred += 1;
        decided = true;
        await bumpUsage(client, completion.promptChars ?? messages.system.length + messages.user.length, completion.outputTokens);

        const parsed = parseDecisionOutput(completion.text);
        if (!parsed.ok) {
          await client
            .from("ai_decisions")
            .update({
              status: "rejected",
              rationale: null,
              output: { raw: completion.text.slice(0, 500) },
              validation_result: parsed.reason,
              model: completion.model,
            })
            .eq("id", decisionId);
          report.rejected += 1;
          report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: parsed.reason });
          continue;
        }

        await client
          .from("ai_decisions")
          .update({
            status: "proposed",
            rationale: parsed.decision.rationale,
            output: parsed.decision,
            proposed_action: parsed.decision,
            model: completion.model,
            provider: completion.provider,
          })
          .eq("id", decisionId);

        if (parsed.decision.action === "build") {
          if (!context.canBuild) {
            await client
              .from("ai_decisions")
              .update({ status: "rejected", validation_result: "no vacant road-served plot is available" })
              .eq("id", decisionId);
            report.rejected += 1;
            report.decisions.push({ tokenId: row.token_id, status: "rejected", detail: "construction is not available" });
            continue;
          }
          const plan = planHousePlacement(bundle.buildings, bundle.occupiedPlots);
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
            p_kind: "house",
            p_id: plan.plan.buildingId,
            p_name: plan.plan.name,
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
              kind: "house",
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
            detail: `Started ${plan.plan.name} on ${plan.plan.plotId}`,
          });
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

