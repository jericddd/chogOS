import { NextResponse } from "next/server";
import { z } from "zod";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { loadEventPage } from "@/lib/world/load";
import { EVENT_CATEGORIES, EVENT_SOURCES } from "@/lib/world/types";

const NO_STORE = { "Cache-Control": "no-store" };

const query = z.object({
  before: z.string().regex(/^[0-9]{1,15}$/).transform(Number).optional(),
  limit: z.string().regex(/^[0-9]{1,2}$/).transform(Number).optional(),
  category: z.enum(EVENT_CATEGORIES as [string, ...string[]]).optional(),
  source: z.enum(EVENT_SOURCES as [string, ...string[]]).optional(),
  citizen: z.string().regex(/^[0-9]{1,78}$/).optional(),
  building: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
});

/** Read-only, paginated history. Newest first. */
export async function GET(request: Request) {
  if (!rateLimit(`world-events:${clientKey(request)}`, 90)) {
    return NextResponse.json({ status: "error", detail: "Too many requests." }, { status: 429, headers: NO_STORE });
  }
  const params = Object.fromEntries(
    [...new URL(request.url).searchParams.entries()].filter(([, value]) => value !== ""),
  );
  const parsed = query.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { status: "error", detail: "Invalid filter. Use before, limit, category, source, citizen, or building." },
      { status: 400, headers: NO_STORE },
    );
  }
  const { before, limit, category, source, citizen, building } = parsed.data;
  const page = await loadEventPage(
    {
      category: category as (typeof EVENT_CATEGORIES)[number] | undefined,
      source: source as (typeof EVENT_SOURCES)[number] | undefined,
      tokenId: citizen,
      buildingId: building,
    },
    before ?? null,
    limit ?? 20,
  );
  const status = page.status === "ok" ? 200 : page.status === "error" ? 502 : 503;
  return NextResponse.json(page, { status, headers: NO_STORE });
}
