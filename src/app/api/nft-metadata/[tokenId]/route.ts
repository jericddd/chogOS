import { NextResponse } from "next/server";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { resolveTokenMetadata } from "@/lib/civilization/metadata-load";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { parseTokenId } from "@/lib/civilization/token-id";
import { readAppConfig } from "@/lib/config/env";

export async function GET(_request: Request, context: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await context.params;
  const parsed = parseTokenId(tokenId);
  if (!parsed.ok) {
    return NextResponse.json({ status: "unavailable", error: parsed.reason }, { status: 400 });
  }

  try {
    const config = readAppConfig();
    const reader = createGenesisReaderForConfig(config);
    const tokenUri = await reader.readTokenUri(parsed.tokenId);
    const metadata = await resolveTokenMetadata({ tokenUri, gateway: config.ipfsGateway });
    if (metadata.status === "fetched") {
      const store = openCivilizationStore();
      if (store) {
        try {
          await store.saveMetadata({
            chainId: config.chainId,
            nftContract: config.chogNftAddress,
            tokenId: parsed.tokenId,
            name: metadata.name,
            description: metadata.description,
            image: metadata.imagePath,
            status: "fetched",
            checkedAt: new Date().toISOString(),
          });
        } catch {
          // The portrait can still render if the database write fails.
        }
      }
    }
    return NextResponse.json({
      status: metadata.status,
      tokenId: parsed.tokenId,
      name: metadata.name,
      imageUrl: metadata.imageUrl,
      attributes: metadata.attributes,
    });
  } catch {
    return NextResponse.json({ status: "unavailable", tokenId: parsed.tokenId });
  }
}
