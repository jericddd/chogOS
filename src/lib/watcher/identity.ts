import { getAddress, type Hex } from "viem";
import type { RawTransfer } from "@/lib/watcher/types";

export function logIdentity(log: Pick<RawTransfer, "blockHash" | "transactionHash" | "logIndex"> & { chainId?: number }): string {
  return `143:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

export function tokenKey(tokenId: bigint | string): string {
  return BigInt(tokenId).toString();
}

export function sameNft(left: string, right: string): boolean {
  return getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
}

export function isHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
