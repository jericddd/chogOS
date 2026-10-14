import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { loadVerifyBundle } from "@/lib/verify/load";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read-only verification bundle. The client must recompute hashes and proofs. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!rateLimit(`verify-event:${clientKey(_request)}`, 40)) {
    return NextResponse.json({ status: "error", detail: "Too many requests." }, { status: 429, headers: NO_STORE });
  }
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ status: "error", detail: "Event id must be a UUID." }, { status: 400, headers: NO_STORE });
  }
  const bundle = await loadVerifyBundle(id);
  if ("status" in bundle && bundle.status === "missing") {
    return NextResponse.json({ status: "missing", detail: "No event with that id." }, { status: 404, headers: NO_STORE });
  }
  if ("status" in bundle && bundle.status === "unconfigured") {
    return NextResponse.json({ status: "error", detail: bundle.detail }, { status: 503, headers: NO_STORE });
  }
  const exportJson = new URL(_request.url).searchParams.get("export") === "1";
  const body = JSON.stringify(bundle, null, exportJson ? 2 : 0);
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": "application/json; charset=utf-8",
      ...(exportJson
        ? { "content-disposition": `attachment; filename="chogos-event-${id}.json"` }
        : {}),
    },
  });
}
