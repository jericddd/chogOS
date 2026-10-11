import { NextResponse } from "next/server";
import { z } from "zod";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { createEnrollmentChallenge, parseWallet } from "@/lib/civilization/enrollment-flow";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { readAppConfig } from "@/lib/config/env";

const bodySchema = z.object({
  address: z.string(),
  tokenIds: z.array(z.string()).min(1).max(50),
});

export async function POST(request: Request) {
  const store = openCivilizationStore();
  if (!store) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Enrollment needs Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then apply both SQL migrations.",
      },
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
    return NextResponse.json({ ok: false, error: "Send a wallet and 1 to 50 token ids." }, { status: 400 });
  }
  const wallet = parseWallet(parsed.data.address);
  if (!wallet) {
    return NextResponse.json({ ok: false, error: "That wallet address is not valid." }, { status: 400 });
  }

  try {
    const config = readAppConfig();
    const result = await createEnrollmentChallenge({
      store,
      reader: createGenesisReaderForConfig(config),
      chainId: config.chainId,
      nftContract: config.chogNftAddress,
      treasury: config.chogTreasuryAddress,
      wallet,
      tokenIds: parsed.data.tokenIds,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message.slice(0, 280) : "Could not create a challenge." },
      { status: 500 },
    );
  }
}
