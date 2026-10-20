import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { explorerTxUrl } from "@/lib/blockchain/explorer";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import {
  CHOG_TRANSFER_ABI,
  CHOG_TRANSFER_TOPIC,
  decodeChogTransfers,
  transferDirectionNote,
  type DecodedChogTransfer,
  type TransferDirection,
} from "@/lib/economy/decode-transfer";
import {
  verifyMainnetReceipt,
  type ReceiptVerifyResult,
  type RpcCaller,
  type RpcVerifiedReceipt,
} from "@/lib/economy/verify-receipt";
import { publicRpcError } from "@/lib/verify/anchor";
import { rpcErrorClass } from "@/lib/watcher/range";
import { formatTokenAmount } from "@/lib/wallets/present";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 64;
const CURSOR_MAX_CHARS = 512;
const MAX_LOGS_PER_RESPONSE = 1_000;
const BUDGET_ERROR = "The read budget for this request is spent.";

/**
 * Hard ceilings for one public request. Callers can ask for less. They cannot ask for more.
 * The 100-block chunk matches the public Monad log span documented in docs/onchain-watcher.md.
 */
export const DISCOVERY_HARD_LIMITS = {
  maxBlocks: 400n,
  chunkBlocks: 100n,
  minChunkBlocks: 10n,
  maxCandidates: 12,
  maxVerified: 3,
  maxRpcCalls: 24,
  maxDisplay: 3,
} as const;

export const DISCOVERY_DECIMALS_NOTE = `Human-readable $CHOG amounts use the recorded ${recordedCheck.token.decimals} decimals from ${recordedCheck.observedOn}. This page did not read decimals() from the contract.`;

export const DISCOVERY_ACCOUNTING_NOTE =
  "Discovered transfers are not proposals, settlements, journal rows, or treasury totals.";

export type DiscoveryState =
  | "verified_page"
  | "empty_window"
  | "partial"
  | "unavailable"
  | "invalid_cursor"
  | "budget"
  | "unsupported";

export type DiscoveredActivityItem = {
  /** A displayed row was matched to a receipt. A cached row is not a new chain check. */
  evidence: "fresh_canonical_receipt" | "cached_canonical_receipt";
  status: "verified";
  fresh: boolean;
  cached: boolean;
  checkedAt: string;
  verificationLabel: string;
  txHash: `0x${string}`;
  blockNumber: string;
  blockHash: `0x${string}`;
  logIndex: number;
  token: Address;
  from: Address;
  to: Address;
  amountRaw: string;
  amountText: string;
  decimals: number;
  direction: TransferDirection;
  directionNote: string;
  /** True only when the configured economic treasury is one side. Still not an accounting entry. */
  treasuryAttributed: boolean;
  explorerHref: string | null;
  countsInTreasury: false;
};

export type DiscoveryDropped = {
  malformed: number;
  foreign: number;
  wrongTopic: number;
  duplicate: number;
  reverted: number;
  unavailable: number;
  inconsistent: number;
  unmatched: number;
};

export type DiscoveredActivityPage = {
  state: DiscoveryState;
  headline: string;
  detail: string;
  coverageNote: string | null;
  decimalsNote: string;
  accountingNote: string;
  chainId: 143 | null;
  token: Address;
  tip: string | null;
  scannedFrom: string | null;
  scannedTo: string | null;
  nextCursor: string | null;
  items: DiscoveredActivityItem[];
  dropped: DiscoveryDropped;
  logsReturned: number;
  rpcCalls: number;
};

type DiscoveryLimits = {
  maxBlocks: bigint;
  chunkBlocks: bigint;
  minChunkBlocks: bigint;
  maxCandidates: number;
  maxVerified: number;
  maxRpcCalls: number;
  maxDisplay: number;
};

type CursorPosition = { block: bigint; log: number | null };

type Candidate = {
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  logIndex: number;
  from: Address;
  to: Address;
  amountRaw: string;
  data: `0x${string}`;
  topics: readonly [`0x${string}`, `0x${string}`, `0x${string}`];
  conflict: boolean;
};

type Checked = {
  result: ReceiptVerifyResult;
  fresh: boolean;
  cached: boolean;
  checkedAt: string;
};

