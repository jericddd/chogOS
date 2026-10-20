import "server-only";
import { connection } from "next/server";
import { readAppConfig } from "@/lib/config/env";
import { parseProtocolAllowlist } from "@/lib/economy/allowlist";
import { openEconomyClient, readEconomyLedger } from "@/lib/economy/db";
import { productionExecutionStatus } from "@/lib/economy/execution";
import { emptyLedger, LEDGER_UNCONFIGURED, type EconomyLedger } from "@/lib/economy/ledger";
import { withLedgerReservations } from "@/lib/economy/observe";
import { presentEconomy, type EconomyOperationsView } from "@/lib/economy/present";
import { readConfiguredEconomicTreasury } from "@/lib/economy/production";
import { recheckRecordedReceipts, type RecordedEvidence } from "@/lib/economy/public-verification";
import { jsonRpcCaller } from "@/lib/economy/verify-receipt";

const HASH = /^0x[0-9a-fA-F]{64}$/;

export async function loadEconomicOperations(focusTx?: string | null): Promise<EconomyOperationsView> {
  await connection();
  const config = readAppConfig();
  const nowMs = Date.now();
  const client = openEconomyClient();
  const [snapshot, ledger] = await Promise.all([
    readConfiguredEconomicTreasury(config, nowMs),
    client ? readEconomyLedger(client, nowMs) : Promise.resolve(emptyLedger(LEDGER_UNCONFIGURED)),
  ]);
  const receipts = await recheckRecordedReceipts({
    records: recordedEvidence(ledger),
    call: jsonRpcCaller(config.rpcUrl),
    treasury: config.chogBankAssetAddress ?? null,
    nowMs,
    focusTx,
  });
  return presentLoaded(snapshot, ledger, config, receipts);
}

function recordedEvidence(ledger: EconomyLedger): RecordedEvidence[] {
  const records: RecordedEvidence[] = [];
  for (const activity of ledger.activities) {
    if (!activity.txHash || !HASH.test(activity.txHash)) {
      continue;
    }
    records.push({
      txHash: activity.txHash.toLowerCase(),
      proposalStatus: activity.status,
      stored: activity.storedReceipt ?? null,
    });
  }
  for (const transfer of ledger.transfers) {
    if (!transfer.txHash || !HASH.test(transfer.txHash)) {
      continue;
    }
    records.push({ txHash: transfer.txHash.toLowerCase(), proposalStatus: null, stored: null });
  }
  return records;
}

function presentLoaded(
  snapshot: Awaited<ReturnType<typeof readConfiguredEconomicTreasury>>,
  ledger: EconomyLedger,
  config: ReturnType<typeof readAppConfig>,
  receipts: { checks: EconomyOperationsView["receiptChecks"]; note: string; focusNote: string | null },
): EconomyOperationsView {
  const viewed = withLedgerReservations(
    snapshot,
    ledger.complete
      ? {
          reservedGasWei: BigInt(ledger.reservedGasRaw),
          reservedDeploymentWei: BigInt(ledger.reservedDeploymentRaw),
          allocatedMon: BigInt(ledger.allocatedMonRaw),
          allocatedChog: BigInt(ledger.allocatedChogRaw),
        }
      : null,
  );
  return presentEconomy({
    snapshot: viewed,
    execution: productionExecutionStatus(),
    allowlistReason: parseProtocolAllowlist(config.economyAllowlist).reason,
    ledgerLoaded: ledger.complete,
    ledgerDetail: ledger.complete ? null : ledger.reason,
    reservedGasRaw: ledger.reservedGasRaw,
    reservedDeploymentRaw: ledger.reservedDeploymentRaw,
    allocatedMonRaw: ledger.allocatedMonRaw,
    allocatedChogRaw: ledger.allocatedChogRaw,
    dailyGasRaw: ledger.dailyGasRaw,
    dailyGasLimitRaw: config.chogBankLimits.maxDailyGasWei.toString(10),
    activities: ledger.activities,
    transfers: ledger.transfers.map((transfer) => ({
      ...transfer,
      decimals: transfer.asset === "CHOG" ? viewed.chog.decimals : transfer.decimals,
    })),
    receiptChecks: receipts.checks,
    receiptNote: receipts.note,
    receiptFocusNote: receipts.focusNote,
  });
}

export async function loadPublicReceipt(tx: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!tx || !HASH.test(tx.trim())) {
    return {
      status: 400,
      body: { ok: false, status: "invalid_or_inconsistent", fresh: false, cached: false, reason: "The transaction hash is malformed." },
    };
  }
  await connection();
  const config = readAppConfig();
  const client = openEconomyClient();
  if (!client) {
    return {
      status: 503,
      body: { ok: false, status: "pending_or_unavailable", fresh: false, cached: false, reason: LEDGER_UNCONFIGURED },
    };
  }
  const ledger = await readEconomyLedger(client, Date.now());
  if (!ledger.complete) {
    return {
      status: 503,
      body: { ok: false, status: "pending_or_unavailable", fresh: false, cached: false, reason: ledger.reason },
    };
  }
  const records = recordedEvidence(ledger).filter((record) => record.txHash === tx.trim().toLowerCase());
  if (records.length === 0) {
    return {
      status: 404,
      body: { ok: false, fresh: false, cached: false, reason: "That transaction is not recorded economy evidence." },
    };
  }
  const batch = await recheckRecordedReceipts({
    records,
    call: jsonRpcCaller(config.rpcUrl),
    treasury: config.chogBankAssetAddress ?? null,
    focusTx: tx,
    limit: 1,
  });
  const check = batch.checks[0];
  if (!check) {
    return {
      status: 404,
      body: { ok: false, fresh: false, cached: false, reason: batch.focusNote ?? "That transaction is not recorded economy evidence." },
    };
  }
  return { status: 200, body: { ok: true, ...check } };
}
