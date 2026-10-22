import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { issuanceDecisionId } from "@/lib/wallets/issuance";

/** Factory deployed for agent 0x18229E45A24FB96f3c2d551adb406Db2F7d14358. A public address, not a key. */
export const MAINNET_WALLET_FACTORY = getAddress("0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A");

export const factoryAbi = [
  {
    type: "function",
    name: "agent",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "predict",
    stateMutability: "view",
    inputs: [
      { name: "chainId", type: "uint256" },
      { name: "nftContract", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [
      { name: "chainId", type: "uint256" },
      { name: "nftContract", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "decisionId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    type: "event",
    name: "AccountCreated",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "chainId", type: "uint256", indexed: false },
      { name: "nftContract", type: "address", indexed: false },
      { name: "tokenId", type: "uint256", indexed: false },
      { name: "decisionId", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const walletTokenAbi = [
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
  },
] as const;

export type IssuanceTypedData = {
  domain: {
    name: "chogOS CitizenWalletFactory";
    version: "3";
    chainId: 143;
    verifyingContract: Address;
  };
  types: {
    Issuance: [
      { name: "chainId"; type: "uint256" },
      { name: "nftContract"; type: "address" },
      { name: "tokenId"; type: "uint256" },
      { name: "decisionId"; type: "bytes32" },
      { name: "deadline"; type: "uint256" },
    ];
  };
  primaryType: "Issuance";
  message: {
    chainId: 143n;
    nftContract: Address;
    tokenId: bigint;
    decisionId: Hex;
    deadline: bigint;
  };
};

/** EIP-712 payload the factory checks. Deadline is unix seconds, at most one hour ahead. */
export function issuanceTypedData(factory: Address, tokenId: bigint, decisionId: Hex, deadline: bigint): IssuanceTypedData {
  return {
    domain: {
      name: "chogOS CitizenWalletFactory",
      version: "3",
      chainId: 143,
      verifyingContract: factory,
    },
    types: {
      Issuance: [
        { name: "chainId", type: "uint256" },
        { name: "nftContract", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "decisionId", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Issuance",
    message: {
      chainId: 143n,
      nftContract: addresses.chogGenesis,
      tokenId,
      decisionId,
      deadline,
    },
  };
}

export function createCalldata(tokenId: bigint, decisionId: Hex, deadline: bigint, signature: Hex): Hex {
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: "create",
    args: [143n, addresses.chogGenesis, tokenId, decisionId, deadline, signature],
  });
}

/** Cap can rise a little. The paid tip is 1 wei, so the fee sits on the base fee. */
export function lowestIssuerFees(baseFeePerGas: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: 1n } {
  const base = baseFeePerGas > 0n ? baseFeePerGas : 100_000_000_000n;
  return { maxFeePerGas: (base * 12n) / 10n + 1n, maxPriorityFeePerGas: 1n };
}

export type CreatedAccount = {
  account: Address;
  tokenId: bigint;
  decisionId: Hex;
};

export type AccountLog = {
  address: Address;
  data: Hex;
  topics: readonly unknown[];
};

/** Accept only an AccountCreated log for this factory, token, and decision. */
export function matchAccountCreated(
  logs: readonly AccountLog[],
  expected: { factory: Address; tokenId: bigint; decisionId: Hex },
): CreatedAccount | null {
  const factory = expected.factory.toLowerCase();
  const decisionId = expected.decisionId.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== factory) continue;
    try {
      const decoded = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName !== "AccountCreated") continue;
      const args = decoded.args;
      if (args.tokenId !== expected.tokenId) continue;
      if (args.chainId !== 143n) continue;
      if (args.nftContract.toLowerCase() !== addresses.chogGenesis.toLowerCase()) continue;
      if (args.decisionId.toLowerCase() !== decisionId) continue;
      return { account: getAddress(args.account), tokenId: args.tokenId, decisionId: args.decisionId };
    } catch {
      continue;
    }
  }
  return null;
}

export function decisionMatchesToken(tokenId: string, decisionId: string): boolean {
  if (!/^[0-9]+$/.test(tokenId) || !/^0x[0-9a-fA-F]{64}$/.test(decisionId)) return false;
  return issuanceDecisionId(tokenId).toLowerCase() === decisionId.toLowerCase();
}
