import { explorerTxUrl } from "@/lib/blockchain/explorer";
import type { ProductionExecution } from "@/lib/economy/execution";
import type { TreasurySnapshot, TreasuryStatus } from "@/lib/economy/observe";
import type { PublicReceiptCheck } from "@/lib/economy/public-verification";
import { formatTokenAmount } from "@/lib/wallets/present";

export type StoredReceiptRecord = {
  chainId: number | null;
  status: string | null;
  blockNumber: string | null;
  blockHash: string | null;
};

export type EconomyActivityView = {
  id: string;
  status: string;
  summary: string;
  reason: string;
  simulated: boolean;
  txHash: string | null;
  chainVerified: boolean;
  /** Stored columns. They are not a fresh mainnet check. */
  storedReceipt?: StoredReceiptRecord | null;
};

export type EconomyTransferView = {
  id: string;
  direction: "in" | "out";
  asset: "MON" | "CHOG";
  amountRaw: string;
  decimals: number | null;
  txHash: string | null;
  chainVerified: boolean;
  status: string;
};

export type EconomyOperationsView = {
  status: TreasuryStatus;
  statusLabel: string;
  chainLabel: string;
  address: string | null;
  addressNote: string;
  observedAt: string | null;
  blockNumber: string | null;
  monText: string;
  chogText: string;
  freshness: string;
  reservedGas: string;
  reservedDeployment: string;
  allocatedMon: string;
  allocatedChog: string;
  unallocatedMon: string;
  unallocatedChog: string;
  gasExposure: string;
  budgetNote: string;
  allowlist: string;
  execution: string;
  executionDetail: string;
  activities: Array<EconomyActivityView & { href: string | null }>;
  activityNote: string;
  transfers: Array<EconomyTransferView & { amountText: string; href: string | null }>;
  transferNote: string;
  receiptChecks: PublicReceiptCheck[];
  receiptNote: string;
  receiptFocusNote: string | null;
  blocked: string[];
  ledgerNote: string;
};

const STATUS_LABEL: Record<TreasuryStatus, string> = {
  not_configured: "Not configured",
  observed: "Observed",
  stale: "Stale",
  unavailable: "Unavailable",
  wrong_chain: "Wrong chain",
  malformed: "Malformed",
  timed_out: "Timed out",
};

