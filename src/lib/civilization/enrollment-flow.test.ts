import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { GenesisChainReader } from "@/lib/blockchain/genesis-reader";
import type { InventoryRead, OwnerObservation } from "@/lib/blockchain/holdings";
import { discoverOwnedTokens } from "@/lib/civilization/enrollment-flow";

const wallet = getAddress("0x3D38FeE3E1a4c43d8fcF715aA6C9ff025074E7E0");

function reader(inventory: InventoryRead, owners: Record<string, Address | "fail"> = {}): GenesisChainReader {
  const readOwner = async (tokenId: string): Promise<OwnerObservation> => {
    const owner = owners[tokenId];
    if (!owner || owner === "fail") {
      return { tokenId, status: "failed", reason: "ownerOf reverted." };
    }
    return { tokenId, status: "owner", owner };
  };
  return {
    readOwnedInventory: async () => inventory,
    readOwner,
    readOwners: async (tokenIds) => Promise.all(tokenIds.map((tokenId) => readOwner(tokenId))),
    readTokenUri: async () => null,
  };
}

function inventory(tokenIds: string[] | null): InventoryRead {
  return {
    blockNumber: "1",
    balanceOf: tokenIds?.length ?? null,
    balanceError: null,
    tokensOfOwner: tokenIds,
    tokensOfOwnerError: tokenIds ? null : "tokensOfOwner reverted.",
  };
}

describe("discoverOwnedTokens", () => {
  it("lists every Chog tokensOfOwner returns, including a wallet past the old 50 id box", async () => {
    const tokenIds = Array.from({ length: 53 }, (_, index) => String(index + 1));
    const owners = Object.fromEntries(tokenIds.map((tokenId) => [tokenId, wallet]));
    const result = await discoverOwnedTokens({
      reader: reader(inventory(tokenIds), owners),
      wallet,
      onlyTokenIds: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("tokensOfOwner");
      expect(result.owned).toHaveLength(53);
      expect(result.owned[0]?.tokenId).toBe("1");
    }
  });

  it("reports a contract failure without asking for a typed token id", async () => {
    const result = await discoverOwnedTokens({
      reader: reader(inventory(null)),
      wallet,
      onlyTokenIds: null,
    });
    expect(result).toEqual({
      ok: false,
      error: "tokensOfOwner reverted.",
    });
  });
});
