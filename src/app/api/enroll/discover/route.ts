import { NextResponse } from "next/server";
import type { Address } from "viem";
import { z } from "zod";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { discoverOwnedTokens, parseWallet } from "@/lib/civilization/enrollment-flow";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { sameAddress } from "@/lib/civilization/token-id";
import type { CitizenRecord } from "@/lib/civilization/types";
import { readAppConfig } from "@/lib/config/env";

const bodySchema = z.object({
  address: z.string(),
});

export async function POST(request: Request) {
  const json = await readJson(request);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Send the connected wallet address." }, { status: 400 });
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
      onlyTokenIds: null,
    });
    if (!result.ok) {
      return NextResponse.json(result, { status: 422 });
    }
    const citizens = await readCitizens();
    const owned = result.owned.map((token) => {
      const record = citizens.find(
        (citizen) =>
          citizen.tokenId === token.tokenId &&
          citizen.chainId === config.chainId &&
          sameAddress(citizen.nftContract, config.chogNftAddress),
      );
      return presentOwned(token, record, config.chogTreasuryAddress);
    });
    return NextResponse.json({ ...result, owned });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 280) : "Discovery failed.",
      },
      { status: 502 },
    );
  }
}

function presentOwned(
  token: { tokenId: string; owner: Address },
  record: CitizenRecord | undefined,
  treasury: Address,
) {
  const active = record?.enrollmentStatus === "active";
  return {
    tokenId: token.tokenId,
    owner: token.owner,
    heldByTreasury: sameAddress(token.owner, treasury),
    enrolledAt: active ? record?.enrolledAt ?? null : null,
    enrollmentStatus: record?.enrollmentStatus ?? null,
    origin: record?.origin ?? null,
    citizenId: active ? record?.id ?? null : null,
  };
}

async function readCitizens(): Promise<CitizenRecord[]> {
  const store = openCivilizationStore();
  if (!store) {
    return [];
  }
  try {
    return await store.listCitizens();
  } catch {
    return [];
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
