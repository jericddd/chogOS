import "server-only";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import type { PersonalityTraits } from "@/lib/ai/personality";
import type { CitizenMindView, MindLoad } from "@/lib/ai/mind-view";

function asTraits(row: Record<string, unknown> | null): PersonalityTraits | null {
  if (!row) {
    return null;
  }
  const n = (key: string) => Number(row[key]);
  if (![n("sociability"), n("curiosity"), n("industriousness"), n("cooperation"), n("caution"), n("planning"), n("resourcefulness")].every((value) => Number.isFinite(value))) {
    return null;
  }
  const preferred = row.preferred_activity;
  return {
    sociability: n("sociability"),
    curiosity: n("curiosity"),
    industriousness: n("industriousness"),
    cooperation: n("cooperation"),
    caution: n("caution"),
    planning: n("planning"),
    resourcefulness: n("resourcefulness"),
    preferredActivity:
      preferred === "shop" || preferred === "socialize" || preferred === "rest" || preferred === "work"
        ? preferred
        : "work",
  };
}

function missingTable(message: string): boolean {
  return /schema cache|does not exist|could not find the table/i.test(message);
}

export async function loadCitizenMind(tokenId: string): Promise<MindLoad> {
  if (!/^[0-9]{1,78}$/.test(tokenId)) {
    return { status: "missing", detail: "Invalid token id." };
  }
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return { status: "unconfigured", detail: "Supabase is not configured." };
  }

  try {
    const client = createServiceRoleClient();
    const { data: citizen, error: citizenError } = await client
      .from("citizens")
      .select("id")
      .eq("chain_id", config.chainId)
      .eq("nft_contract", config.chogNftAddress)
      .eq("token_id", tokenId)
      .maybeSingle();
    if (citizenError) {
      if (missingTable(citizenError.message)) {
        return { status: "migration_pending", detail: "The Phase 4 mind tables have not been applied yet." };
      }
      return { status: "error", detail: "Could not read this citizen." };
    }
    if (!citizen) {
      return { status: "missing", detail: "No enrolled citizen holds this token." };
    }
    const citizenId = citizen.id as string;

    const [personality, skills, goals, memories, decisions] = await Promise.all([
      client.from("citizen_personalities").select("*").eq("citizen_id", citizenId).maybeSingle(),
      client
        .from("citizen_skills")
        .select("name, level, experience")
        .eq("citizen_id", citizenId)
        .order("level", { ascending: false }),
      client
        .from("citizen_goals")
        .select("id, kind, title, summary, status, progress, related_building_id")
        .eq("citizen_id", citizenId)
        .order("created_at", { ascending: false })
        .limit(6),
      client
        .from("ai_memories")
        .select("id, content, category, outcome, importance, created_at")
        .eq("citizen_id", citizenId)
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(8),
      client
        .from("ai_decisions")
        .select("id, status, purpose, rationale, output, provider, model, validation_result, intent_id, outcome_event_id, created_at")
        .eq("citizen_id", citizenId)
        .order("created_at", { ascending: false })
        .limit(6),
    ]);

    const firstError = [personality.error, skills.error, goals.error, memories.error, decisions.error].find(Boolean);
    if (firstError) {
      if (missingTable(firstError.message)) {
        return { status: "migration_pending", detail: "The Phase 4 mind tables have not been applied yet." };
      }
      return { status: "error", detail: "Could not read mind records." };
    }

    const mind: CitizenMindView = {
      tokenId,
      personality: asTraits((personality.data as Record<string, unknown> | null) ?? null),
      personalityOrigin: personality.data ? "deterministic" : null,
      skills: ((skills.data ?? []) as Array<{ name: string; level: number; experience?: number }>).map((row) => ({
        name: row.name,
        level: row.level,
        experience: row.experience ?? 0,
      })),
      goals: ((goals.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        title: String(row.title),
        summary: String(row.summary),
        status: String(row.status),
        progress: Number(row.progress),
        relatedBuildingId: (row.related_building_id as string | null) ?? null,
      })),
      memories: ((memories.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        content: String(row.content),
        category: (row.category as string | null) ?? null,
        outcome: (row.outcome as string | null) ?? null,
        importance: Number(row.importance),
        createdAt: String(row.created_at),
      })),
      decisions: ((decisions.data ?? []) as Array<Record<string, unknown>>).map((row) => {
        const output = row.output && typeof row.output === "object" ? (row.output as Record<string, unknown>) : null;
        return {
          id: String(row.id),
          status: String(row.status),
          purpose: String(row.purpose),
          summary: typeof output?.summary === "string" ? output.summary : null,
          rationale: (row.rationale as string | null) ?? null,
          provider: (row.provider as string | null) ?? null,
          model: (row.model as string | null) ?? null,
          validationResult: (row.validation_result as string | null) ?? null,
          intentId: (row.intent_id as string | null) ?? null,
          outcomeEventId: (row.outcome_event_id as string | null) ?? null,
          createdAt: String(row.created_at),
        };
      }),
      aiActive: ((decisions.data ?? []) as Array<Record<string, unknown>>).some((row) =>
        ["queued", "accepted", "proposed", "executed"].includes(String(row.status)),
      ),
    };

    return { status: "ok", mind };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "Could not read mind records." };
  }
}
