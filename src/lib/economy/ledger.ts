import { parseRawAmount } from "@/lib/economy/amounts";
import type { EconomyActivityView, EconomyTransferView, StoredReceiptRecord } from "@/lib/economy/present";
import type { Hold, HoldBucket } from "@/lib/economy/reserve";
import { isRpcVerifiedReceipt, type RpcVerifiedReceipt } from "@/lib/economy/verify-receipt";

export type EconomyLedger = {
  complete: boolean;
  reason: string;
  holds: Hold[];
  reservedGasRaw: string;
  reservedDeploymentRaw: string;
  allocatedMonRaw: string;
  allocatedChogRaw: string;
  dailyGasRaw: string;
  activities: EconomyActivityView[];
  transfers: EconomyTransferView[];
};

const EMPTY = "0";

export const LEDGER_UNCONFIGURED =
  "The economic ledger is not configured on this server. Reserved and allocated amounts are not shown as zero.";
export const LEDGER_PENDING =
  "The Phase 7 economy tables are not in the database yet. Reserved and allocated amounts are not shown as zero.";
export const LEDGER_UNREAD =
  "The economic ledger could not be read. Reserved and allocated amounts are not shown as zero.";

export function emptyLedger(reason: string): EconomyLedger {
  return {
    complete: false,
    reason,
    holds: [],
    reservedGasRaw: EMPTY,
    reservedDeploymentRaw: EMPTY,
    allocatedMonRaw: EMPTY,
    allocatedChogRaw: EMPTY,
    dailyGasRaw: EMPTY,
    activities: [],
    transfers: [],
  };
}

export function utcDayStart(nowMs: number): string {
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function amount(value: unknown): bigint | null {
  return parseRawAmount(typeof value === "number" ? null : value);
}

/**
 * Turn the database snapshot into display and decision inputs.
 * A partial or malformed snapshot is incomplete, so callers do not treat it as zero.
 */
export function interpretLedgerSnapshot(value: unknown): EconomyLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyLedger(LEDGER_UNREAD);
  }
  const row = value as Record<string, unknown>;
  if (row.ok !== true || row.complete !== true) {
    const reason = text(row.reason) || LEDGER_UNREAD;
    return emptyLedger(reason);
  }
  const reservedGas = amount(row.reservedGas);
  const reservedDeployment = amount(row.reservedDeployment);
  const allocatedMon = amount(row.allocatedMon);
  const allocatedChog = amount(row.allocatedChog);
  const dailyGas = amount(row.dailyGas);
  if (
    reservedGas === null ||
    reservedDeployment === null ||
    allocatedMon === null ||
    allocatedChog === null ||
    dailyGas === null
  ) {
    return emptyLedger(LEDGER_UNREAD);
  }
  const holds = interpretHolds(row.holds);
  if (!holds.ok) {
    return emptyLedger(LEDGER_UNREAD);
  }
  return {
    complete: true,
    reason: "Reservation totals come from the loaded ledger. A reservation is not a payment, and it is not a broadcast.",
    holds: holds.holds,
    reservedGasRaw: reservedGas.toString(10),
    reservedDeploymentRaw: reservedDeployment.toString(10),
    allocatedMonRaw: allocatedMon.toString(10),
    allocatedChogRaw: allocatedChog.toString(10),
    dailyGasRaw: dailyGas.toString(10),
    activities: interpretActivities(row.proposals),
    transfers: interpretTransfers(row.transfers),
  };
}

function interpretHolds(value: unknown): { ok: true; holds: Hold[] } | { ok: false } {
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  const holds: Hold[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { ok: false };
    }
    const row = item as Record<string, unknown>;
    const asset = row.asset === "MON" || row.asset === "CHOG" ? row.asset : null;
    const bucket = bucketOf(row.bucket);
    const amountRaw = amount(row.amountRaw);
    const tokenId = text(row.tokenId);
    const key = text(row.key);
    if (!asset || !bucket || amountRaw === null || amountRaw <= 0n || !/^[0-9]+$/.test(tokenId) || !key || row.state !== "held") {
      return { ok: false };
    }
    if ((bucket === "gas" || bucket === "deployment") && asset !== "MON") {
      return { ok: false };
    }
    holds.push({
      id: text(row.id) || key,
      key,
      proposalId: text(row.proposalId),
      tokenId,
      asset,
      bucket,
      amountRaw,
      state: "held",
    });
  }
  return { ok: true, holds };
}

