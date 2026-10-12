import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer";
import { clientKey, rateLimit } from "@/lib/auth/rate-limit";
import { readAppConfig } from "@/lib/config/env";
import { configureCivilizationTreasury } from "@/lib/wallets/service";

export async function POST(request: Request) {
  const config = readAppConfig();
  if (!config.treasuryAdminSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: "Set TREASURY_ADMIN_SECRET before recording a civilization treasury address. The route stays closed until then.",
      },
      { status: 403 },
    );
  }
  if (!bearerMatches(request.headers.get("authorization"), config.treasuryAdminSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!rateLimit(`treasury-configure:${clientKey(request)}`)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Wait and try again." }, { status: 429 });
  }

  const body = await readBody(request);
  if (!body.ok) {
    return NextResponse.json({ ok: false, error: body.error }, { status: 400 });
  }
  if (!isAddressBody(body.value)) {
    return NextResponse.json(
      { ok: false, error: 'Send { "address": "0x..." }. Chain, status, and verification are decided by the server.' },
      { status: 400 },
    );
  }

  const result = await configureCivilizationTreasury(body.value.address);
  if (!result.ok) {
    const status = result.reason === "rejected" ? 400 : 503;
    return NextResponse.json({ ok: false, error: result.detail }, { status });
  }

  revalidatePath("/treasury");
  revalidatePath("/economy");
  return NextResponse.json({
    ok: true,
    chainId: result.value.chainId,
    address: result.value.address,
    status: result.value.status,
    accountType: result.value.accountType,
    verification: result.value.verification,
    safeVersion: result.value.safeVersion,
    detail: result.value.detail,
  });
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, error: "Send a JSON body." };
  }
}

function isAddressBody(value: unknown): value is { address: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("chainId" in record || "status" in record || "verification" in record || "amount" in record) {
    return false;
  }
  return typeof record.address === "string";
}
