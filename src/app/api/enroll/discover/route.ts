import { NextResponse } from "next/server";
import { z } from "zod";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { discoverOwnedTokens, parseWallet } from "@/lib/civilization/enrollment-flow";
import { readAppConfig } from "@/lib/config/env";

const bodySchema = z.object({
  address: z.string(),
  tokenIds: z.array(z.string()).max(50).optional(),
});

export async function POST(request: Request) {
  const json = await readJson(request);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Send an address and, optionally, up to 50 token ids." },
      { status: 400 },
    );
  }
  const wallet = parseWallet(parsed.data.address);
  if (!wallet) {
    return NextResponse.json({ ok: false, error: "That wallet address is not valid." }, { status: 400 });
  }

  try {
    const config = readAppConfig();
    const result = await discoverOwnedTokens({
      reader: createGenesisReaderForConfig(config),
      wallet,
      manualTokenIds: parsed.data.tokenIds ?? null,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 280) : "Discovery failed.",
        manualTokenIdsRequired: true,
      },
      { status: 502 },
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