type CacheEntry = { at: number; result: ReceiptVerifyResult };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ReceiptVerifyResult>>();

export function resetDiscoveredActivityState(): void {
  cache.clear();
  inflight.clear();
}

export async function discoverChogActivity(input: {
  call: RpcCaller;
  treasury?: Address | null;
  cursor?: string | null;
  nowMs?: number;
  timeoutMs?: number;
  limits?: Partial<DiscoveryLimits>;
}): Promise<DiscoveredActivityPage> {
  const limits = clampLimits(input.limits);
  const now = input.nowMs ?? Date.now();
  const treasury = input.treasury ?? null;
  const parsed = parseCursor(input.cursor);
  if (!parsed.ok) {
    return finish({
      state: "invalid_cursor",
      headline: "The continuation cursor was rejected.",
      detail: `${parsed.reason} No blocks were scanned.`,
      chainId: null,
      tip: null,
      scannedFrom: null,
      scannedTo: null,
      nextCursor: null,
      items: [],
      dropped: emptyDropped(),
      logsReturned: 0,
      rpcCalls: 0,
    });
  }
  if (parsed.position && parsed.position.block === 0n && parsed.position.log === 0) {
    return finish({
      state: "empty_window",
      headline: "No older blocks remain.",
      detail: "The continuation cursor is at the start of Monad mainnet. No older $CHOG transfers were queried.",
      chainId: 143,
      tip: null,
      scannedFrom: null,
      scannedTo: null,
      nextCursor: null,
      items: [],
      dropped: emptyDropped(),
      logsReturned: 0,
      rpcCalls: 0,
    });
  }

  const budget = { used: 0, max: limits.maxRpcCalls };
  const call: RpcCaller = async (method, params) => {
    if (budget.used >= budget.max) {
      throw new Error(BUDGET_ERROR);
    }
    budget.used += 1;
    return input.call(method, params);
  };

  let chainRaw: unknown;
  try {
    chainRaw = await call("eth_chainId", []);
  } catch (error) {
    return failedBeforeScan(error, budget.used, "unavailable");
  }
  const chainId = parseQuantity(chainRaw);
  if (chainId === null) {
    return failedBeforeScan(new Error("The chain id response was malformed."), budget.used, "unavailable");
  }
  if (chainId !== 143n) {
    return finish({
      state: "unsupported",
      headline: "Discovery is pinned to Monad mainnet.",
      detail: "The RPC did not report chain id 143. No logs were queried.",
      chainId: null,
      tip: null,
      scannedFrom: null,
      scannedTo: null,
      nextCursor: null,
      items: [],
      dropped: emptyDropped(),
      logsReturned: 0,
      rpcCalls: budget.used,
    });
  }

  let tipRaw: unknown;
  try {
    tipRaw = await call("eth_blockNumber", []);
  } catch (error) {
    return failedBeforeScan(error, budget.used, "unavailable");
  }
  const tip = parseQuantity(tipRaw);
  if (tip === null || tip < 0n) {
    return failedBeforeScan(new Error("The block number response was malformed."), budget.used, "unavailable");
  }
  if (parsed.position && parsed.position.block > tip) {
    return finish({
      state: "invalid_cursor",
      headline: "The continuation cursor was rejected.",
      detail: "The continuation cursor is above the current chain tip. No logs were queried.",
      chainId: 143,
      tip: tip.toString(10),
      scannedFrom: null,
      scannedTo: null,
      nextCursor: null,
      items: [],
      dropped: emptyDropped(),
      logsReturned: 0,
      rpcCalls: budget.used,
    });
  }

  const position: CursorPosition = parsed.position ?? { block: tip, log: null };
  const upper = position.block;
  const span = upper + 1n < limits.maxBlocks ? upper + 1n : limits.maxBlocks;
  const plannedLower = upper - span + 1n;
  const dropped = emptyDropped();
  const candidates: Candidate[] = [];
  const seen = new Map<string, Candidate>();
  let logsReturned = 0;
  let scannedHigh: bigint | null = null;
  let scannedLow: bigint | null = null;
  let chunk = limits.chunkBlocks;
  let nextEnd = upper;
  let failure: { kind: "budget" | "provider_limit" | "rpc"; message: string } | null = null;

  while (nextEnd >= plannedLower && !failure && candidates.length < limits.maxCandidates) {
    const width = nextEnd - plannedLower + 1n < chunk ? nextEnd - plannedLower + 1n : chunk;
    const from = nextEnd - width + 1n;
    const to = nextEnd;
    const read = await readLogs(call, from, to);
    if (!read.ok) {
      if (read.split && chunk > limits.minChunkBlocks) {
        const halved = chunk / 2n;
        chunk = halved > limits.minChunkBlocks ? halved : limits.minChunkBlocks;
        continue;
      }
      failure = {
        kind: read.budget ? "budget" : read.split ? "provider_limit" : "rpc",
        message: read.error,
      };
      break;
    }
    logsReturned += read.logs.length;
    scannedHigh = scannedHigh === null || to > scannedHigh ? to : scannedHigh;
    scannedLow = scannedLow === null || from < scannedLow ? from : scannedLow;
    for (const raw of read.logs) {
      const parsedLog = parseDiscoveredLog(raw, from, to, position);
      if (parsedLog.kind === "skip") {
        continue;
      }
      if (parsedLog.kind !== "ok") {
        dropped[parsedLog.kind] += 1;
        continue;
      }
      const key = `143:${parsedLog.candidate.txHash}:${parsedLog.candidate.logIndex}`;
      const previous = seen.get(key);
      if (previous) {
        dropped.duplicate += 1;
        if (!sameTransfer(previous, parsedLog.candidate)) {
          previous.conflict = true;
          parsedLog.candidate.conflict = true;
        }
        continue;
      }
      seen.set(key, parsedLog.candidate);
      candidates.push(parsedLog.candidate);
    }
    nextEnd = from - 1n;
  }

  sortNewest(candidates);
  const items: DiscoveredActivityItem[] = [];
  const unresolved: Candidate[] = [];
  let verified = 0;
  let verificationBudget = false;
  for (const candidate of candidates) {
    if (candidate.conflict) {
      dropped.inconsistent += 1;
      continue;
    }
    if (failure?.kind === "budget" || items.length >= limits.maxDisplay || verified >= limits.maxVerified) {
      unresolved.push(candidate);
      if (verified >= limits.maxVerified) {
        verificationBudget = true;
      }
      continue;
    }
    const checked = await checkReceipt(candidate.txHash, call, now, input.timeoutMs);
    if (!checked.cached) {
      verified += 1;
    }
    if (!checked.result.ok && checked.result.outcome === "rpc_failure") {
      unresolved.push(candidate);
      failure = {
        kind: checked.result.reason.includes("read budget") ? "budget" : "rpc",
        message: checked.result.reason,
      };
      continue;
    }
    const matched = matchTransfer(candidate, checked.result, treasury);
    if (!matched.ok) {
      dropped[matched.reason] += 1;
      continue;
    }
    items.push(presentItem(matched.transfer, checked));
  }
  if (verificationBudget && !failure) {
    failure = { kind: "budget", message: "The receipt-verification budget for this request is spent." };
  }

  const scannedFrom = scannedLow === null ? null : scannedLow.toString(10);
  const scannedTo = scannedHigh === null ? null : scannedHigh.toString(10);
  const nextCursor = continuationCursor({ unresolved, scannedLow, failure });
  const state = chooseState({ items, dropped, failure, logsReturned });
  const coverage =
    scannedFrom !== null && scannedTo !== null
      ? `Scanned blocks ${scannedFrom}–${scannedTo} on Monad mainnet (chain 143). Token ${addresses.chogToken}. Chain tip ${tip.toString(10)}. This is a bounded window, not a full history of $CHOG.`
      : null;

  return finish({
    state,
    headline: headlineFor(state, items),
    detail: detailFor({ state, failure, dropped, scannedFrom, scannedTo, nextCursor, logsReturned, items: items.length }),
    coverageNote: coverage,
    chainId: 143,
    tip: tip.toString(10),
    scannedFrom,
    scannedTo,
    nextCursor,
    items,
    dropped,
    logsReturned,
    rpcCalls: budget.used,
  });
}

