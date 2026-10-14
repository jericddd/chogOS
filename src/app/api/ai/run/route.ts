import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { runAiMind } from "@/lib/ai/runner";
import { readAppConfig } from "@/lib/config/env";

/**
 * Cloud-side AI decision runner. Independent of world_tick and of the browser.
 * Closed until AI_RUNNER_SECRET and AI_RUNNER_ENABLED=true are set.
 */
export async function POST(request: Request) {
  const config = readAppConfig();
  if (!config.aiRunnerSecret) {
    return NextResponse.json(
      { ok: false, error: "Set AI_RUNNER_SECRET before using the AI runner. The route stays closed until then." },
      { status: 403 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), config.aiRunnerSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`ai-run:${clientKey(request)}`, 10)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  const report = await runAiMind(config);
  const status =
    report.status === "unconfigured" ? 503 : report.status === "disabled" ? 403 : report.status === "error" ? 502 : 200;
  return NextResponse.json({ ok: report.status === "ran" || report.status === "idle", report }, { status });
}
