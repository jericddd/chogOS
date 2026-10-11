import { addresses } from "@/lib/blockchain/addresses";

export type EvidenceLevel = "source_verified" | "observed" | "documented_with_code";

export type RecordedContract = {
  name: string;
  address: string;
  chain: string;
  level: EvidenceLevel;
  detail: string;
};

/**
 * Static record of the 10 October 2026 checks. The dashboard does not refresh
 * this from the network. Run `npm run verify:contracts` to repeat the calls.
 */
export const recordedCheck = {
  observedOn: "10 October 2026",
  mainnetRpc: "https://rpc.monad.xyz",
  testnetRpc: "https://testnet-rpc.monad.xyz",
  mainnetChainId: 143,
  testnetChainId: 10143,
  nft: {
    name: "Chog Genesis",
    symbol: "CHOG",
    standard: "ERC-721 and ERC-721 Metadata",
    enumerable: false,
    totalSupply: "1969",
    maxSupply: "1969",
    revealed: true,
    presentOnTestnet: false,
    abiSha256: "3fca01bdd4b72f8034e8774cd40f582f95171a970f6a417685c589af79aa3f6d",
  },
  token: {
    name: "Chog",
    symbol: "CHOG",
    decimals: 18,
    totalSupplyRaw: "1000000000000000000000000000",
    totalSupplyWhole: "1000000000",
    proxy: "EIP-1167",
    presentOnTestnet: false,
    sourceVerified: false,
  },
} as const;

export const recordedContracts: RecordedContract[] = [
  {
    name: "Chog Genesis NFT",
    address: addresses.chogGenesis,
    chain: "Monad mainnet",
    level: "source_verified",
    detail:
      "supportsInterface confirms ERC-165, ERC-721, and ERC-721 Metadata. Monadscan reports a source match. Empty code on testnet.",
  },
  {
    name: "$CHOG token",
    address: addresses.chogToken,
    chain: "Monad mainnet",
    level: "observed",
    detail:
      "Listed on chog.xyz. Minimal proxy. name, symbol, decimals, and totalSupply responded. Source code is not verified. Empty code on testnet.",
  },
  {
    name: "Chog Genesis mint receiver",
    address: addresses.chogGenesisMintTreasury,
    chain: "Monad mainnet",
    level: "observed",
    detail:
      "Returned by treasury() on the NFT. This receives mint proceeds. It is not the civilization treasury, and its balance is not shown.",
  },
  {
    name: "Wrapped MON",
    address: addresses.wrappedMon,
    chain: "Monad mainnet",
    level: "documented_with_code",
    detail: "Listed in the Monad mainnet canonical contracts. Bytecode is present. Hash not checked.",
  },
  {
    name: "Safe singleton",
    address: addresses.safeSingleton,
    chain: "Monad mainnet",
    level: "documented_with_code",
    detail: "Listed in the Monad mainnet canonical contracts. Bytecode is present. Hash not checked.",
  },
  {
    name: "ERC-4337 EntryPoint v0.7",
    address: addresses.entryPointV07,
    chain: "Monad mainnet",
    level: "documented_with_code",
    detail: "Listed in the Monad mainnet canonical contracts. Bytecode is present. Hash not checked.",
  },
];

export const evidenceLabel: Record<EvidenceLevel, string> = {
  source_verified: "Source verified",
  observed: "Observed on chain",
  documented_with_code: "In Monad docs, code present",
};
