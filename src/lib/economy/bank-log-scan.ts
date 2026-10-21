import type { Hex } from "viem";
import {
  decodeBankLog,
  decodeDirectChogTransfer,
  withoutFundedTransfers,
  type DecodedDistribution,
  type DecodedFunding,
} from "@/lib/economy/treasury-logs";
import { publicRpcError } from "@/lib/verify/anchor";
import { rpcErrorClass } from "@/lib/watcher/range";

/**
 * Monad's public RPC returns "eth_getLogs is limited to a 100 range" when
 * `toBlock - fromBlock` is greater than 100. Distance 100 is accepted.
 */
export const MAX_LOG_DISTANCE = 100n;

export const DEFAULT_BANK_LOG_LIMITS = {
  maxDistance: MAX_LOG_DISTANCE,
  /** Full scans longer than this read the deployment edge and the chain tip, then stop. */
  maxPages: 160,
  concurrency: 8,
  timeoutMs: 6_000,
  maxAttempts: 2,
} as const;

export type BankLogKind = "funded" | "distributed" | "chog_transfer";

export type BankLogRecord = {
  data: Hex;
  topics: readonly Hex[];
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
  logIndex?: number | null;
  removed?: boolean;
  args?: { from?: string; to?: string; value?: bigint };
};

export type BankLogSource = {
  latestBlock(): Promise<bigint>;
  logs(query: { kind: BankLogKind; fromBlock: bigint; toBlock: bigint }): Promise<readonly BankLogRecord[]>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
};

export type BankLogScanCause = "empty" | "complete" | "no-start" | "ahead" | "gap" | "timeout" | "rpc" | "receipt";

export type BankLogScan = {
  status: "empty" | "complete" | "unreadable";
  cause: BankLogScanCause;
  funding: DecodedFunding[];
  distributions: DecodedDistribution[];
  fromBlock: bigint | null;
  toBlock: bigint | null;
  latestBlock: bigint | null;
  pagesPlanned: number;
  pagesRead: number;
  coveredAll: boolean;
  reason: string | null;
};

export type BankLogLimits = {
  maxDistance?: bigint;
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
};

type Page = { fromBlock: bigint; toBlock: bigint };
type Tagged = { kind: BankLogKind; log: BankLogRecord };

const NO_START = "The deployment block was not verified, so the log scan has no start block.";
const AHEAD = "The deployment block is ahead of the latest block.";
const TIMEOUT = "The log scan timed out before the latest block.";
const GAP = "The log scan did not cover every block from the deployment block through the latest block.";
const RECEIPT = "A log was found, and its receipt could not be read.";

export function planLogPages(fromBlock: bigint, toBlock: bigint, maxDistance = MAX_LOG_DISTANCE): Page[] {
  if (maxDistance < 0n || fromBlock < 0n || toBlock < fromBlock) return [];
  const pages: Page[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + maxDistance;
    const to = end > toBlock ? toBlock : end;
    pages.push({ fromBlock: cursor, toBlock: to });
    cursor = to + 1n;
  }
  return pages;
}

export function selectLogPages<T>(pages: readonly T[], maxPages: number): { selected: T[]; coversAll: boolean } {
  if (pages.length === 0 || maxPages < 1) return { selected: [], coversAll: false };
  if (pages.length <= maxPages) return { selected: [...pages], coversAll: true };
  const head = Math.max(1, Math.floor(maxPages / 2));
  const tail = Math.max(0, maxPages - head);
  return {
    selected: [...pages.slice(0, head), ...pages.slice(pages.length - tail)],
    coversAll: false,
  };
}

