import {
  createPublicClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import chogGenesisAbiJson from "@/lib/blockchain/abi/chog-genesis.json";
import { getChain, type SupportedChainId } from "@/lib/blockchain/chains";
import {
  shortenChainError,
  type InventoryRead,
  type OwnerObservation,
} from "@/lib/blockchain/holdings";
import type { AppConfig } from "@/lib/config/env";

const chogGenesisAbi = chogGenesisAbiJson as Abi;

const defaultRpcUrl: Record<SupportedChainId, string> = {
  143: "https://rpc.monad.xyz",
  10143: "https://testnet-rpc.monad.xyz",
};

export interface GenesisChainReader {
  readOwnedInventory(owner: Address): Promise<InventoryRead>;
  readOwners(tokenIds: string[]): Promise<OwnerObservation[]>;
  readOwner(tokenId: string): Promise<OwnerObservation>;
  readTokenUri(tokenId: string): Promise<string | null>;
}

function chunks<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export function createViemGenesisReader(client: PublicClient, nft: Address): GenesisChainReader {
  return {
    async readOwnedInventory(owner: Address): Promise<InventoryRead> {
      const blockNumber = await client.getBlockNumber();
      const [balanceResult, tokensResult] = await Promise.all([
        client
          .readContract({
            address: nft,
            abi: chogGenesisAbi,
            functionName: "balanceOf",
            args: [owner],
          })
          .then((value) => ({ ok: true as const, value: value as bigint }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        client
          .readContract({
            address: nft,
            abi: chogGenesisAbi,
            functionName: "tokensOfOwner",
            args: [owner],
          })
          .then((value) => ({ ok: true as const, value: value as bigint[] }))
          .catch((error: unknown) => ({ ok: false as const, error })),
      ]);

      return {
        blockNumber: blockNumber.toString(),
        balanceOf: balanceResult.ok ? Number(balanceResult.value) : null,
        balanceError: balanceResult.ok ? null : shortenChainError(balanceResult.error),
        tokensOfOwner: tokensResult.ok ? tokensResult.value.map((tokenId) => tokenId.toString()) : null,
        tokensOfOwnerError: tokensResult.ok ? null : shortenChainError(tokensResult.error),
      };
    },

    async readOwner(tokenId: string): Promise<OwnerObservation> {
      try {
        const owner = await client.readContract({
          address: nft,
          abi: chogGenesisAbi,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        });
        return { tokenId, status: "owner", owner: getAddress(owner as Address) };
      } catch (error) {
        return { tokenId, status: "failed", reason: shortenChainError(error) };
      }
    },

    async readOwners(tokenIds: string[]): Promise<OwnerObservation[]> {
      const observations: OwnerObservation[] = [];
      for (const group of chunks(tokenIds, 80)) {
        try {
          const response = await client.multicall({
            allowFailure: true,
            contracts: group.map((tokenId) => ({
              address: nft,
              abi: chogGenesisAbi,
              functionName: "ownerOf" as const,
              args: [BigInt(tokenId)] as const,
            })),
          });
          response.forEach((item, index) => {
            const tokenId = group[index];
            if (!tokenId) {
              return;
            }
            if (item.status === "success") {
              observations.push({
                tokenId,
                status: "owner",
                owner: getAddress(item.result as Address),
              });
            } else {
              observations.push({ tokenId, status: "failed", reason: "ownerOf reverted." });
            }
          });
        } catch {
          for (const tokenId of group) {
            observations.push(await this.readOwner(tokenId));
          }
        }
      }
      return observations;
    },

    async readTokenUri(tokenId: string): Promise<string | null> {
      try {
        const uri = await client.readContract({
          address: nft,
          abi: chogGenesisAbi,
          functionName: "tokenURI",
          args: [BigInt(tokenId)],
        });
        return typeof uri === "string" && uri.length > 0 ? uri : null;
      } catch {
        return null;
      }
    },
  };
}

export function createGenesisReaderForConfig(config: AppConfig): GenesisChainReader {
  const client = createPublicClient({
    chain: getChain(config.chainId),
    transport: http(config.rpcUrl ?? defaultRpcUrl[config.chainId], { timeout: 20_000 }),
  });
  return createViemGenesisReader(client, config.chogNftAddress);
}
