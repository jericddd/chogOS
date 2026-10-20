import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { activityCursorError, type DiscoveredActivityPage } from "@/lib/economy/discover-activity";
import { loadDiscoveredActivity } from "@/lib/economy/discover-load";

const NO_STORE = { "cache-control": "no-store" };
const ALLOWED = new Set(["cursor", "limit"]);

/** Bounded read of historical $CHOG transfers. It does not settle, record, or broadcast. */
export async function GET(request: Request) {
  if (!rateLimit(`economy-activity:${clientKey(request)}`, 8)) {
    return NextResponse.json(
      { ok: false, state: "budget", fresh: false, cached: false, reason: "Too many requests." },
      { status: 429, headers: NO_STORE },
    );
  }
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !ALLOWED.has(key.toLowerCase()))) {
    return NextResponse.json(
      {
        ok: false,
        state: "invalid_request",
        reason: "This endpoint only accepts cursor and limit. It does not accept a token, topic, or block range.",
      },
      { status: 400, headers: NO_STORE },
    );
  }
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) {
    return NextResponse.json(
      { ok: false, state: "invalid_request", reason: "The query is ambiguous." },
      { status: 400, headers: NO_STORE },
    );
  }
  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    if (!/^[1-3]$/.test(limitRaw)) {
      return NextResponse.json(
        { ok: false, state: "invalid_request", reason: "The result limit must be from 1 to 3." },
        { status: 400, headers: NO_STORE },
      );
    }
    limit = Number(limitRaw);
  }
  const cursor = url.searchParams.get("cursor");
  const cursorError = activityCursorError(cursor);
  if (cursorError) {
    return NextResponse.json(
      { ok: false, state: "invalid_cursor", reason: `${cursorError} No blocks were scanned.` },
      { status: 400, headers: NO_STORE },
    );
  }
  const page = await loadDiscoveredActivity(cursor, limit);
  const ok = page.state === "verified_page" || page.state === "empty_window";
  return NextResponse.json({ ok, ...page }, { status: statusFor(page), headers: NO_STORE });
}

function statusFor(page: DiscoveredActivityPage): number {
  if (page.state === "invalid_cursor") {
    return 400;
  }
  if (page.state === "unavailable") {
    return 503;
  }
  return 200;
}
