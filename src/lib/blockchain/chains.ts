import { defineChain, type Chain } from "viem";
import { monad, monadTestnet } from "viem/chains";

/**
 * viem's Monad chain ids and default HTTP RPCs match the public endpoints
 * published at https://docs.monad.xyz/developer-essentials/network-information
 * and https://docs.monad.xyz/developer-essentials/testnet.
 * The testnet block explorer in viem differs from those docs, so the
 * explorers below are the ones named in the Monad documentation.
 */
export const monadMainnet: Chain = defineChain({
  ...monad,
  name: "Monad Mainnet",
  blockExplorers: {
    default: {
      name: "Monadscan",
      url: "https://monadscan.com",
    },
    monadvision: {
      name: "MonadVision",
      url: "https://monadvision.com",
    },
  },
});

export const monadTestnetChain: Chain = defineChain({
  ...monadTestnet,
  name: "Monad Testnet",
  blockExplorers: {
    default: {
      name: "Monadscan",
      url: "https://testnet.monadscan.com",
    },
    monadvision: {
      name: "MonadVision",
      url: "https://testnet.monadvision.com",
    },
  },
});

export const chainsById = {
  143: monadMainnet,
  10143: monadTestnetChain,
} as const;

export type SupportedChainId = keyof typeof chainsById;

export function getChain(chainId: SupportedChainId): Chain {
  return chainsById[chainId];
}
