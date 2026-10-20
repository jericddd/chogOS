import { decodeEventLog, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { isRpcVerifiedReceipt, type RpcReceiptLog, type RpcVerifiedReceipt } from "@/lib/economy/verify-receipt";

/** Canonical ERC-20 event. The repository records $CHOG as an observed token, not as verified source. */
export const CHOG_TRANSFER_EVENT = "Transfer(address,address,uint256)";

export const CHOG_TRANSFER_TOPIC = keccak256(toBytes(CHOG_TRANSFER_EVENT));

export const CHOG_TRANSFER_ABI = [
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

export type TransferDirection = "treasury_in" | "treasury_out" | "external" | "unattributed" | "ambiguous";

export type DecodedChogTransfer = {
  chainId: 143;
  txHash: `0x${string}`;
  logIndex: number;
  token: Address;
  symbol: "$CHOG";
  amountRaw: string;
  decimals: number;
  from: Address;
  to: Address;
  direction: TransferDirection;
  /** Public decoding never posts a journal line. */
  countsInTreasury: false;
};

export type DecodeTransfersResult = {
  transfers: DecodedChogTransfer[];
  unsupported: number;
  consistent: boolean;
  note: string;
};

const DIRECTION_NOTE: Record<TransferDirection, string> = {
  treasury_in: "Incoming to the configured economic treasury. This page did not post it to the ledger.",
  treasury_out: "Outgoing from the configured economic treasury. This page did not post it to the ledger.",
  external: "Transfer between other wallets. Not treasury revenue or expenditure.",
  unattributed: "The economic treasury address is not configured, so this transfer is not classified as treasury income or expenditure.",
  ambiguous: "The sender and recipient do not give a single treasury direction. It is not counted as income or expenditure.",
};

export function transferDirectionNote(direction: TransferDirection): string {
  return DIRECTION_NOTE[direction];
}

/**
 * Decode $CHOG Transfer logs from a receipt that verifyMainnetReceipt already accepted.
 * A reverted receipt, a missing log list, or an inconsistent supported log yields no counted transfer.
 */
export function decodeChogTransfers(receipt: unknown, treasury: Address | null): DecodeTransfersResult {
  if (!isRpcVerifiedReceipt(receipt)) {
    return none("No transfer is decoded without a canonical receipt.");
  }
  if (receipt.status !== "success") {
    return none("A reverted receipt is not a successful transfer.");
  }
  if (!receipt.logsRead) {
    return none("This check did not include receipt logs, so no transfer amount is shown.");
  }
  return classifyLogs(receipt, treasury);
}

function none(note: string): DecodeTransfersResult {
  return { transfers: [], unsupported: 0, consistent: true, note };
}

function classifyLogs(receipt: RpcVerifiedReceipt, treasury: Address | null): DecodeTransfersResult {
  const transfers: DecodedChogTransfer[] = [];
  const seen = new Set<number>();
  let unsupported = 0;
  for (const log of receipt.logs) {
    if (seen.has(log.index)) {
      return { transfers: [], unsupported, consistent: false, note: "The receipt repeats a log index, so no transfer is counted." };
    }
    seen.add(log.index);
    const decoded = decodeOne(receipt, log, treasury);
    if (decoded === "unsupported") {
      unsupported += 1;
      continue;
    }
    if (decoded === "inconsistent") {
      return {
        transfers: [],
        unsupported,
        consistent: false,
        note: "A supported token log was malformed or inconsistent, so no transfer is counted.",
      };
    }
    transfers.push(decoded);
  }
  if (transfers.length === 0) {
    return {
      transfers: [],
      unsupported,
      consistent: true,
      note:
        unsupported > 0
          ? "The receipt has no supported $CHOG transfer. Unsupported logs are not counted."
          : "The successful receipt has no supported $CHOG transfer. Receipt success is not a transfer.",
    };
  }
  return {
    transfers,
    unsupported,
    consistent: true,
    note: "Decoded $CHOG transfers come from the verified receipt logs. They are not an accounting settlement.",
  };
}

function decodeOne(
  receipt: RpcVerifiedReceipt,
  log: RpcReceiptLog,
  treasury: Address | null,
): DecodedChogTransfer | "unsupported" | "inconsistent" {
  let token: Address;
  try {
    token = getAddress(log.address);
  } catch {
    return "inconsistent";
  }
  if (token !== addresses.chogToken) {
    return "unsupported";
  }
  const topic0 = log.topics[0];
  if (topic0 !== CHOG_TRANSFER_TOPIC) {
    return "unsupported";
  }
  if (log.topics.length !== 3) {
    return "inconsistent";
  }
  try {
    const decoded = decodeEventLog({
      abi: CHOG_TRANSFER_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (decoded.eventName !== "Transfer") {
      return "inconsistent";
    }
    const from = getAddress(decoded.args.from);
    const to = getAddress(decoded.args.to);
    const value = decoded.args.value;
    if (value <= 0n) {
      return "inconsistent";
    }
    return {
      chainId: 143,
      txHash: receipt.txHash,
      logIndex: log.index,
      token,
      symbol: "$CHOG",
      amountRaw: value.toString(10),
      decimals: recordedCheck.token.decimals,
      from,
      to,
      direction: directionOf(from, to, treasury),
      countsInTreasury: false,
    };
  } catch {
    return "inconsistent";
  }
}

function directionOf(from: Address, to: Address, treasury: Address | null): TransferDirection {
  if (from === to) {
    return "ambiguous";
  }
  if (!treasury) {
    return "unattributed";
  }
  const treasuryAddress = getAddress(treasury);
  const fromTreasury = from === treasuryAddress;
  const toTreasury = to === treasuryAddress;
  if (fromTreasury && toTreasury) {
    return "ambiguous";
  }
  if (toTreasury) {
    return "treasury_in";
  }
  if (fromTreasury) {
    return "treasury_out";
  }
  return "external";
}
