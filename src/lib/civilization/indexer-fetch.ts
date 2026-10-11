import "server-only";
import type { Address } from "viem";
import type { AppConfig } from "@/lib/config/env";
import { parseAlchemyOwnedTokenIds, parseCustomIndexerTokenIds, type IndexerCandidateResult } from "@/lib/civilization/indexer";

/**
 * Optional indexer lookup. A failure here must not erase token ids that the
 * NFT contract already returned. Credentials stay in the server environment.
 */
export async function loadIndexerCandidates(
  config: AppConfig,
  owner: Address,
  nft: Address,
): Promise<IndexerCandidateResult> {
  if (config.nftIndexer === "none") {
    return { status: "unconfigured" };
  }

  try {
    if (config.nftIndexer === "alchemy") {
      return await loadAlchemy(config, owner, nft);
    }
    return await loadCustom(config, owner, nft);
  } catch {
    return {
      status: "error",
      message:
        "The NFT indexer request failed. Chain verification still uses the NFT contract when tokensOfOwner succeeds.",
    };
  }
}

async function loadAlchemy(config: AppConfig, owner: Address, nft: Address): Promise<IndexerCandidateResult> {
  if (!config.nftIndexerApiKey) {
    return { status: "error", message: "NFT_INDEXER=alchemy requires NFT_INDEXER_API_KEY on the server." };
  }
  if (config.chainId !== 143) {
    return { status: "error", message: "The Alchemy adapter in this phase targets Monad mainnet, chain 143." };
  }

  const tokenIds: string[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`https://monad-mainnet.g.alchemy.com/nft/v3/${config.nftIndexerApiKey}/getNFTsForOwner`);
    url.searchParams.set("owner", owner);
    url.searchParams.append("contractAddresses[]", nft);
    url.searchParams.set("withMetadata", "false");
    if (pageKey) {
      url.searchParams.set("pageKey", pageKey);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      return {
        status: "error",
        message: `Alchemy NFT indexer returned HTTP ${response.status}. Chain verification still uses the NFT contract.`,
      };
    }
    const body: unknown = await response.json();
    const parsed = parseAlchemyOwnedTokenIds(body, nft);
    if (parsed.status !== "ok") {
      return parsed;
    }
    tokenIds.push(...parsed.tokenIds);
    pageKey = readPageKey(body);
    if (!pageKey) {
      break;
    }
  }
  return { status: "ok", tokenIds };
}

async function loadCustom(config: AppConfig, owner: Address, nft: Address): Promise<IndexerCandidateResult> {
  if (!config.nftIndexerUrl) {
    return { status: "error", message: "NFT_INDEXER=custom requires NFT_INDEXER_URL. The response must be { tokenIds: string[] }." };
  }
  const url = new URL(config.nftIndexerUrl);
  url.searchParams.set("owner", owner);
  url.searchParams.set("contract", nft);
  const headers: Record<string, string> = {};
  if (config.nftIndexerApiKey) {
    headers.Authorization = `Bearer ${config.nftIndexerApiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) {
    return { status: "error", message: `Custom NFT indexer returned HTTP ${response.status}.` };
  }
  return parseCustomIndexerTokenIds(await response.json());
}

function readPageKey(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("pageKey" in body)) {
    return undefined;
  }
  const key = body.pageKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
