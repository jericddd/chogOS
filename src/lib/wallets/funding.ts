import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { sameAddress } from "@/lib/civilization/token-id";

const transferEvent = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export type FundingStatus = "submitted" | "pending" | "confirmed" | "failed" | "reverted" | "unverified";

export type TransferLog = {
  address: string;
  topics: Hex[];
  data: Hex;
};

export type FundingLeg = {
  status: FundingStatus;
  assetKind: "native" | "erc20" | "unknown";
  tokenAddress: Address | null;
  symbol: string;
  decimals: number | null;
  amountRaw: string | null;
  sender: Address | null;
  recipient: Address | null;
  blockNumber: string | null;
  detail: string;
};

export function judgeFunding(input: {
  treasury: Address;
  chogToken: Address;
  receipt: { status: "success" | "reverted"; blockNumber: bigint; logs: TransferLog[] } | null;
  transaction: { from: Address; to: Address | null; value: bigint } | null;
  chogDecimals: number | null;
}): FundingLeg[] {
  if (!input.receipt) {
    return [
      {
        status: "unverified",
        assetKind: "unknown",
        tokenAddress: null,
        symbol: "Unknown",
        decimals: null,
        amountRaw: null,
        sender: null,
        recipient: null,
        blockNumber: null,
        detail: "No receipt on this chain. The hash is not a confirmed funding transfer.",
      },
    ];
  }

  const blockNumber = input.receipt.blockNumber.toString();
  if (input.receipt.status === "reverted") {
    return [
      {
        status: "reverted",
        assetKind: "unknown",
        tokenAddress: null,
        symbol: "Unknown",
        decimals: null,
        amountRaw: null,
        sender: input.transaction?.from ?? null,
        recipient: null,
        blockNumber,
        detail: "The transaction reverted. It is not counted as treasury funding.",
      },
    ];
  }

  const legs: FundingLeg[] = [];
  if (input.transaction && input.transaction.value > 0n && input.transaction.to && sameAddress(input.transaction.to, input.treasury)) {
    legs.push({
      status: "confirmed",
      assetKind: "native",
      tokenAddress: null,
      symbol: "MON",
      decimals: 18,
      amountRaw: input.transaction.value.toString(),
      sender: input.transaction.from,
      recipient: getAddress(input.treasury),
      blockNumber,
      detail: "Native MON value was sent to the configured civilization treasury.",
    });
  }

  for (const log of input.receipt.logs) {
    if (!sameAddress(log.address, input.chogToken) || log.topics.length < 3) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: transferEvent,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "Transfer") {
        continue;
      }
      const from = decoded.args.from;
      const to = decoded.args.to;
      const value = decoded.args.value;
      if (!sameAddress(to, input.treasury) || value <= 0n) {
        continue;
      }
      legs.push({
        status: "confirmed",
        assetKind: "erc20",
        tokenAddress: getAddress(input.chogToken),
        symbol: "CHOG",
        decimals: input.chogDecimals,
        amountRaw: value.toString(),
        sender: from,
        recipient: getAddress(to),
        blockNumber,
        detail: "An ERC-20 Transfer of the configured $CHOG contract reached the civilization treasury.",
      });
    } catch {
      continue;
    }
  }

  if (legs.length === 0) {
    return [
      {
        status: "failed",
        assetKind: "unknown",
        tokenAddress: null,
        symbol: "Unknown",
        decimals: null,
        amountRaw: null,
        sender: input.transaction?.from ?? null,
        recipient: null,
        blockNumber,
        detail: "The receipt succeeded, but it did not transfer MON or $CHOG to the configured treasury.",
      },
    ];
  }

  return legs;
}

const fundingRank: Record<FundingStatus, number> = {
  unverified: 0,
  submitted: 1,
  pending: 2,
  failed: 3,
  reverted: 4,
  confirmed: 5,
};

export function combineFundingLegs(legs: FundingLeg[]): FundingLeg[] {
  const grouped = new Map<string, FundingLeg>();
  for (const leg of legs) {
    const key = `${leg.status}:${leg.assetKind}:${(leg.tokenAddress ?? "").toLowerCase()}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...leg });
      continue;
    }
    if (existing.amountRaw !== null && leg.amountRaw !== null) {
      existing.amountRaw = (BigInt(existing.amountRaw) + BigInt(leg.amountRaw)).toString();
    }
    existing.detail = `${existing.detail} A second transfer in the same transaction is included in the amount.`.slice(0, 500);
  }
  return [...grouped.values()];
}

export function mergeFundingRecord<T extends { status: FundingStatus; amountRaw: string | null }>(
  existing: T,
  incoming: T,
): T {
  if (fundingRank[incoming.status] <= fundingRank[existing.status]) {
    return existing;
  }
  return incoming;
}

export function rpcChainProblem(actual: number, expected: 143 | 10143): string | null {
  if (actual === expected) {
    return null;
  }
  return `The RPC reported chain ${actual}. This application is configured for chain ${expected}. No balance or receipt from that RPC was accepted.`;
}

export function presentBalance(input: {
  configured: boolean;
  live: { symbol: string; decimals: number; amountRaw: string; blockNumber: string; observedAt: string } | null;
  error: string | null;
  lastKnown: { symbol: string; amountRaw: string; observedAt: string; blockNumber: string } | null;
}):
  | { state: "unconfigured" }
  | {
      state: "unavailable";
      detail: string;
      lastKnown: { symbol: string; amountRaw: string; observedAt: string; blockNumber: string } | null;
    }
  | {
      state: "live";
      symbol: string;
      decimals: number;
      amountRaw: string;
      blockNumber: string;
      observedAt: string;
    } {
  if (!input.configured) {
    return { state: "unconfigured" };
  }
  if (input.live) {
    return { state: "live", ...input.live };
  }
  return {
    state: "unavailable",
    detail: input.error ?? "The balance could not be read. No balance is shown in its place.",
    lastKnown: input.lastKnown,
  };
}