export async function scanChogBankLogs(input: {
  deploymentBlock: bigint | null;
  source: BankLogSource;
  limits?: BankLogLimits;
}): Promise<BankLogScan> {
  if (input.deploymentBlock == null) return unfinished("no-start", NO_START);
  if (input.deploymentBlock < 0n) return unfinished("no-start", NO_START);

  const limits = {
    maxDistance: input.limits?.maxDistance ?? DEFAULT_BANK_LOG_LIMITS.maxDistance,
    maxPages: input.limits?.maxPages ?? DEFAULT_BANK_LOG_LIMITS.maxPages,
    concurrency: input.limits?.concurrency ?? DEFAULT_BANK_LOG_LIMITS.concurrency,
    timeoutMs: input.limits?.timeoutMs ?? DEFAULT_BANK_LOG_LIMITS.timeoutMs,
    maxAttempts: input.limits?.maxAttempts ?? DEFAULT_BANK_LOG_LIMITS.maxAttempts,
    now: input.limits?.now ?? Date.now,
  };
  const started = limits.now();
  const deadline = started + limits.timeoutMs;

  let latest: bigint;
  try {
    latest = await input.source.latestBlock();
  } catch (error) {
    return unfinished("rpc", publicRpcError(error, "The log scan failed."));
  }
  if (input.deploymentBlock > latest) {
    return { ...unfinished("ahead", AHEAD), latestBlock: latest, fromBlock: input.deploymentBlock };
  }

  const planned = planLogPages(input.deploymentBlock, latest, limits.maxDistance);
  const { selected, coversAll } = selectLogPages(planned, limits.maxPages);
  const stop = { current: false };
  const outcomes = await runPages(selected, limits.concurrency, (page) =>
    readPage(input.source, page, limits.maxAttempts, () => limits.now() >= deadline, stop),
  );

  const tags: Tagged[] = [];
  let pagesRead = 0;
  let timeout = false;
  let rpc: string | null = null;
  for (const outcome of outcomes) {
    tags.push(...outcome.logs);
    if (outcome.ok) pagesRead += 1;
    else if (outcome.timeout) timeout = true;
    else if (!rpc && outcome.error) rpc = outcome.error;
  }

  const base = {
    fromBlock: input.deploymentBlock,
    toBlock: latest,
    latestBlock: latest,
    pagesPlanned: planned.length,
    pagesRead,
    coveredAll: coversAll && !timeout && !rpc && pagesRead === selected.length,
  };

  const confirmed = await keepConfirmed(input.source, tags);
  const rows = { funding: confirmed.funding, distributions: confirmed.distributions };
  if (timeout) return { ...unfinished("timeout", TIMEOUT), ...base, coveredAll: false, ...rows };
  if (rpc) return { ...unfinished("rpc", rpc), ...base, coveredAll: false, ...rows };
  if (confirmed.unreadable) return { ...unfinished("receipt", RECEIPT), ...base, coveredAll: false, ...rows };
  if (!coversAll || pagesRead !== selected.length) {
    return { ...unfinished("gap", GAP), ...base, coveredAll: false, ...rows };
  }
  const empty = rows.funding.length === 0 && rows.distributions.length === 0;
  return {
    status: empty ? "empty" : "complete",
    cause: empty ? "empty" : "complete",
    ...rows,
    ...base,
    coveredAll: true,
    reason: null,
  };
}

function unfinished(cause: BankLogScanCause, reason: string): BankLogScan {
  return {
    status: "unreadable",
    cause,
    funding: [],
    distributions: [],
    fromBlock: null,
    toBlock: null,
    latestBlock: null,
    pagesPlanned: 0,
    pagesRead: 0,
    coveredAll: false,
    reason,
  };
}

function decoded(tags: readonly Tagged[]): { funding: DecodedFunding[]; distributions: DecodedDistribution[] } {
  const funding: DecodedFunding[] = [];
  const distributions: DecodedDistribution[] = [];
  const seen = new Set<string>();
  for (const tagged of tags) {
    if (tagged.log.removed) continue;
    const key = logKey(tagged.log);
    if (!key || seen.has(key)) continue;
    if (tagged.kind === "chog_transfer") {
      const row = decodeDirectChogTransfer(tagged.log);
      if (!row) continue;
      seen.add(key);
      funding.push(row);
      continue;
    }
    const row = decodeBankLog(tagged.log);
    if (!row) continue;
    seen.add(key);
    if ("decisionId" in row) distributions.push(row);
    else funding.push(row);
  }
  return { funding: withoutFundedTransfers(sortFunding(funding)), distributions: sortDistributions(distributions) };
}

async function keepConfirmed(
  source: BankLogSource,
  tags: readonly Tagged[],
): Promise<{ funding: DecodedFunding[]; distributions: DecodedDistribution[]; unreadable: boolean }> {
  const preliminary = decoded(tags);
  const hashes = new Map<string, { hash: Hex; blockNumber: bigint }>();
  for (const row of [...preliminary.funding, ...preliminary.distributions]) {
    hashes.set(row.txHash.toLowerCase(), { hash: row.txHash as Hex, blockNumber: BigInt(row.blockNumber) });
  }
  const verdicts = new Map<string, "ok" | "drop" | "unread">();
  let unreadable = false;
  await runPages([...hashes.values()], DEFAULT_BANK_LOG_LIMITS.concurrency, async (item) => {
    try {
      const receipt = await source.receipt(item.hash);
      verdicts.set(
        item.hash.toLowerCase(),
        receipt.status === "success" && receipt.blockNumber === item.blockNumber ? "ok" : "drop",
      );
    } catch {
      verdicts.set(item.hash.toLowerCase(), "unread");
      unreadable = true;
    }
    return item;
  });
  const accepted = (hash: string) => verdicts.get(hash.toLowerCase()) === "ok";
  return {
    funding: preliminary.funding.filter((row) => accepted(row.txHash)),
    distributions: preliminary.distributions.filter((row) => accepted(row.txHash)),
    unreadable,
  };
}

