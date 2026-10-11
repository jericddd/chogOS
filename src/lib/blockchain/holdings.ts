import type { Address } from "viem";
import { sameAddress } from "@/lib/civilization/token-id";

export type OwnerObservation =
  | { tokenId: string; status: "owner"; owner: Address }
  | { tokenId: string; status: "failed"; reason: string };

export type InventoryRead = {
  blockNumber: string;
  balanceOf: number | null;
  balanceError: string | null;
  tokensOfOwner: string[] | null;
  tokensOfOwnerError: string | null;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function compareTokenIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function selectVerifiedHoldings(
  observations: OwnerObservation[],
  treasury: Address,
): {
  verified: Array<{ tokenId: string; owner: Address }>;
  rejected: Array<{ tokenId: string; reason: string }>;
} {
  const verified: Array<{ tokenId: string; owner: Address }> = [];
  const rejected: Array<{ tokenId: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    if (seen.has(observation.tokenId)) {
      continue;
    }
    seen.add(observation.tokenId);
    if (observation.status === "failed") {
      rejected.push({ tokenId: observation.tokenId, reason: observation.reason });
      continue;
    }
    if (sameAddress(observation.owner, ZERO_ADDRESS)) {
      rejected.push({ tokenId: observation.tokenId, reason: "ownerOf returned the zero address." });
      continue;
    }
    if (!sameAddress(observation.owner, treasury)) {
      rejected.push({
        tokenId: observation.tokenId,
        reason: "ownerOf returned a wallet other than ChogTreasury.",
      });
      continue;
    }
    verified.push({ tokenId: observation.tokenId, owner: observation.owner });
  }

  verified.sort((left, right) => compareTokenIds(left.tokenId, right.tokenId));
  return { verified, rejected };
}

export function shortenChainError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Contract call failed.";
  return message.replace(/\s+/g, " ").slice(0, 280);
}
