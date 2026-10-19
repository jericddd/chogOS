import { getAddress, type Address, type Hex } from "viem";
import { assessWatcher } from "@/lib/watcher/health";
import { logIdentity } from "@/lib/watcher/identity";
import { MemoryWatcherStore, type WatcherSnapshot } from "@/lib/watcher/memory-store";
import { scanTransfers, type ScanReport } from "@/lib/watcher/scan";
import type { InvalidationState, LogSource, WatcherHealth } from "@/lib/watcher/types";

export type Sql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export const LOAD_WATCHER_SQL = "select load_nft_watcher_snapshot($1) as snapshot";
export const SAVE_WATCHER_SQL = "select save_nft_watcher_snapshot($1::jsonb)";

export type WatcherPayload = {
  chainId: 143;
  nftContract: Address;
  cursor: {
    lastScannedBlock: string | null;
    lastScannedHash: Hex | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    backfillFrom: string | null;
  };
  blocks: Array<{ number: string; hash: Hex; parentHash: Hex }>;
  logs: Array<{
    blockNumber: string;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
    tokenId: string;
    from: Address;
    to: Address;
  }>;
  sessions: Array<{
    requestId: string;
    tokenId: string;
    openedBlock: string;
    ownerAtOpen: Address;
    account: Address;
  }>;
  invalidations: Array<{
    id: string;
    requestId: string;
    transferId: string | null;
    state: InvalidationState;
    reason: string;
  }>;
  seq: number;
};

export function isMissingWatcherMigration(message: string): boolean {
  return /load_nft_watcher_snapshot|save_nft_watcher_snapshot|nft_watched_sessions|nft_watcher_invalidations|nft_watcher_state|does not exist|schema cache|PGRST202|42883/i.test(
    message,
  );
}

export function storeToPayload(store: MemoryWatcherStore): WatcherPayload {
  const snapshot = store.snapshot();
  return {
    chainId: 143,
    nftContract: getAddress(snapshot.cursor.nftContract),
    cursor: {
      lastScannedBlock: snapshot.cursor.lastScannedBlock,
      lastScannedHash: snapshot.cursor.lastScannedHash,
      lastSuccessAt: snapshot.cursor.lastSuccessAt,
      lastError: snapshot.cursor.lastError,
      backfillFrom: snapshot.cursor.backfillFrom,
    },
    blocks: snapshot.blocks.map((block) => ({
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
    })),
    logs: snapshot.logs.map((log) => ({
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      tokenId: log.tokenId,
      from: getAddress(log.from),
      to: getAddress(log.to),
    })),
    sessions: snapshot.sessions.map((row) => ({
      requestId: row.requestId,
      tokenId: row.tokenId,
      openedBlock: row.openedBlock,
      ownerAtOpen: getAddress(row.ownerAtOpen),
      account: getAddress(row.account),
    })),
    invalidations: snapshot.invalidations.map((row) => ({ ...row })),
    seq: snapshot.seq,
  };
}

export function payloadToStore(payload: WatcherPayload): MemoryWatcherStore {
  if (payload.chainId !== 143) {
    throw new Error("watcher snapshot chain must be 143");
  }
  const nft = getAddress(payload.nftContract);
  const snapshot: WatcherSnapshot = {
    cursor: {
      chainId: 143,
      nftContract: nft,
      lastScannedBlock: text(payload.cursor?.lastScannedBlock),
      lastScannedHash: payload.cursor?.lastScannedHash ?? null,
      lastSuccessAt: text(payload.cursor?.lastSuccessAt),
      lastError: text(payload.cursor?.lastError),
      backfillFrom: text(payload.cursor?.backfillFrom),
    },
    logs: (payload.logs ?? []).map((log) => {
      const blockHash = log.blockHash;
      const transactionHash = log.transactionHash;
      const logIndex = Number(log.logIndex);
      return {
        id: logIdentity({ chainId: 143, blockHash, transactionHash, logIndex }),
        blockNumber: text(log.blockNumber) ?? "0",
        blockHash,
        transactionHash,
        transactionIndex: Number(log.transactionIndex),
        logIndex,
        address: nft,
        from: getAddress(log.from),
        to: getAddress(log.to),
        tokenId: text(log.tokenId) ?? "0",
      };
    }),
    blocks: (payload.blocks ?? []).map((block) => ({
      number: text(block.number) ?? "0",
      hash: block.hash,
      parentHash: block.parentHash,
    })),
    sessions: (payload.sessions ?? []).map((row) => ({
      requestId: row.requestId,
      tokenId: text(row.tokenId) ?? "0",
      openedBlock: text(row.openedBlock) ?? "0",
      ownerAtOpen: getAddress(row.ownerAtOpen),
      account: getAddress(row.account),
    })),
    invalidations: (payload.invalidations ?? []).map((row) => ({
      id: row.id,
      requestId: row.requestId,
      transferId: row.transferId ?? null,
      state: row.state,
      reason: row.reason,
    })),
    seq: Number(payload.seq ?? 0),
  };
  return MemoryWatcherStore.fromSnapshot(snapshot);
}