function continuationCursor(input: {
  unresolved: Candidate[];
  scannedLow: bigint | null;
  failure: { kind: string; message: string } | null;
}): string | null {
  if (input.unresolved.length > 0) {
    const newest = input.unresolved[0];
    if (!newest) {
      return null;
    }
    return encodeCursor({ block: newest.blockNumber, log: newest.logIndex + 1 });
  }
  if (input.scannedLow === null || input.scannedLow === 0n) {
    return null;
  }
  if (input.failure && input.failure.kind === "rpc") {
    return encodeCursor({ block: input.scannedLow - 1n, log: null });
  }
  return encodeCursor({ block: input.scannedLow - 1n, log: null });
}

function chooseState(input: {
  items: DiscoveredActivityItem[];
  dropped: DiscoveryDropped;
  failure: { kind: "budget" | "provider_limit" | "rpc"; message: string } | null;
  logsReturned: number;
}): DiscoveryState {
  if (input.failure?.kind === "budget") {
    return "budget";
  }
  if (input.failure?.kind === "rpc" && input.items.length === 0 && input.logsReturned === 0) {
    return "unavailable";
  }
  if (input.failure) {
    return "partial";
  }
  if (input.items.length > 0) {
    return "verified_page";
  }
  if (input.logsReturned === 0 && totalDropped(input.dropped) === 0) {
    return "empty_window";
  }
  return "partial";
}

