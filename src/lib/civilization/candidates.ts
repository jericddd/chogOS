import type { IndexerCandidateResult } from "@/lib/civilization/indexer";
import { parseTokenId } from "@/lib/civilization/token-id";

export function resolveDiscoveryCandidates(input: {
  tokensOfOwner: string[] | null;
  indexer: IndexerCandidateResult;
}): {
  source: "tokensOfOwner" | "indexer" | "unavailable";
  tokenIds: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (input.indexer.status === "error") {
    warnings.push(input.indexer.message);
  }

  const contractIds = normalizeIds(input.tokensOfOwner, warnings, "tokensOfOwner");
  if (contractIds) {
    const extras =
      input.indexer.status === "ok" ? normalizeIds(input.indexer.tokenIds, warnings, "indexer") ?? [] : [];
    const tokenIds = [...contractIds];
    for (const tokenId of extras) {
      if (!tokenIds.includes(tokenId)) {
        tokenIds.push(tokenId);
      }
    }
    return { source: "tokensOfOwner", tokenIds, warnings };
  }

  if (input.indexer.status === "ok") {
    const tokenIds = normalizeIds(input.indexer.tokenIds, warnings, "indexer") ?? [];
    warnings.push("tokensOfOwner was unavailable. Indexer ids stay candidates until ownerOf confirms them.");
    return { source: "indexer", tokenIds, warnings };
  }

  if (input.indexer.status === "unconfigured") {
    warnings.push(
      "tokensOfOwner did not return, and no NFT indexer is configured. Set NFT_INDEXER, or retry when the Monad RPC can read the NFT contract. No token ids were invented.",
    );
  }

  return { source: "unavailable", tokenIds: [], warnings };
}

function normalizeIds(values: string[] | null, warnings: string[], source: string): string[] | null {
  if (!values) {
    return null;
  }
  const tokenIds: string[] = [];
  for (const value of values) {
    const parsed = parseTokenId(value);
    if (!parsed.ok) {
      warnings.push(`${source} returned an invalid token id (${parsed.reason}). It was ignored.`);
      continue;
    }
    if (!tokenIds.includes(parsed.tokenId)) {
      tokenIds.push(parsed.tokenId);
    }
  }
  return tokenIds;
}
