import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { loadOwnerlessChogBank } from "@/lib/economy/treasury-load";

const NO_STORE = { "cache-control": "no-store" };

/** Public ChogBank books. The same view the Economy page keeps. It does not sign or move funds. */
export async function GET(request: Request) {
  if (!rateLimit(`economy-bank:${clientKey(request)}`, 12)) {
    return NextResponse.json({ ok: false, reason: "Too many requests." }, { status: 429, headers: NO_STORE });
  }
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    return NextResponse.json(
      { ok: false, reason: "This endpoint does not take a query." },
      { status: 400, headers: NO_STORE },
    );
  }
  const view = await loadOwnerlessChogBank();
  return NextResponse.json({ ok: true, view }, { headers: NO_STORE });
}
