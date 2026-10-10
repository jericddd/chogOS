import { createPublicClient, http, type PublicClient } from "viem";
import { getChain, type SupportedChainId } from "@/lib/blockchain/chains";

const defaultRpcUrl: Record<SupportedChainId, string> = {
  143: "https://rpc.monad.xyz",
  10143: "https://testnet-rpc.monad.xyz",
};

export function createChainClient(
  chainId: SupportedChainId,
  rpcUrl = defaultRpcUrl[chainId],
): PublicClient {
  return createPublicClient({
    chain: getChain(chainId),
    transport: http(rpcUrl),
  });
}
