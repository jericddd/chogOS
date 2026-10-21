import { decodeEventLog, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";

export const CHOG_BANK_EVENTS = [
  {
    type: "event",
    name: "Funded",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Distributed",
    inputs: [
      { name: "decisionId", type: "bytes32", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
      { name: "reasonHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

export type DecodedFunding = {
  txHash: string;
  blockNumber: string;
  logIndex: number;
  from: string;
  asset: "MON" | "CHOG";
  amountRaw: string;
  kind: "funded_event" | "direct_chog_transfer";
};

export type DecodedDistribution = {
  txHash: string;
  blockNumber: string;
  logIndex: number;
  decisionId: string;
  tokenId: string;
  recipient: string;
  asset: "MON" | "CHOG";
  amountRaw: string;
};

export function treasuryAsset(asset: string): "MON" | "CHOG" | null {
  if (asset.toLowerCase() === ZERO) return "MON";
  if (asset.toLowerCase() === addresses.chogToken.toLowerCase()) return "CHOG";
  return null;
}

export function decodeBankLog(log: {
  address?: string;
  data: Hex;
  topics: readonly Hex[];
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
  logIndex?: number | null;
}): DecodedFunding | DecodedDistribution | null {
  if (!log.transactionHash || !HASH.test(log.transactionHash) || log.blockNumber == null || log.logIndex == null) {
    return null;
  }
  const blockNumber = log.blockNumber.toString(10);
  if (!DECIMAL.test(blockNumber)) return null;
  try {
    const decoded = decodeEventLog({ abi: CHOG_BANK_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (decoded.eventName === "Funded") {
      const asset = treasuryAsset(decoded.args.asset);
      if (!asset || decoded.args.amount <= 0n) return null;
      return {
        txHash: log.transactionHash,
        blockNumber,
        logIndex: log.logIndex,
        from: decoded.args.from,
        asset,
        amountRaw: decoded.args.amount.toString(10),
        kind: "funded_event",
      };
    }
    const asset = treasuryAsset(decoded.args.asset);
    if (!asset || decoded.args.amount <= 0n || !HASH.test(decoded.args.decisionId)) return null;
    if (!/^[0-9]+$/.test(decoded.args.tokenId.toString(10))) return null;
    return {
      txHash: log.transactionHash,
      blockNumber,
      logIndex: log.logIndex,
      decisionId: decoded.args.decisionId,
      tokenId: decoded.args.tokenId.toString(10),
      recipient: decoded.args.recipient,
      asset,
      amountRaw: decoded.args.amount.toString(10),
    };
  } catch {
    return null;
  }
}

export function decodeDirectChogTransfer(log: {
  data: Hex;
  topics: readonly Hex[];
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
  logIndex?: number | null;
  args?: { from?: string; to?: string; value?: bigint };
}): DecodedFunding | null {
  if (!log.transactionHash || !HASH.test(log.transactionHash) || log.blockNumber == null || log.logIndex == null) {
    return null;
  }
  const from = log.args?.from;
  const value = log.args?.value;
  if (!from || value == null || value <= 0n) return null;
  const blockNumber = log.blockNumber.toString(10);
  if (!DECIMAL.test(blockNumber)) return null;
  return {
    txHash: log.transactionHash,
    blockNumber,
    logIndex: log.logIndex,
    from,
    asset: "CHOG",
    amountRaw: value.toString(10),
    kind: "direct_chog_transfer",
  };
}

/** A direct token transfer in the same transaction as Funded is the same deposit. */
export function withoutFundedTransfers(rows: readonly DecodedFunding[]): DecodedFunding[] {
  const funded = new Set(rows.filter((row) => row.kind === "funded_event" && row.asset === "CHOG").map((row) => row.txHash.toLowerCase()));
  return rows.filter((row) => row.kind !== "direct_chog_transfer" || !funded.has(row.txHash.toLowerCase()));
}