function bucketOf(value: unknown): HoldBucket | null {
  return value === "gas" || value === "deployment" || value === "business_capital" ? value : null;
}

function storedReceiptOf(row: Record<string, unknown>): StoredReceiptRecord | null {
  const chainRaw = row.receiptChainId;
  const chainId =
    typeof chainRaw === "number" && Number.isInteger(chainRaw)
      ? chainRaw
      : typeof chainRaw === "string" && /^[0-9]+$/.test(chainRaw)
        ? Number(chainRaw)
        : null;
  const status = text(row.receiptStatus) || null;
  const blockNumber = text(row.receiptBlockNumber);
  const blockHash = text(row.receiptBlockHash);
  const stored = {
    chainId,
    status: status && status.length <= 32 ? status : null,
    blockNumber: /^[0-9]+$/.test(blockNumber) ? blockNumber : null,
    blockHash: /^0x[0-9a-fA-F]{64}$/.test(blockHash) ? blockHash.toLowerCase() : null,
  };
  if (stored.chainId === null && !stored.status && !stored.blockNumber && !stored.blockHash) {
    return null;
  }
  return stored;
}

function interpretActivities(value: unknown): EconomyActivityView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const activities: EconomyActivityView[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = text(row.id);
    const status = text(row.status);
    if (!id || !status) {
      continue;
    }
    const storedHash = text(row.txHash);
    const txHash = /^0x[0-9a-fA-F]{64}$/.test(storedHash) ? storedHash.toLowerCase() : storedHash || null;
    activities.push({
      id,
      status,
      summary: text(row.objective) || "Economic proposal",
      reason: text(row.reason) || "Stored proposal. It is not itself a transfer.",
      simulated: true,
      txHash,
      chainVerified: false,
      storedReceipt: storedReceiptOf(row),
    });
  }
  return activities;
}

function interpretTransfers(value: unknown): EconomyTransferView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const transfers: EconomyTransferView[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const amountRaw = amount(row.amountRaw);
    const asset = row.asset === "MON" || row.asset === "CHOG" ? row.asset : null;
    const status = text(row.status);
    if (!asset || amountRaw === null || (status !== "observed" && status !== "realized")) {
      continue;
    }
    if (row.kind === "receipt_observed") {
      continue;
    }
    const evidenceKey = text(row.evidenceKey);
    const matched = /^143:(0x[0-9a-fA-F]{64}):/i.exec(evidenceKey);
    transfers.push({
      id: text(row.id) || evidenceKey || `${asset}:${amountRaw.toString(10)}`,
      direction: row.side === "credit" ? "out" : "in",
      asset,
      amountRaw: amountRaw.toString(10),
      decimals: asset === "MON" ? 18 : null,
      txHash: matched ? matched[1]!.toLowerCase() : null,
      chainVerified: false,
      status,
    });
  }
  return transfers;
}

/**
 * Mark rows only when this call already holds a receipt from verifyMainnetReceipt.
 * Stored columns and evidence-key text stay unverified when that receipt is absent.
 */
export function applyRpcVerification(ledger: EconomyLedger, verified: RpcVerifiedReceipt | null): EconomyLedger {
  if (!isRpcVerifiedReceipt(verified)) {
    return {
      ...ledger,
      activities: ledger.activities.map((activity) => ({ ...activity, chainVerified: false, simulated: true })),
      transfers: ledger.transfers.map((transfer) => ({ ...transfer, chainVerified: false })),
    };
  }
  return {
    ...ledger,
    activities: ledger.activities.map((activity) => {
      const matches = activity.txHash?.toLowerCase() === verified.txHash.toLowerCase();
      const statusOk =
        (verified.status === "success" && (activity.status === "confirmed" || activity.status === "settled")) ||
        (verified.status === "reverted" && activity.status === "reverted");
      const chainVerified = Boolean(matches && statusOk);
      return { ...activity, chainVerified, simulated: !chainVerified };
    }),
    transfers: ledger.transfers.map((transfer) => ({
      ...transfer,
      chainVerified:
        transfer.status === "observed" &&
        verified.status === "success" &&
        transfer.txHash?.toLowerCase() === verified.txHash.toLowerCase(),
    })),
  };
}