function headlineFor(state: DiscoveryState, items: DiscoveredActivityItem[]): string {
  if (state === "verified_page") {
    if (items.every((item) => item.cached)) {
      return "Cached mainnet activity. This is not a fresh verification.";
    }
    if (items.some((item) => item.cached)) {
      return "Discovered mainnet activity. A cached row is not a fresh verification.";
    }
    return "Fresh verification: each listed transfer was found in its canonical Monad mainnet receipt.";
  }
  if (state === "empty_window") {
    return "No $CHOG transfers were found in the scanned window.";
  }
  if (state === "budget") {
    return "This request reached its read budget.";
  }
  if (state === "unavailable") {
    return "Mainnet activity could not be read.";
  }
  if (state === "unsupported") {
    return "Discovery is pinned to Monad mainnet.";
  }
  if (state === "invalid_cursor") {
    return "The continuation cursor was rejected.";
  }
  return "The scan stopped before a complete window.";
}

function detailFor(input: {
  state: DiscoveryState;
  failure: { kind: string; message: string } | null;
  dropped: DiscoveryDropped;
  scannedFrom: string | null;
  scannedTo: string | null;
  nextCursor: string | null;
  logsReturned: number;
  items: number;
}): string {
  const parts: string[] = [];
  if (input.state === "empty_window" && input.scannedFrom !== null && input.scannedTo !== null) {
    parts.push(
      input.nextCursor
        ? `No $CHOG Transfer logs were found in blocks ${input.scannedFrom}–${input.scannedTo}. Older blocks were not scanned.`
        : `No $CHOG Transfer logs were found in blocks ${input.scannedFrom}–${input.scannedTo}. This request reached block 0. It is not a claim that every historical transfer was listed.`,
    );
  }
  if (input.state === "verified_page" && input.nextCursor) {
    parts.push("Older blocks or logs were not included in this response.");
  }
  if (input.failure) {
    parts.push(input.failure.message);
  }
  if (input.state === "budget") {
    parts.push("Remaining logs in this window were not verified. Nothing from this stop was added to the ledger.");
  }
  if (input.items === 0 && (input.state === "partial" || input.state === "budget" || input.state === "unavailable")) {
    parts.push("An empty list here is not a claim that the token has no transfers.");
  }
  const dropped = droppedSentence(input.dropped);
  if (dropped) {
    parts.push(dropped);
  }
  if (input.logsReturned > 0 && input.state !== "verified_page") {
    parts.push(`${input.logsReturned} log ${input.logsReturned === 1 ? "row was" : "rows were"} returned by the bounded log query.`);
  }
  return parts.filter(Boolean).join(" ") || "No further detail.";
}

