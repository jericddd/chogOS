import { NextResponse } from "next/server";
import { loadCitizenMind } from "@/lib/ai/load-mind";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Read-only citizen mind: personality, skills, goals, memories, decisions. */
export async function GET(request: Request) {
  if (!rateLimit(`world-mind:${clientKey(request)}`, 60)) {
    return NextResponse.json({ status: "error", detail: "Too many requests." }, { status: 429, headers: NO_STORE });
  }
  const tokenId = new URL(request.url).searchParams.get("citizen");
  if (!tokenId || !/^[0-9]{1,78}$/.test(tokenId)) {
    return NextResponse.json({ status: "error", detail: "citizen must be a token id." }, { status: 400, headers: NO_STORE });
  }
  const mind = await loadCitizenMind(tokenId);
  const status =
    mind.status === "ok" ? 200 : mind.status === "missing" ? 404 : mind.status === "error" ? 502 : 503;
  return NextResponse.json(mind, { status, headers: NO_STORE });
}