export type DurableScan = {
  scanned: boolean;
  report: ScanReport;
  health: WatcherHealth;
  store: MemoryWatcherStore;
};

/**
 * Load, scan, and save. The scan itself stays synchronous against the memory store.
 * A crash before save retries from the last committed snapshot.
 */
export async function runDurableScan(input: {
  sql: Sql;
  nftContract: Address;
  source: LogSource;
  now: string;
  backfillFrom: bigint | null;
  maxLagBlocks: bigint;
  maxStaleMs: number;
}): Promise<DurableScan> {
  const nft = getAddress(input.nftContract);
  let store: MemoryWatcherStore;
  try {
    store = await loadWatcherStore(input.sql, nft);
  } catch (error) {
    const message = error instanceof Error ? error.message : "watcher database read failed";
    return {
      scanned: false,
      report: {
        ok: false,
        reason: isMissingWatcherMigration(message) ? "Phase 6d watcher migration has not been applied" : message,
      },
      health: emptyHealth(message),
      store: new MemoryWatcherStore(nft, input.backfillFrom),
    };
  }

  if (store.getCursor().backfillFrom === null && input.backfillFrom !== null) {
    store.setBackfill(input.backfillFrom);
  }

  const report = await scanTransfers(store, input.source, input.now);
  try {
    await saveWatcherStore(input.sql, store);
  } catch (error) {
    const message = error instanceof Error ? error.message : "watcher database write failed";
    return {
      scanned: true,
      report: { ok: false, reason: message },
      health: assessWatcher({
        store,
        tipBlock: null,
        nowMs: Date.parse(input.now),
        maxLagBlocks: input.maxLagBlocks,
        maxStaleMs: input.maxStaleMs,
      }),
      store,
    };
  }

  const tip = report.ok ? report.toBlock : null;
  return {
    scanned: true,
    report,
    health: assessWatcher({
      store,
      tipBlock: tip,
      nowMs: Date.parse(input.now),
      maxLagBlocks: input.maxLagBlocks,
      maxStaleMs: input.maxStaleMs,
    }),
    store,
  };
}

export async function loadWatcherStore(sql: Sql, nftContract: Address): Promise<MemoryWatcherStore> {
  const result = await sql.query<{ snapshot: unknown }>(LOAD_WATCHER_SQL, [getAddress(nftContract)]);
  const payload = parsePayload(result.rows[0]?.snapshot);
  return payloadToStore(payload);
}

export async function saveWatcherStore(sql: Sql, store: MemoryWatcherStore): Promise<void> {
  await sql.query(SAVE_WATCHER_SQL, [JSON.stringify(storeToPayload(store))]);
}

export function supabaseRpcSql(client: {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
}): Sql {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const load = text.includes("load_nft_watcher_snapshot");
      const save = text.includes("save_nft_watcher_snapshot");
      if (!load && !save) {
        throw new Error("watcher sql adapter refused an unexpected statement");
      }
      const result = load
        ? await client.rpc("load_nft_watcher_snapshot", { nft: params?.[0] })
        : await client.rpc("save_nft_watcher_snapshot", {
            payload: typeof params?.[0] === "string" ? JSON.parse(params[0]) : params?.[0],
          });
      if (result.error) {
        const message = `${result.error.code ?? ""} ${result.error.message}`.trim();
        throw new Error(message);
      }
      return { rows: (load ? [{ snapshot: result.data }] : []) as T[] };
    },
  };
}

function parsePayload(raw: unknown): WatcherPayload {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== "object") {
    throw new Error("watcher snapshot was empty");
  }
  return value as WatcherPayload;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value);
  return raw.length ? raw : null;
}

function emptyHealth(lastError: string): WatcherHealth {
  return {
    status: "error",
    executionAllowed: false,
    sponsorshipAllowed: false,
    cursorBlock: null,
    tipBlock: null,
    lagBlocks: null,
    lastError,
    lastSuccessAt: null,
    pendingInvalidations: 0,
    failedInvalidations: 0,
    confirmedInvalidations: 0,
  };
}