function droppedSentence(dropped: DiscoveryDropped): string {
  const parts: string[] = [];
  if (dropped.reverted) parts.push(`${dropped.reverted} reverted`);
  if (dropped.unavailable) parts.push(`${dropped.unavailable} unavailable`);
  if (dropped.inconsistent) parts.push(`${dropped.inconsistent} inconsistent`);
  if (dropped.unmatched) parts.push(`${dropped.unmatched} without a matching receipt log`);
  if (dropped.malformed) parts.push(`${dropped.malformed} malformed`);
  if (dropped.foreign) parts.push(`${dropped.foreign} from another contract`);
  if (dropped.wrongTopic) parts.push(`${dropped.wrongTopic} with another topic`);
  if (dropped.duplicate) parts.push(`${dropped.duplicate} duplicate`);
  return parts.length > 0 ? `Not displayed: ${parts.join(", ")}.` : "";
}

async function readLogs(
  call: RpcCaller,
  from: bigint,
  to: bigint,
): Promise<{ ok: true; logs: unknown[] } | { ok: false; split: boolean; budget: boolean; error: string }> {
  let attempt = 0;
  while (attempt < 2) {
    try {
      const result = await call("eth_getLogs", [
        {
          address: addresses.chogToken,
          fromBlock: hex(from),
          toBlock: hex(to),
          topics: [CHOG_TRANSFER_TOPIC],
        },
      ]);
      if (!Array.isArray(result)) {
        return { ok: false, split: false, budget: false, error: "The log response was malformed." };
      }
      if (result.length > MAX_LOGS_PER_RESPONSE) {
        return {
          ok: false,
          split: to > from,
          budget: false,
          error: "The log response exceeded the page size.",
        };
      }
      return { ok: true, logs: result };
    } catch (error) {
      const message = publicRpcError(error, "The log query failed.");
      if (message.includes("read budget")) {
        return { ok: false, split: false, budget: true, error: message };
      }
      const kind = rpcErrorClass(message);
      if (kind === "limit") {
        return { ok: false, split: true, budget: false, error: message };
      }
      if (kind === "transient" && attempt === 0) {
        attempt += 1;
        continue;
      }
      return { ok: false, split: false, budget: false, error: message };
    }
  }
  return { ok: false, split: false, budget: false, error: "The log query failed." };
}

function parseDiscoveredLog(
  value: unknown,
  from: bigint,
  to: bigint,
  position: CursorPosition,
): { kind: "ok"; candidate: Candidate } | { kind: "skip" } | { kind: keyof Pick<DiscoveryDropped, "malformed" | "foreign" | "wrongTopic" | "inconsistent"> } {
  const row = record(value);
  if (!row || row.removed === true) {
    return { kind: "malformed" };
  }
  let token: Address;
  try {
    token = getAddress(typeof row.address === "string" ? row.address : "");
  } catch {
    return { kind: "malformed" };
  }
  if (token !== addresses.chogToken) {
    return { kind: "foreign" };
  }
  if (!Array.isArray(row.topics) || row.topics.length === 0 || typeof row.topics[0] !== "string" || !HASH.test(row.topics[0])) {
    return { kind: "malformed" };
  }
  const topic0 = row.topics[0].toLowerCase() as `0x${string}`;
  if (topic0 !== CHOG_TRANSFER_TOPIC) {
    return { kind: "wrongTopic" };
  }
  if (row.topics.length !== 3) {
    return { kind: "malformed" };
  }
  const topics = row.topics.map((topic) => (typeof topic === "string" ? topic.toLowerCase() : ""));
  if (topics.some((topic) => !HASH.test(topic))) {
    return { kind: "malformed" };
  }
  const data = typeof row.data === "string" && /^0x[0-9a-fA-F]{64}$/.test(row.data) ? (row.data.toLowerCase() as `0x${string}`) : null;
  const blockNumber = parseQuantity(row.blockNumber);
  const blockHash = typeof row.blockHash === "string" && HASH.test(row.blockHash) ? (row.blockHash.toLowerCase() as `0x${string}`) : null;
  const txHash = typeof row.transactionHash === "string" && HASH.test(row.transactionHash) ? (row.transactionHash.toLowerCase() as `0x${string}`) : null;
  const indexRaw = parseQuantity(row.logIndex);
  if (!data || blockNumber === null || !blockHash || !txHash || indexRaw === null || indexRaw < 0n || indexRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { kind: "malformed" };
  }
  if (blockNumber < from || blockNumber > to) {
    return { kind: "inconsistent" };
  }
  const logIndex = Number(indexRaw);
  if (!included(blockNumber, logIndex, position)) {
    return { kind: "skip" };
  }
  try {
    const decoded = decodeEventLog({
      abi: CHOG_TRANSFER_ABI,
      data,
      topics: topics as [Hex, ...Hex[]],
    });
    if (decoded.eventName !== "Transfer" || decoded.args.value <= 0n) {
      return { kind: "malformed" };
    }
    const sender = getAddress(decoded.args.from);
    const recipient = getAddress(decoded.args.to);
    return {
      kind: "ok",
      candidate: {
        txHash,
        blockNumber,
        blockHash,
        logIndex,
        from: sender,
        to: recipient,
        amountRaw: decoded.args.value.toString(10),
        data,
        topics: [topics[0] as `0x${string}`, topics[1] as `0x${string}`, topics[2] as `0x${string}`],
        conflict: false,
      },
    };
  } catch {
    return { kind: "malformed" };
  }
}

