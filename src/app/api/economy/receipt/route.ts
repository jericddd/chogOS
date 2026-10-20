import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { loadPublicReceipt } from "@/lib/economy/load";

const NO_STORE = { "cache-control": "no-store" };

/** Read-only recheck of one recorded economy hash. It does not settle or broadcast. */
export async function GET(request: Request) {
  if (!rateLimit(`economy-receipt:${clientKey(request)}`, 12)) {
    return NextResponse.json(
      { ok: false, status: "pending_or_unavailable", fresh: false, cached: false, reason: "Too many requests." },
      { status: 429, headers: NO_STORE },
    );
  }
  const tx = new URL(request.url).searchParams.get("tx");
  const result = await loadPublicReceipt(tx);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