type PageOutcome = { ok: boolean; timeout: boolean; error: string | null; logs: Tagged[] };

async function readPage(
  source: BankLogSource,
  page: Page,
  maxAttempts: number,
  expired: () => boolean,
  stop: { current: boolean },
): Promise<PageOutcome> {
  if (stop.current || expired()) {
    stop.current = true;
    return { ok: false, timeout: true, error: TIMEOUT, logs: [] };
  }
  const kinds: BankLogKind[] = ["funded", "distributed", "chog_transfer"];
  const parts = await Promise.all(kinds.map((kind) => readRange(source, kind, page.fromBlock, page.toBlock, maxAttempts, 0, expired)));
  const logs: Tagged[] = [];
  let error: string | null = null;
  let timeout = false;
  for (let index = 0; index < kinds.length; index += 1) {
    const part = parts[index];
    const kind = kinds[index];
    if (!part || !kind) continue;
    if (part.ok) {
      for (const log of part.logs) {
        if (log.blockNumber == null || log.blockNumber < page.fromBlock || log.blockNumber > page.toBlock) continue;
        logs.push({ kind, log });
      }
    } else if (part.timeout) {
      timeout = true;
      stop.current = true;
    } else {
      error = part.error;
    }
  }
  if (timeout) return { ok: false, timeout: true, error: TIMEOUT, logs };
  if (error) return { ok: false, timeout: false, error, logs };
  return { ok: true, timeout: false, error: null, logs };
}

async function readRange(
  source: BankLogSource,
  kind: BankLogKind,
  fromBlock: bigint,
  toBlock: bigint,
  maxAttempts: number,
  attempt: number,
  expired: () => boolean,
): Promise<{ ok: true; logs: readonly BankLogRecord[] } | { ok: false; timeout: boolean; error: string }> {
  if (expired()) return { ok: false, timeout: true, error: TIMEOUT };
  try {
    const logs = await source.logs({ kind, fromBlock, toBlock });
    return { ok: true, logs };
  } catch (error) {
    const text = errorText(error);
    const klass = classifyLogError(text);
    if (klass === "limit" && fromBlock < toBlock) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      const left = await readRange(source, kind, fromBlock, mid, maxAttempts, 0, expired);
      if (!left.ok) return left;
      const right = await readRange(source, kind, mid + 1n, toBlock, maxAttempts, 0, expired);
      if (!right.ok) return right;
      return { ok: true, logs: [...left.logs, ...right.logs] };
    }
    if (klass === "transient" && attempt + 1 < maxAttempts) {
      return readRange(source, kind, fromBlock, toBlock, maxAttempts, attempt + 1, expired);
    }
    return { ok: false, timeout: false, error: publicRpcError(error, "The log scan failed.") };
  }
}

function classifyLogError(message: string): "limit" | "transient" | "fatal" {
  if (/413|request entity too large|content too large/.test(message.toLowerCase())) return "limit";
  return rpcErrorClass(message);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & { shortMessage?: string; details?: string };
    return [extra.shortMessage, extra.details, extra.message].filter(Boolean).join(" ");
  }
  return "The log scan failed.";
}

async function runPages<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  async function lane(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  }
  if (items.length === 0) return [];
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

function logKey(log: BankLogRecord): string | null {
  if (!log.transactionHash || log.logIndex == null) return null;
  return `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

function sortFunding(rows: readonly DecodedFunding[]): DecodedFunding[] {
  return [...rows].sort((left, right) => compareRows(left.blockNumber, left.logIndex, right.blockNumber, right.logIndex));
}

function sortDistributions(rows: readonly DecodedDistribution[]): DecodedDistribution[] {
  return [...rows].sort((left, right) => compareRows(left.blockNumber, left.logIndex, right.blockNumber, right.logIndex));
}

function compareRows(leftBlock: string, leftIndex: number, rightBlock: string, rightIndex: number): number {
  const left = BigInt(leftBlock);
  const right = BigInt(rightBlock);
  if (left < right) return -1;
  if (left > right) return 1;
  return leftIndex - rightIndex;
}
