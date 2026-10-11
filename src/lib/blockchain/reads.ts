import "server-only";
import type { Address } from "viem";
import { chogGenesisReadAbi } from "@/lib/blockchain/abi/chog-genesis-reads";
import { chogTokenObservedAbi } from "@/lib/blockchain/abi/chog-token-observed";
import { createChainClient } from "@/lib/blockchain/public-client";
import type { SupportedChainId } from "@/lib/blockchain/chains";

/**
 * Read-only contract calls. Results are chain observations, not database facts.
 * This module does not report a balance as spendable civilization wealth.
 */
export async function readChogGenesis(chainId: SupportedChainId, nftAddress: Address) {
  const client = createChainClient(chainId);
  const [name, symbol, totalSupply, maxSupply, revealed, mintTreasury] = await Promise.all([
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "name",
    }),
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "symbol",
    }),
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "totalSupply",
    }),
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "maxSupply",
    }),
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "revealed",
    }),
    client.readContract({
      address: nftAddress,
      abi: chogGenesisReadAbi,
      functionName: "treasury",
    }),
  ]);

  return { name, symbol, totalSupply, maxSupply, revealed, mintTreasury };
}

export async function readChogToken(chainId: SupportedChainId, tokenAddress: Address) {
  const client = createChainClient(chainId);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: chogTokenObservedAbi,
      functionName: "name",
    }),
    client.readContract({
      address: tokenAddress,
      abi: chogTokenObservedAbi,
      functionName: "symbol",
    }),
    client.readContract({
      address: tokenAddress,
      abi: chogTokenObservedAbi,
      functionName: "decimals",
    }),
    client.readContract({
      address: tokenAddress,
      abi: chogTokenObservedAbi,
      functionName: "totalSupply",
    }),
  ]);

  return { name, symbol, decimals, totalSupply };
}
