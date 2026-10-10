import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { clearWorldCache } from "@/lib/civilization/load-world";
import { runGenesisSync } from "@/lib/civilization/run-sync";
import { readAppConfig } from "@/lib/config/env";

export async function POST(request: Request) {
  const config = readAppConfig();
  if (!config.syncSecret) {
    return NextResponse.json(
      { ok: false, error: "Set SYNC_SECRET to use this route. The treasury page can refresh when the secret is unset." },
      { status: 403 },
    );
  }
  if (!authorized(request.headers.get("authorization"), config.syncSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const result = await runGenesisSync();
  clearWorldCache();
  const status = result.status === "succeeded" ? 200 : result.status === "skipped" ? 429 : 500;
  return NextResponse.json(result, { status });
}

function authorized(header: string | null, secret: string): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
