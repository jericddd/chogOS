import { formatUnits, getAddress, isAddress, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { explorerAddressUrl } from "@/lib/blockchain/explorer";
import { MAX_LOG_DISTANCE, planLogPages, selectLogPages } from "@/lib/economy/bank-log-scan";

/** Standard ERC-20 Transfer(address,address,uint256). */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type HeldTokenLimits = {
  maxPages: number;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
};

export const HELD_TOKEN_LIMITS: HeldTokenLimits = {
  maxPages: 32,
  concurrency: 4,
  timeoutMs: 4_000,
  maxTokens: 8,
};

export type HeldTokenLog = {
  address: string;
  topics: readonly string[];
  removed?: boolean;
};

export type HeldTokenReading = {
  address: string;
  symbol: string | null;
  decimals: number | null;
  raw: string;
};

export type HeldTokenScan = {
  status: "unread" | "empty" | "partial" | "complete";
  rows: HeldTokenReading[];
};

export type HeldTokenSource = {
  latestBlock(): Promise<bigint>;
  logs(query: { fromBlock: bigint; toBlock: bigint }): Promise<readonly HeldTokenLog[]>;
  token(address: string): Promise<{ balance: bigint | null; symbol: string | null; decimals: number | null }>;
};

export type PublicOtherToken = {
  address: string;
  href: string | null;
  label: string;
  amountText: string;
};

const NOTES = {
  unread: "Other tokens were not read. MON and $CHOG above are separate balance reads.",
  empty:
    "No other token balance was found from the deployment block through the latest block. A token that does not emit a standard Transfer can be missed.",
  partial:
    "This reading did not cover every transfer into the contract. Tokens below are only the ones found. A missing token is not proof the contract holds nothing else.",
  complete: "Other tokens held by this contract. ChogBank pays MON and $CHOG. These tokens stay in the contract.",
} as const;

export function transferToTopic(address: string): Hex | null {
  if (!isAddress(address)) return null;
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

export function quietTokenLabel(symbol: string | null): string {
  if (!symbol) return "Unknown token";
  const trimmed = symbol.trim();
  if (!/^[A-Za-z0-9.$]{1,12}$/.test(trimmed)) return "Unknown token";
  if (trimmed.toUpperCase() === "MON" || trimmed.toUpperCase() === "CHOG" || trimmed.toUpperCase() === "$CHOG") {
    return "Unknown token";
  }
  return trimmed;
}

export function tokenAddressesFromTransferLogs(logs: readonly HeldTokenLog[], bank: string, skip: readonly string[] = []): string[] {
  const topic = transferToTopic(bank);
  if (!topic) return [];
  const skipSet = new Set(skip.map((item) => item.toLowerCase()));
  skipSet.add(bank.toLowerCase());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics[2]?.toLowerCase() !== topic) continue;
    if (!isAddress(log.address)) continue;
    const normalized = getAddress(log.address);
    const lower = normalized.toLowerCase();
    if (skipSet.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(normalized);
  }
  return out;
}

export function presentOtherTokens(scan: HeldTokenScan | undefined): {
  status: HeldTokenScan["status"];
  note: string;
  rows: PublicOtherToken[];
} {
  if (!scan || scan.status === "unread") {
    return { status: "unread", note: NOTES.unread, rows: [] };
  }
  const rows = scan.status === "empty" ? [] : rowsFrom(scan.rows);
  if (scan.status === "partial") return { status: "partial", note: NOTES.partial, rows };
  if (rows.length === 0) return { status: "empty", note: NOTES.empty, rows: [] };
  return { status: "complete", note: NOTES.complete, rows };
}

export async function scanHeldTokens(input: {
  bank: string;
  deploymentBlock: bigint | null;
  skip?: readonly string[];
  source: HeldTokenSource;
  limits?: Partial<HeldTokenLimits> & { now?: () => number };
}): Promise<HeldTokenScan> {
  if (input.deploymentBlock == null || input.deploymentBlock < 0n) return { status: "unread", rows: [] };
  const limits = {
    maxPages: input.limits?.maxPages ?? HELD_TOKEN_LIMITS.maxPages,
    concurrency: input.limits?.concurrency ?? HELD_TOKEN_LIMITS.concurrency,
    timeoutMs: input.limits?.timeoutMs ?? HELD_TOKEN_LIMITS.timeoutMs,
    maxTokens: input.limits?.maxTokens ?? HELD_TOKEN_LIMITS.maxTokens,
    now: input.limits?.now ?? Date.now,
  };
  const deadline = limits.now() + limits.timeoutMs;
  const expired = () => limits.now() >= deadline;

  let latest: bigint;
  try {
    latest = await input.source.latestBlock();
  } catch {
    return { status: "unread", rows: [] };
  }
  if (input.deploymentBlock > latest) return { status: "unread", rows: [] };

  const planned = planLogPages(input.deploymentBlock, latest, MAX_LOG_DISTANCE);
  const { selected, coversAll } = selectLogPages(planned, limits.maxPages);
  if (selected.length === 0) return { status: "unread", rows: [] };

  const outcomes = await runPool(selected, limits.concurrency, (page) => readLogs(input.source, page.fromBlock, page.toBlock, expired));
  const logs: HeldTokenLog[] = [];
  let pagesRead = 0;
  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      pagesRead += 1;
      logs.push(...outcome.logs);
    } else {
      failed = true;
    }
  }
  if (pagesRead === 0) return { status: "unread", rows: [] };

  const found = tokenAddressesFromTransferLogs(logs, input.bank, input.skip ?? [addresses.chogToken]);
  const capped = found.length > limits.maxTokens;
  const chosen = found.slice(0, limits.maxTokens);
  const missed = { current: false };
  const rows: HeldTokenReading[] = [];
  await runPool(chosen, limits.concurrency, async (token) => {
    if (expired()) {
      missed.current = true;
      return;
    }
    try {
      const reading = await input.source.token(token);
      if (reading.balance == null) {
        missed.current = true;
        return;
      }
      if (reading.balance <= 0n) return;
      rows.push({
        address: getAddress(token),
        symbol: reading.symbol,
        decimals: reading.decimals,
        raw: reading.balance.toString(10),
      });
    } catch {
      missed.current = true;
    }
  });

  const order = new Map(chosen.map((address, index) => [address.toLowerCase(), index]));
  rows.sort((left, right) => (order.get(left.address.toLowerCase()) ?? 0) - (order.get(right.address.toLowerCase()) ?? 0));
  const incomplete = !coversAll || failed || pagesRead !== selected.length || capped || missed.current;
  if (incomplete) return { status: "partial", rows };
  if (rows.length === 0) return { status: "empty", rows: [] };
  return { status: "complete", rows };
}

