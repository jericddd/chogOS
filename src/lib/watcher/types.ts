import type { Address, Hex } from "viem";

/** Offchain monitoring stage. A queued invalidation is not an onchain invalidation. */
export type WatcherStatus = "uninitialized" | "healthy" | "lagging" | "stalled" | "error";

export type BlockHeader = {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
};

export type RawTransfer = {
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  address: Address;
  from: Address;
  to: Address;
  tokenId: bigint;
  removed?: boolean;
};

export type LogSource = {
  latest(): Promise<BlockHeader | { error: string }>;
  header(blockNumber: bigint): Promise<BlockHeader | { error: string }>;
  transfers(fromBlock: bigint, toBlock: bigint): Promise<RawTransfer[] | { error: string }>;
};

export type ScanCursor = {
  chainId: 143;
  nftContract: Address;
  lastScannedBlock: bigint | null;
  lastScannedHash: Hex | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  backfillFrom: bigint | null;
};

export type StoredTransfer = RawTransfer & {
  id: string;
};

export type WatchedSession = {
  requestId: string;
  tokenId: string;
  openedBlock: bigint;
  ownerAtOpen: Address;
  account: Address;
};

export type InvalidationState = "queued" | "submitted" | "confirmed" | "failed";

export type SessionInvalidation = {
  id: string;
  requestId: string;
  transferId: string | null;
  state: InvalidationState;
  reason: string;
};

export type WatcherHealth = {
  status: WatcherStatus;
  /** Caught up and fresh. A queued invalidation does not clear this. */
  executionAllowed: boolean;
  /**
   * Caught up, fresh, and no queued, submitted, or failed invalidation.
   * Zero lag is not an onchain lock against a transfer already in flight.
   */
  sponsorshipAllowed: boolean;
  cursorBlock: bigint | null;
  tipBlock: bigint | null;
  lagBlocks: bigint | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  pendingInvalidations: number;
  failedInvalidations: number;
  confirmedInvalidations: number;
};
