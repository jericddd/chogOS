import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import {
  deadlineForRequest,
  finishBeforeCutoff,
  MIND_CUTOFF_REASON,
  RESPONSE_CUTOFF,
  responseBudgetForRequest,
} from "@/lib/ai/invocation";
import { runAiMind } from "@/lib/ai/runner";
import { readAppConfig } from "@/lib/config/env";

/** Hobby maximum is 300s. New Gemini calls stop earlier, and the handler returns a body at the response budget. */
export const maxDuration = 300;

/**
 * Cloud-side AI decision runner. Independent of world_tick and of the browser.
 * Closed until AI_RUNNER_SECRET or CRON_SECRET is set, and AI_RUNNER_ENABLED=true.
 * Vercel Cron issues GET with Authorization: Bearer <CRON_SECRET>.
 */
function authorize(request: Request): NextResponse | null {
  const config = readAppConfig();
  const secrets = [config.aiRunnerSecret, config.cronSecret].filter((value): value is string => Boolean(value));
  if (secrets.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Set AI_RUNNER_SECRET or CRON_SECRET before using the AI runner. The route stays closed until then." },
      { status: 403 },
    );
  }
  if (!secrets.some((secret) => bearerMatches(request.headers.get("authorization"), secret))) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`ai-run:${clientKey(request)}`, 10)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  return null;
}

async function handle(request: Request): Promise<NextResponse> {
  const denied = authorize(request);
  if (denied) {
    return denied;
  }
  const config = readAppConfig();
  const outcome = await finishBeforeCutoff(runAiMind(config, deadlineForRequest(request)), responseBudgetForRequest(request));
  const report =
    outcome === RESPONSE_CUTOFF
      ? {
          status: "idle" as const,
          provider: config.aiProvider,
          model: config.aiModel ?? null,
          reason: MIND_CUTOFF_REASON,
          claimed: 0,
          inferred: 0,
          submitted: 0,
          constructed: 0,
          rejected: 0,
          decisions: [],
        }
      : outcome;
  const status =
    report.status === "unconfigured" ? 503 : report.status === "disabled" ? 403 : report.status === "error" ? 502 : 200;
  return NextResponse.json({ ok: report.status === "ran" || report.status === "idle", report }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