function included(block: bigint, logIndex: number, position: CursorPosition): boolean {
  if (block < position.block) {
    return true;
  }
  if (block > position.block) {
    return false;
  }
  if (position.log === null) {
    return true;
  }
  return logIndex < position.log;
}

function matchTransfer(
  candidate: Candidate,
  result: ReceiptVerifyResult,
  treasury: Address | null,
): { ok: true; transfer: DecodedChogTransfer } | { ok: false; reason: keyof Pick<DiscoveryDropped, "reverted" | "unavailable" | "inconsistent" | "unmatched"> } {
  if (!result.ok) {
    if (result.outcome === "missing") {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "inconsistent" };
  }
  const receipt = result.receipt;
  if (receipt.txHash !== candidate.txHash) {
    return { ok: false, reason: "inconsistent" };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "reverted" };
  }
  if (receipt.blockNumber !== candidate.blockNumber || receipt.blockHash !== candidate.blockHash || !receipt.logsRead) {
    return { ok: false, reason: "inconsistent" };
  }
  const log = receipt.logs.find((item) => item.index === candidate.logIndex);
  if (!log) {
    return { ok: false, reason: "unmatched" };
  }
  let token: Address;
  try {
    token = getAddress(log.address);
  } catch {
    return { ok: false, reason: "inconsistent" };
  }
  if (token !== addresses.chogToken || log.topics.length !== 3 || log.topics[0] !== CHOG_TRANSFER_TOPIC) {
    return { ok: false, reason: "unmatched" };
  }
  if (log.topics[1] !== candidate.topics[1] || log.topics[2] !== candidate.topics[2] || log.data !== candidate.data) {
    return { ok: false, reason: "inconsistent" };
  }
  const decoded = decodeChogTransfers(receipt, treasury);
  if (!decoded.consistent) {
    return { ok: false, reason: "inconsistent" };
  }
  const transfer = decoded.transfers.find((item) => item.logIndex === candidate.logIndex);
  if (!transfer) {
    return { ok: false, reason: "unmatched" };
  }
  if (transfer.amountRaw !== candidate.amountRaw || transfer.from !== candidate.from || transfer.to !== candidate.to) {
    return { ok: false, reason: "inconsistent" };
  }
  return { ok: true, transfer };
}

