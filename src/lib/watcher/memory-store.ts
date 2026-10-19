import { getAddress, type Address, type Hex } from "viem";
import { logIdentity, tokenKey } from "@/lib/watcher/identity";
import type {
  BlockHeader,
  InvalidationState,
  ScanCursor,
  SessionInvalidation,
  StoredTransfer,
  WatchedSession,
} from "@/lib/watcher/types";

export function emptyCursor(nftContract: Address, backfillFrom: bigint | null = null): ScanCursor {
  return {
    chainId: 143,
    nftContract: getAddress(nftContract),
    lastScannedBlock: null,
    lastScannedHash: null,
    lastSuccessAt: null,
    lastError: null,
    backfillFrom,
  };
}

export type WatcherSnapshot = {
  cursor: {
    chainId: 143;
    nftContract: Address;
    lastScannedBlock: string | null;
    lastScannedHash: Hex | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    backfillFrom: string | null;
  };
  logs: Array<Omit<StoredTransfer, "blockNumber" | "tokenId"> & { blockNumber: string; tokenId: string }>;
  blocks: Array<{ number: string; hash: Hex; parentHash: Hex }>;
  sessions: Array<Omit<WatchedSession, "openedBlock"> & { openedBlock: string }>;
  invalidations: SessionInvalidation[];
  seq: number;
};

export class MemoryWatcherStore {
  cursor: ScanCursor;
  logs: StoredTransfer[] = [];
  blocks = new Map<string, BlockHeader>();
  sessions: WatchedSession[] = [];
  invalidations: SessionInvalidation[] = [];
  private seq = 0;

  constructor(nftContract: Address, backfillFrom: bigint | null = null) {
    this.cursor = emptyCursor(nftContract, backfillFrom);
  }

  snapshot(): WatcherSnapshot {
    return {
      cursor: {
        ...this.cursor,
        lastScannedBlock: this.cursor.lastScannedBlock?.toString() ?? null,
        backfillFrom: this.cursor.backfillFrom?.toString() ?? null,
      },
      logs: this.logs.map((log) => ({
        ...log,
        blockNumber: log.blockNumber.toString(),
        tokenId: log.tokenId.toString(),
      })),
      blocks: [...this.blocks.values()].map((block) => ({
        number: block.number.toString(),
        hash: block.hash,
        parentHash: block.parentHash,
      })),
      sessions: this.sessions.map((row) => ({ ...row, openedBlock: row.openedBlock.toString() })),
      invalidations: this.invalidations.map((row) => ({ ...row })),
      seq: this.seq,
    };
  }

  static fromSnapshot(snapshot: WatcherSnapshot): MemoryWatcherStore {
    const store = new MemoryWatcherStore(snapshot.cursor.nftContract, snapshot.cursor.backfillFrom === null ? null : BigInt(snapshot.cursor.backfillFrom));
    store.cursor = {
      ...snapshot.cursor,
      lastScannedBlock: snapshot.cursor.lastScannedBlock === null ? null : BigInt(snapshot.cursor.lastScannedBlock),
      backfillFrom: snapshot.cursor.backfillFrom === null ? null : BigInt(snapshot.cursor.backfillFrom),
    };
    store.logs = snapshot.logs.map((log) => ({
      ...log,
      blockNumber: BigInt(log.blockNumber),
      tokenId: BigInt(log.tokenId),
    }));
    store.blocks = new Map(
      snapshot.blocks.map((block) => [
        block.number,
        { number: BigInt(block.number), hash: block.hash, parentHash: block.parentHash },
      ]),
    );
    store.sessions = snapshot.sessions.map((row) => ({ ...row, openedBlock: BigInt(row.openedBlock) }));
    store.invalidations = snapshot.invalidations.map((row) => ({ ...row }));
    store.seq = snapshot.seq;
    return store;
  }

  getCursor(): ScanCursor {
    return { ...this.cursor };
  }

  setBackfill(block: bigint): void {
    this.cursor.backfillFrom = block;
  }

  blockHash(number: bigint): Hex | null {
    return this.blocks.get(number.toString())?.hash ?? null;
  }

  hasLog(id: string): boolean {
    return this.logs.some((row) => row.id === id);
  }

  saveLog(log: Omit<StoredTransfer, "id">): { row: StoredTransfer; created: boolean } {
    const id = logIdentity({ ...log, chainId: 143 });
    const existing = this.logs.find((row) => row.id === id);
    if (existing) {
      return { row: existing, created: false };
    }
    const row: StoredTransfer = { ...log, id };
    this.logs.push(row);
    return { row, created: true };
  }

  forgetBlock(number: bigint): void {
    this.blocks.delete(number.toString());
    this.logs = this.logs.filter((row) => row.blockNumber !== number);
    if (this.cursor.lastScannedBlock === null || this.cursor.lastScannedBlock < number) {
      return;
    }
    const remaining = [...this.blocks.values()]
      .map((header) => header.number)
      .filter((value) => value < number)
      .sort((a, b) => (a < b ? -1 : 1));
    const last = remaining.length ? remaining[remaining.length - 1]! : null;
    this.cursor.lastScannedBlock = last;
    this.cursor.lastScannedHash = last === null ? null : this.blocks.get(last.toString())?.hash ?? null;
  }

  commitBlock(header: BlockHeader, now: string): void {
    this.blocks.set(header.number.toString(), header);
    this.cursor.lastScannedBlock = header.number;
    this.cursor.lastScannedHash = header.hash;
    this.cursor.lastError = null;
    this.cursor.lastSuccessAt = now;
  }

  setError(message: string): void {
    this.cursor.lastError = message;
  }

  watch(session: WatchedSession): void {
    const index = this.sessions.findIndex((row) => row.requestId === session.requestId);
    if (index >= 0) {
      this.sessions[index] = session;
      return;
    }
    this.sessions.push(session);
  }

  sessionsFor(tokenId: string): WatchedSession[] {
    const key = tokenKey(tokenId);
    return this.sessions.filter((row) => row.tokenId === key);
  }

  transfersAfter(tokenId: string, openedBlock: bigint): StoredTransfer[] {
    const key = tokenKey(tokenId);
    return this.logs.filter((row) => tokenKey(row.tokenId) === key && row.blockNumber > openedBlock);
  }

  queueInvalidation(input: { requestId: string; transferId: string; reason: string }): SessionInvalidation {
    const open = this.invalidations.find(
      (row) => row.requestId === input.requestId && (row.state === "queued" || row.state === "submitted" || row.state === "confirmed"),
    );
    if (open) {
      return open;
    }
    const row: SessionInvalidation = {
      id: `inv-${++this.seq}`,
      requestId: input.requestId,
      transferId: input.transferId,
      state: "queued",
      reason: input.reason,
    };
    this.invalidations.push(row);
    return row;
  }

  setInvalidationState(id: string, state: InvalidationState): void {
    const row = this.invalidations.find((item) => item.id === id);
    if (row) {
      row.state = state;
    }
  }
}