export function presentEconomy(input: {
  snapshot: TreasurySnapshot;
  execution: ProductionExecution;
  allowlistReason: string;
  ledgerLoaded: boolean;
  ledgerDetail?: string | null;
  reservedGasRaw?: string | null;
  reservedDeploymentRaw?: string | null;
  allocatedMonRaw?: string | null;
  allocatedChogRaw?: string | null;
  dailyGasRaw?: string | null;
  dailyGasLimitRaw?: string | null;
  activities?: EconomyActivityView[];
  transfers?: EconomyTransferView[];
  receiptChecks?: PublicReceiptCheck[];
  receiptNote?: string;
  receiptFocusNote?: string | null;
}): EconomyOperationsView {
  const snapshot = input.snapshot;
  const monDecimals = snapshot.mon.decimals;
  const chogDecimals = snapshot.chog.decimals;
  const activities = (input.activities ?? []).map((activity) => ({
    ...activity,
    href: activity.simulated || !activity.chainVerified ? null : explorerTxUrl(143, activity.txHash),
  }));
  const transfers = (input.transfers ?? []).map((transfer) => ({
    ...transfer,
    amountText: showAmount(transfer.amountRaw, transfer.decimals, transfer.asset),
    href: transfer.chainVerified && transfer.status === "observed" ? explorerTxUrl(143, transfer.txHash) : null,
  }));
  const blocked = [
    input.execution.reason,
    snapshot.status === "observed" ? "" : snapshot.reason,
    input.allowlistReason,
  ].filter((line, index, all) => line && all.indexOf(line) === index);

  return {
    status: snapshot.status,
    statusLabel: STATUS_LABEL[snapshot.status],
    chainLabel: snapshot.observedChainId && snapshot.observedChainId !== 143
      ? `Required Monad mainnet 143. Last read reported chain ${snapshot.observedChainId}.`
      : "Monad mainnet 143",
    address: snapshot.address,
    addressNote: snapshot.address
      ? "This public address is the economic treasury. It is a different address from the Civilization Treasury record and from the ChogTreasury NFT wallet."
      : "Set CHOG_BANK_ASSET_ADDRESS to a public economic treasury. The ChogTreasury NFT wallet is not used in its place.",
    observedAt: snapshot.observedAt,
    blockNumber: snapshot.blockNumber === null ? null : snapshot.blockNumber.toString(10),
    monText: showAmount(snapshot.mon.raw === null ? null : snapshot.mon.raw.toString(10), monDecimals, "MON"),
    chogText: showAmount(snapshot.chog.raw === null ? null : snapshot.chog.raw.toString(10), chogDecimals, "$CHOG"),
    freshness: snapshot.reason,
    reservedGas: heldText(input.ledgerLoaded, input.reservedGasRaw, monDecimals, "MON"),
    reservedDeployment: heldText(input.ledgerLoaded, input.reservedDeploymentRaw, monDecimals, "MON"),
    allocatedMon: heldText(input.ledgerLoaded, input.allocatedMonRaw, monDecimals, "MON"),
    allocatedChog: heldText(input.ledgerLoaded, input.allocatedChogRaw, chogDecimals, "$CHOG"),
    unallocatedMon: snapshot.unallocatedMon === null ? "Not available" : showAmount(snapshot.unallocatedMon.toString(10), monDecimals ?? 18, "MON"),
    unallocatedChog: snapshot.unallocatedChog === null ? "Not available" : showAmount(snapshot.unallocatedChog.toString(10), chogDecimals, "$CHOG"),
    gasExposure: input.ledgerLoaded
      ? `${showAmount(input.dailyGasRaw ?? null, 18, "MON")} of ${showAmount(input.dailyGasLimitRaw ?? null, 18, "MON")} daily gas`
      : "Not loaded",
    budgetNote: "Limits are integer base units. $CHOG and MON are not converted into each other.",
    allowlist: input.allowlistReason,
    execution: input.execution.enabled ? "Enabled" : "Disabled",
    executionDetail: input.execution.reason,
    activities,
    activityNote: activities.length === 0
      ? "No economic proposal is loaded on this page. A proposal is not a completed transaction."
      : "Proposals stay separate from confirmed transfers.",
    transfers,
    transferNote: transfers.length === 0
      ? "No realized incoming or outgoing transfer is loaded. An unread ledger is not a zero balance. A receipt_observed journal link is not a transfer."
      : "Counted journal lines stay separate from a fresh receipt check. Explorer links appear only for transfers with verified mainnet evidence.",
    receiptChecks: input.receiptChecks ?? [],
    receiptNote: input.receiptNote ?? "No recorded economy receipt is loaded. This page does not invent a transaction.",
    receiptFocusNote: input.receiptFocusNote ?? null,
    blocked,
    ledgerNote: input.ledgerLoaded
      ? "Reservation totals come from the loaded ledger. A reservation is not a payment, and it is not a broadcast."
      : input.ledgerDetail || "The economic ledger was not queried for this page. Reserved and allocated amounts are not shown as zero.",
  };
}

function heldText(loaded: boolean, raw: string | null | undefined, decimals: number | null, symbol: string): string {
  if (!loaded) {
    return "Not loaded";
  }
  return showAmount(raw ?? null, decimals, symbol);
}

function showAmount(raw: string | null, decimals: number | null, symbol: string): string {
  if (raw === null || decimals === null) {
    return "Not read";
  }
  return formatTokenAmount(raw, decimals, symbol);
}
