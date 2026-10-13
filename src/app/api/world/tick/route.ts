import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";

/**
 * Optional external runner. pg_cron is the primary scheduler. A tick only
 * advances the shared clock and applies due transitions; it cannot choose
 * actions, move assets, or change world settings.
 */
export async function POST(request: Request) {
  const config = readAppConfig();
  if (!config.worldRunnerSecret) {
    return NextResponse.json(
      { ok: false, error: "Set WORLD_RUNNER_SECRET before using the HTTP runner. The route stays closed until then." },
      { status: 403 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), config.worldRunnerSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`world-tick:${clientKey(request)}`, 30)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  }

  const { data, error } = await createServiceRoleClient().rpc("world_tick");
  if (error) {
    return NextResponse.json({ ok: false, error: "The tick failed. Check the database logs." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, result: data });
}
