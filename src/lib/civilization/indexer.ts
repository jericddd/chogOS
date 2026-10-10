import type { Address } from "viem";
import { parseTokenId, sameAddress } from "@/lib/civilization/token-id";

export type IndexerCandidateResult =
  | { status: "unconfigured" }
  | { status: "error"; message: string }
  | { status: "ok"; tokenIds: string[] };

export function verifyIndexerCandidates(input: {
  candidates: string[];
  owners: Record<string, Address | "missing">;
  treasury: Address;
}): { verified: string[]; stale: string[] } {
  const verified: string[] = [];
  const stale: string[] = [];
  for (const candidate of input.candidates) {
    const parsed = parseTokenId(candidate);
    if (!parsed.ok) {
      stale.push(candidate);
      continue;
    }
    const owner = input.owners[parsed.tokenId];
    if (owner && owner !== "missing" && sameAddress(owner, input.treasury)) {
      verified.push(parsed.tokenId);
    } else {
      stale.push(parsed.tokenId);
    }
  }
  return { verified, stale };
}

export function parseAlchemyOwnedTokenIds(payload: unknown, nftContract: Address): IndexerCandidateResult {
  if (!payload || typeof payload !== "object" || !("ownedNfts" in payload) || !Array.isArray(payload.ownedNfts)) {
    return { status: "error", message: "Alchemy returned an unexpected NFT payload." };
  }

  const tokenIds: string[] = [];
  for (const nft of payload.ownedNfts) {
    if (!nft || typeof nft !== "object" || !("tokenId" in nft)) {
      return { status: "error", message: "Alchemy returned an NFT without a token id." };
    }
    const contract = "contract" in nft && nft.contract && typeof nft.contract === "object" ? nft.contract : null;
    const contractAddress =
      contract && "address" in contract && typeof contract.address === "string" ? contract.address : null;
    if (contractAddress && !sameAddress(contractAddress, nftContract)) {
      continue;
    }
    const tokenId = normalizeAlchemyTokenId(nft.tokenId);
    if (!tokenId) {
      return { status: "error", message: "Alchemy returned a token id that is not an integer." };
    }
    tokenIds.push(tokenId);
  }
  return { status: "ok", tokenIds };
}

function normalizeAlchemyTokenId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  if (value.startsWith("0x")) {
    try {
      return BigInt(value).toString(10);
    } catch {
      return null;
    }
  }
  const parsed = parseTokenId(value);
  return parsed.ok ? parsed.tokenId : null;
}

export function parseCustomIndexerTokenIds(payload: unknown): IndexerCandidateResult {
  if (!payload || typeof payload !== "object" || !("tokenIds" in payload) || !Array.isArray(payload.tokenIds)) {
    return { status: "error", message: "Custom indexer payload must be { tokenIds: string[] }." };
  }
  const tokenIds: string[] = [];
  for (const value of payload.tokenIds) {
    if (typeof value !== "string" && typeof value !== "number") {
      return { status: "error", message: "Custom indexer token ids must be integers." };
    }
    const parsed = parseTokenId(String(value));
    if (!parsed.ok) {
      return { status: "error", message: parsed.reason };
    }
    tokenIds.push(parsed.tokenId);
  }
  return { status: "ok", tokenIds };
}
