import { NextResponse } from "next/server";
import { z } from "zod";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { parseWallet, submitEnrollment } from "@/lib/civilization/enrollment-flow";
import { clearWorldCache } from "@/lib/civilization/load-world";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { readAppConfig } from "@/lib/config/env";

const bodySchema = z.object({
  address: z.string(),
  nonce: z.string().min(8).max(128),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export async function POST(request: Request) {
  const store = openCivilizationStore();
  if (!store) {
    return NextResponse.json(
      { ok: false, error: "Enrollment needs Supabase before a citizen can be saved." },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    json = null;
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Send the wallet, nonce, and signature." }, { status: 400 });
  }
  const wallet = parseWallet(parsed.data.address);
  if (!wallet) {
    return NextResponse.json({ ok: false, error: "That wallet address is not valid." }, { status: 400 });
  }

  try {
    const config = readAppConfig();
    const result = await submitEnrollment({
      store,
      reader: createGenesisReaderForConfig(config),
      chainId: config.chainId,
      nftContract: config.chogNftAddress,
      treasury: config.chogTreasuryAddress,
      wallet,
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
    });
    if (result.ok) {
      clearWorldCache();
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 403 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message.slice(0, 280) : "Enrollment failed." },
      { status: 500 },
    );
  }
}
