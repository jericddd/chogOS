import type { Address } from "viem";
import { explorerTxUrl } from "@/lib/blockchain/explorer";
import { recordedCheck } from "@/lib/blockchain/recorded-check";
import { decodeChogTransfers, transferDirectionNote, type DecodedChogTransfer } from "@/lib/economy/decode-transfer";
import type { StoredReceiptRecord } from "@/lib/economy/present";
import { isRpcVerifiedReceipt, verifyMainnetReceipt, type ReceiptVerifyResult, type RpcCaller } from "@/lib/economy/verify-receipt";
import { formatTokenAmount } from "@/lib/wallets/present";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 64;
const DEFAULT_RPC_LIMIT = 30;
const RPC_WINDOW_MS = 60_000;
export const PUBLIC_RECEIPT_LIMIT = 8;

type CacheEntry = {
  at: number;
  result: ReceiptVerifyResult;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ReceiptVerifyResult>>();
const rpcTimes: number[] = [];

export function resetPublicVerificationState(): void {
  cache.clear();
  inflight.clear();
  rpcTimes.length = 0;
}

export type RecordedEvidence = {
  txHash: string;
  proposalStatus: string | null;
  stored: StoredReceiptRecord | null;
};

export type PublicTransferView = {
  logIndex: number;
  token: string;
  amountRaw: string;
  amountText: string;
  decimals: number;
  from: string;
  to: string;
  direction: DecodedChogTransfer["direction"];
  directionNote: string;
  countsInTreasury: false;
};

export type PublicReceiptStatus = "verified" | "reverted" | "pending_or_unavailable" | "invalid_or_inconsistent";

export type PublicReceiptCheck = {
  txHash: string;
  status: PublicReceiptStatus;
  fresh: boolean;
  cached: boolean;
  checkedAt: string;
  blockNumber: string | null;
  blockHash: string | null;
  receiptStatus: "success" | "reverted" | null;
  headline: string;
  reason: string;
  discrepancy: string | null;
  explorerHref: string | null;
  transfers: PublicTransferView[];
  transferNote: string;
  settlement: "stored_settlement" | "not_settled" | "disputed";
  settlementNote: string;
};

export type ReceiptCheckBatch = {
  checks: PublicReceiptCheck[];
  note: string;
  focusNote: string | null;
};

type Checked = {
  result: ReceiptVerifyResult;
  fresh: boolean;
  cached: boolean;
  checkedAt: string;
};

/**
 * Re-read recorded economy hashes through verifyMainnetReceipt.
 * This does not open a database client and does not settle a proposal.
 */
export async function recheckRecordedReceipts(input: {
  records: readonly RecordedEvidence[];
  call: RpcCaller;
  treasury?: Address | null;
  nowMs?: number;
  focusTx?: string | null;
  limit?: number;
  rpcLimit?: number;
  bypassCache?: boolean;
  timeoutMs?: number;
}): Promise<ReceiptCheckBatch> {
  const now = input.nowMs ?? Date.now();
  const limit = input.limit ?? PUBLIC_RECEIPT_LIMIT;
  const grouped = groupEvidence(input.records);
  const focus = normalizeFocus(input.focusTx);
  let focusNote: string | null = null;
  if (focus.kind === "malformed") {
    focusNote = "The requested transaction hash is malformed, so it was not sent to the RPC.";
  } else if (focus.kind === "hash" && !grouped.has(focus.hash)) {
    focusNote = "That transaction is not recorded economy evidence, so it was not sent to the RPC.";
  }

  const ordered: string[] = [];
  if (focus.kind === "hash" && grouped.has(focus.hash)) {
    ordered.push(focus.hash);
  }
  for (const hash of grouped.keys()) {
    if (!ordered.includes(hash)) {
      ordered.push(hash);
    }
  }
  const selected = ordered.slice(0, Math.max(0, limit));
  const checks: PublicReceiptCheck[] = [];
  for (const hash of selected) {
    const rows = grouped.get(hash) ?? [];
    const checked = await checkHash({
      txHash: hash,
      call: input.call,
      now,
      bypassCache: input.bypassCache === true,
      rpcLimit: input.rpcLimit ?? DEFAULT_RPC_LIMIT,
      timeoutMs: input.timeoutMs,
    });
    checks.push(presentCheck(hash, rows, checked, input.treasury ?? null));
  }

  const hidden = ordered.length - selected.length;
  const note =
    ordered.length === 0
      ? "No recorded economy receipt is loaded. This page does not invent a transaction."
      : hidden > 0
        ? `Showing ${selected.length} of ${ordered.length} recorded transactions. The rest were not checked on this load.`
        : "Each row is a read of Monad mainnet for a hash already stored by the economy. A stored row is not itself a fresh verification.";

  return { checks, note, focusNote };
}

export function receiptDiscrepancy(
  stored: readonly StoredReceiptRecord[],
  canonical: { status: "success" | "reverted"; blockNumber: string; blockHash: string } | null,
): string | null {
  const present = stored.filter((row) => row.chainId !== null || row.status || row.blockNumber || row.blockHash);
  if (present.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (!canonical) {
    parts.push("A stored receipt row is not a fresh mainnet verification.");
  }
  const chains = unique(present.map((row) => (row.chainId === null ? null : String(row.chainId))).filter((value): value is string => value !== null));
  if (chains.some((chain) => chain !== "143") || chains.length > 1) {
    parts.push("Stored chain ids disagree or are not Monad mainnet 143.");
  }
  const statuses = unique(present.map((row) => row.status).filter((value): value is string => Boolean(value)));
  if (statuses.length > 1 || (canonical && statuses.some((status) => status !== canonical.status))) {
    parts.push("The stored receipt status does not match the canonical receipt.");
  }
  const blocks = unique(present.map((row) => row.blockNumber).filter((value): value is string => Boolean(value)));
  if (blocks.length > 1 || (canonical && blocks.some((block) => block !== canonical.blockNumber))) {
    parts.push("The stored block number does not match the canonical block.");
  }
  const hashes = unique(present.map((row) => row.blockHash).filter((value): value is string => Boolean(value)));
  if (hashes.length > 1 || (canonical && hashes.some((hash) => hash !== canonical.blockHash))) {
    parts.push("The stored block hash does not match the canonical block. The stored row is not freshly verified.");
  }
  if (!canonical && parts.length === 1 && parts[0] === "A stored receipt row is not a fresh mainnet verification.") {
    return parts[0];
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

async function checkHash(input: {
  txHash: string;
  call: RpcCaller;
  now: number;
  bypassCache: boolean;
  rpcLimit: number;
  timeoutMs?: number;
}): Promise<Checked> {
  const key = input.txHash;
  if (!input.bypassCache) {
    const hit = cache.get(key);
    if (hit && input.now - hit.at < CACHE_TTL_MS) {
      return { result: hit.result, fresh: false, cached: true, checkedAt: new Date(hit.at).toISOString() };
    }
    const pending = inflight.get(key);
    if (pending) {
      const result = await pending;
      return { result, fresh: true, cached: false, checkedAt: new Date(input.now).toISOString() };
    }
  }
  if (!takeRpcBudget(input.now, input.rpcLimit)) {
    return {
      result: { ok: false, outcome: "rpc_failure", reason: "Receipt checks are paused for this window. Nothing was verified." },
      fresh: false,
      cached: false,
      checkedAt: new Date(input.now).toISOString(),
    };
  }
  const pending = verifyMainnetReceipt({ txHash: input.txHash, call: input.call, timeoutMs: input.timeoutMs }).then((result) => {
    remember(key, { at: input.now, result });
    return result;
  });
  inflight.set(key, pending);
  try {
    const result = await pending;
    return { result, fresh: true, cached: false, checkedAt: new Date(input.now).toISOString() };
  } finally {
    inflight.delete(key);
  }
}

function presentCheck(
  txHash: string,
  rows: readonly RecordedEvidence[],
  checked: Checked,
  treasury: Address | null,
): PublicReceiptCheck {
  const status = toStatus(checked.result);
  const canonical = canonicalOf(checked.result);
  const stored = rows.map((row) => row.stored).filter((row): row is StoredReceiptRecord => row !== null);
  let discrepancy = receiptDiscrepancy(stored, canonical);
  if (discrepancy && checked.cached) {
    discrepancy = `${discrepancy} Compared with the cached receipt, not a new chain read.`;
  }
  const decoded = checked.result.ok ? decodeChogTransfers(checked.result.receipt, treasury) : null;
  const settlement = settlementOf(rows.map((row) => row.proposalStatus));
  return {
    txHash,
    status,
    fresh: checked.fresh,
    cached: checked.cached,
    checkedAt: checked.checkedAt,
    blockNumber: canonical?.blockNumber ?? null,
    blockHash: canonical?.blockHash ?? null,
    receiptStatus: canonical?.status ?? null,
    headline: headline(status, checked),
    reason: checked.result.ok ? canonicalReason(checked.result.receipt.status) : checked.result.reason,
    discrepancy,
    explorerHref: checked.result.ok ? explorerTxUrl(143, txHash) : null,
    transfers: (decoded?.transfers ?? []).map(presentTransfer),
    transferNote: decoded?.note ?? "No transfer is decoded without a canonical receipt.",
    settlement: settlement.kind,
    settlementNote: settlement.note,
  };
}

function presentTransfer(transfer: DecodedChogTransfer): PublicTransferView {
  return {
    logIndex: transfer.logIndex,
    token: transfer.token,
    amountRaw: transfer.amountRaw,
    amountText: formatTokenAmount(transfer.amountRaw, transfer.decimals, transfer.symbol),
    decimals: recordedCheck.token.decimals,
    from: transfer.from,
    to: transfer.to,
    direction: transfer.direction,
    directionNote: transferDirectionNote(transfer.direction),
    countsInTreasury: false,
  };
}

function headline(status: PublicReceiptStatus, checked: Checked): string {
  if (!checked.fresh && !checked.cached) {
    return "Receipt checks are paused for this window. Nothing was verified.";
  }
  if (checked.cached) {
    const when = checked.checkedAt;
    if (status === "verified") {
      return `Cached successful receipt from ${when}. This is not a fresh verification.`;
    }
    if (status === "reverted") {
      return `Cached reverted receipt from ${when}. This is not a fresh verification.`;
    }
    if (status === "pending_or_unavailable") {
      return `Cached unavailable result from ${when}. This is not a fresh verification.`;
    }
    return `Cached inconsistent result from ${when}. This is not a fresh verification.`;
  }
  if (status === "verified") {
    return "Fresh verification: the successful receipt matches the canonical mainnet block.";
  }
  if (status === "reverted") {
    return "Fresh verification: the canonical receipt reverted. It is not a successful transfer.";
  }
  if (status === "pending_or_unavailable") {
    return "No receipt can be confirmed right now.";
  }
  return "The chain evidence is inconsistent. It is not verified.";
}

function canonicalReason(status: "success" | "reverted"): string {
  return status === "success"
    ? "The receipt status is success and the block hash matches the canonical mainnet block."
    : "The receipt status is reverted and the block hash matches the canonical mainnet block.";
}

function toStatus(result: ReceiptVerifyResult): PublicReceiptStatus {
  if (!result.ok) {
    return result.outcome === "missing" || result.outcome === "rpc_failure" ? "pending_or_unavailable" : "invalid_or_inconsistent";
  }
  return result.receipt.status === "success" ? "verified" : "reverted";
}

function canonicalOf(result: ReceiptVerifyResult): { status: "success" | "reverted"; blockNumber: string; blockHash: string } | null {
  if (!result.ok || !isRpcVerifiedReceipt(result.receipt)) {
    return null;
  }
  return {
    status: result.receipt.status,
    blockNumber: result.receipt.blockNumber.toString(10),
    blockHash: result.receipt.blockHash,
  };
}

function settlementOf(statuses: readonly (string | null)[]): { kind: PublicReceiptCheck["settlement"]; note: string } {
  const known = statuses.filter((status): status is string => Boolean(status));
  if (known.length === 0) {
    return { kind: "not_settled", note: "No proposal settlement is recorded for this transaction. This page did not settle anything." };
  }
  const settled = known.filter((status) => status === "settled");
  if (settled.length === known.length) {
    return {
      kind: "stored_settlement",
      note: "The stored proposal status is settled. This page did not settle it, and a receipt check is not a settlement.",
    };
  }
  if (settled.length > 0) {
    return { kind: "disputed", note: "Stored proposal statuses disagree. This page did not change them." };
  }
  return { kind: "not_settled", note: "This is not an accounting settlement. The page did not settle the proposal." };
}

function groupEvidence(records: readonly RecordedEvidence[]): Map<string, RecordedEvidence[]> {
  const grouped = new Map<string, RecordedEvidence[]>();
  for (const record of records) {
    if (!HASH.test(record.txHash)) {
      continue;
    }
    const hash = record.txHash.toLowerCase();
    const list = grouped.get(hash) ?? [];
    list.push({ ...record, txHash: hash });
    grouped.set(hash, list);
  }
  return grouped;
}

function normalizeFocus(value: string | null | undefined): { kind: "absent" } | { kind: "malformed" } | { kind: "hash"; hash: string } {
  if (!value || !value.trim()) {
    return { kind: "absent" };
  }
  if (!HASH.test(value.trim())) {
    return { kind: "malformed" };
  }
  return { kind: "hash", hash: value.trim().toLowerCase() };
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

function takeRpcBudget(now: number, limit: number): boolean {
  while (rpcTimes.length > 0 && now - rpcTimes[0]! >= RPC_WINDOW_MS) {
    rpcTimes.shift();
  }
  if (rpcTimes.length >= limit) {
    return false;
  }
  rpcTimes.push(now);
  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