function presentItem(transfer: DecodedChogTransfer, checked: Checked): DiscoveredActivityItem {
  const receipt = (checked.result as { ok: true; receipt: RpcVerifiedReceipt }).receipt;
  const cached = checked.cached;
  return {
    evidence: cached ? "cached_canonical_receipt" : "fresh_canonical_receipt",
    status: "verified",
    fresh: checked.fresh,
    cached,
    checkedAt: checked.checkedAt,
    verificationLabel: cached
      ? `Cached verification from ${checked.checkedAt}. This is not a fresh verification.`
      : "Fresh verification. This transfer was found in the canonical receipt.",
    txHash: transfer.txHash,
    blockNumber: receipt.blockNumber.toString(10),
    blockHash: receipt.blockHash,
    logIndex: transfer.logIndex,
    token: transfer.token,
    from: transfer.from,
    to: transfer.to,
    amountRaw: transfer.amountRaw,
    amountText: formatTokenAmount(transfer.amountRaw, recordedCheck.token.decimals, transfer.symbol),
    decimals: recordedCheck.token.decimals,
    direction: transfer.direction,
    directionNote: transferDirectionNote(transfer.direction),
    treasuryAttributed: transfer.direction === "treasury_in" || transfer.direction === "treasury_out",
    explorerHref: explorerTxUrl(143, transfer.txHash),
    countsInTreasury: false,
  };
}