function rowsFrom(readings: readonly HeldTokenReading[]): PublicOtherToken[] {
  const seen = new Set<string>();
  const rows: PublicOtherToken[] = [];
  for (const reading of readings) {
    if (!isAddress(reading.address)) continue;
    const address = getAddress(reading.address);
    const lower = address.toLowerCase();
    if (seen.has(lower) || lower === addresses.chogToken.toLowerCase()) continue;
    const amountText = amountFrom(reading.raw, reading.decimals);
    if (!amountText) continue;
    seen.add(lower);
    rows.push({
      address,
      href: explorerAddressUrl(143, address),
      label: quietTokenLabel(reading.symbol),
      amountText,
    });
  }
  return rows;
}

function amountFrom(raw: string, decimals: number | null): string | null {
  if (!/^[0-9]+$/.test(raw) || raw === "0") return null;
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return `${raw} raw units`;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return `${raw} raw units`;
  }
}

async function readLogs(
  source: HeldTokenSource,
  fromBlock: bigint,
  toBlock: bigint,
  expired: () => boolean,
): Promise<{ ok: true; logs: HeldTokenLog[] } | { ok: false; timeout: boolean }> {
  if (expired()) return { ok: false, timeout: true };
  try {
    const logs = await source.logs({ fromBlock, toBlock });
    return { ok: true, logs: logs.filter((log) => log.removed !== true) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/100 range|limited to a 100|response size|too large|413/i.test(message) && toBlock > fromBlock) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      const left = await readLogs(source, fromBlock, mid, expired);
      if (!left.ok) return left;
      const right = await readLogs(source, mid + 1n, toBlock, expired);
      if (!right.ok) return right;
      return { ok: true, logs: [...left.logs, ...right.logs] };
    }
    return { ok: false, timeout: false };
  }
}

async function runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
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
