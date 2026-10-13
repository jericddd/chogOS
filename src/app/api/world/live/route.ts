import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { loadLive } from "@/lib/world/load";

const NO_STORE = { "Cache-Control": "no-store" };

/** Read-only. Returns the shared world state and events after `since`. */
export async function GET(request: Request) {
  if (!rateLimit(`world-live:${clientKey(request)}`, 120)) {
    return NextResponse.json({ status: "error", detail: "Too many requests." }, { status: 429, headers: NO_STORE });
  }
  const raw = new URL(request.url).searchParams.get("since");
  let since: number | null = null;
  if (raw !== null && raw !== "") {
    if (!/^[0-9]{1,15}$/.test(raw)) {
      return NextResponse.json(
        { status: "error", detail: "since must be a non-negative integer." },
        { status: 400, headers: NO_STORE },
      );
    }
    since = Number(raw);
  }

  const live = await loadLive(since);
  const status = live.status === "ok" ? 200 : live.status === "error" ? 502 : 503;
  return NextResponse.json(live, { status, headers: NO_STORE });
}