async function checkReceipt(txHash: string, call: RpcCaller, now: number, timeoutMs?: number): Promise<Checked> {
  const key = `143:${txHash}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { result: hit.result, fresh: false, cached: true, checkedAt: new Date(hit.at).toISOString() };
  }
  const existing = inflight.get(key);
  if (existing) {
    const result = await existing;
    return { result, fresh: true, cached: false, checkedAt: new Date(now).toISOString() };
  }
  let settle: (value: ReceiptVerifyResult) => void = () => undefined;
  const pending = new Promise<ReceiptVerifyResult>((resolve) => {
    settle = resolve;
  });
  inflight.set(key, pending);
  try {
    const result = await verifyMainnetReceipt({ txHash, call, timeoutMs });
    const localBudget = !result.ok && result.reason.includes("read budget");
    if (!localBudget) {
      remember(key, { at: now, result });
    }
    settle(result);
    return { result, fresh: true, cached: false, checkedAt: new Date(now).toISOString() };
  } catch (error) {
    const result: ReceiptVerifyResult = {
      ok: false,
      outcome: "rpc_failure",
      reason: publicRpcError(error, "The read-only RPC failed."),
    };
    settle(result);
    return { result, fresh: true, cached: false, checkedAt: new Date(now).toISOString() };
  } finally {
    inflight.delete(key);
  }
}

/** Reject a cursor before any RPC. A blank cursor means "start at the chain tip". */
export function activityCursorError(cursor: string | null | undefined): string | null {
  const parsed = parseCursor(cursor);
  return parsed.ok ? null : parsed.reason;
}

function parseCursor(value: string | null | undefined): { ok: true; position: CursorPosition | null } | { ok: false; reason: string } {
  if (value == null || value.trim() === "") {
    return { ok: true, position: null };
  }
  const text = value.trim();
  if (text.length > CURSOR_MAX_CHARS) {
    return { ok: false, reason: "The continuation cursor is too long." };
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The continuation cursor is malformed." };
  }
  const row = record(body);
  if (!row) {
    return { ok: false, reason: "The continuation cursor is malformed." };
  }
  const keys = Object.keys(row);
  if (keys.some((key) => !["v", "chainId", "token", "block", "log"].includes(key)) || row.v !== 1 || row.chainId !== 143) {
    return { ok: false, reason: "The continuation cursor is not for Monad mainnet." };
  }
  let token: Address;
  try {
    token = getAddress(typeof row.token === "string" ? row.token : "");
  } catch {
    return { ok: false, reason: "The continuation cursor is not for the configured $CHOG token." };
  }
  if (token !== addresses.chogToken || typeof row.block !== "string" || !DECIMAL.test(row.block)) {
    return { ok: false, reason: "The continuation cursor is not for the configured $CHOG token." };
  }
  const block = BigInt(row.block);
  if (row.log == null) {
    return { ok: true, position: { block, log: null } };
  }
  if (typeof row.log !== "number" || !Number.isInteger(row.log) || row.log < 0 || row.log > 100_000) {
    return { ok: false, reason: "The continuation cursor is malformed." };
  }
  return { ok: true, position: { block, log: row.log } };
}

function encodeCursor(position: CursorPosition): string {
  const payload = {
    v: 1,
    chainId: 143,
    token: addresses.chogToken.toLowerCase(),
    block: position.block.toString(10),
    log: position.log,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function clampLimits(input: Partial<DiscoveryLimits> | undefined): DiscoveryLimits {
  const maxBlocks = clampBig(input?.maxBlocks, DISCOVERY_HARD_LIMITS.maxBlocks, 1n, DISCOVERY_HARD_LIMITS.maxBlocks);
  const chunkBlocks = clampBig(input?.chunkBlocks, DISCOVERY_HARD_LIMITS.chunkBlocks, 1n, DISCOVERY_HARD_LIMITS.chunkBlocks);
  const minChunkBlocks = clampBig(input?.minChunkBlocks, DISCOVERY_HARD_LIMITS.minChunkBlocks, 1n, chunkBlocks);
  return {
    maxBlocks,
    chunkBlocks,
    minChunkBlocks,
    maxCandidates: clampInt(input?.maxCandidates, DISCOVERY_HARD_LIMITS.maxCandidates, 1, DISCOVERY_HARD_LIMITS.maxCandidates),
    maxVerified: clampInt(input?.maxVerified, DISCOVERY_HARD_LIMITS.maxVerified, 1, DISCOVERY_HARD_LIMITS.maxVerified),
    maxRpcCalls: clampInt(input?.maxRpcCalls, DISCOVERY_HARD_LIMITS.maxRpcCalls, 4, DISCOVERY_HARD_LIMITS.maxRpcCalls),
    maxDisplay: clampInt(input?.maxDisplay, DISCOVERY_HARD_LIMITS.maxDisplay, 1, DISCOVERY_HARD_LIMITS.maxDisplay),
  };
}

function failedBeforeScan(error: unknown, rpcCalls: number, state: "unavailable" | "budget"): DiscoveredActivityPage {
  const message = publicRpcError(error, "The read-only RPC failed.");
  const budget = message.includes("read budget");
  return finish({
    state: budget ? "budget" : state,
    headline: budget ? "This request reached its read budget." : "Mainnet activity could not be read.",
    detail: `${message} No $CHOG logs were scanned. This is not a claim that the token has no transfers.`,
    chainId: null,
    tip: null,
    scannedFrom: null,
    scannedTo: null,
    nextCursor: null,
    items: [],
    dropped: emptyDropped(),
    logsReturned: 0,
    rpcCalls,
  });
}

function finish(
  page: Omit<DiscoveredActivityPage, "decimalsNote" | "accountingNote" | "token" | "coverageNote"> & {
    token?: Address;
    coverageNote?: string | null;
  },
): DiscoveredActivityPage {
  return {
    ...page,
    coverageNote: page.coverageNote ?? null,
    token: addresses.chogToken,
    decimalsNote: DISCOVERY_DECIMALS_NOTE,
    accountingNote: DISCOVERY_ACCOUNTING_NOTE,
  };
}

function emptyDropped(): DiscoveryDropped {
  return {
    malformed: 0,
    foreign: 0,
    wrongTopic: 0,
    duplicate: 0,
    reverted: 0,
    unavailable: 0,
    inconsistent: 0,
    unmatched: 0,
  };
}

function totalDropped(dropped: DiscoveryDropped): number {
  return (
    dropped.malformed +
    dropped.foreign +
    dropped.wrongTopic +
    dropped.duplicate +
    dropped.reverted +
    dropped.unavailable +
    dropped.inconsistent +
    dropped.unmatched
  );
}

function sameTransfer(left: Candidate, right: Candidate): boolean {
  return (
    left.txHash === right.txHash &&
    left.logIndex === right.logIndex &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.amountRaw === right.amountRaw &&
    left.from === right.from &&
    left.to === right.to &&
    left.data === right.data
  );
}

function sortNewest(candidates: Candidate[]): void {
  candidates.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber > right.blockNumber ? -1 : 1;
    }
    return right.logIndex - left.logIndex;
  });
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.delete(oldest);
  }
}

function clampBig(value: bigint | undefined, fallback: bigint, min: bigint, max: bigint): bigint {
  const requested = value ?? fallback;
  if (requested < min) {
    return min;
  }
  if (requested > max) {
    return max;
  }
  return requested;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const requested = value ?? fallback;
  if (!Number.isInteger(requested) || requested < min) {
    return min;
  }
  if (requested > max) {
    return max;
  }
  return requested;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
