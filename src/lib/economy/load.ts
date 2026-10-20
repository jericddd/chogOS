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

export async function loadEconomicOperations(): Promise<EconomyOperationsView> {
  await connection();
  const config = readAppConfig();
  const nowMs = Date.now();
  const client = openEconomyClient();
  const [snapshot, ledger] = await Promise.all([
    readConfiguredEconomicTreasury(config, nowMs),
    client ? readEconomyLedger(client, nowMs) : Promise.resolve(emptyLedger(LEDGER_UNCONFIGURED)),
  ]);
  return presentLoaded(snapshot, ledger, config);
}

function presentLoaded(
  snapshot: Awaited<ReturnType<typeof readConfiguredEconomicTreasury>>,
  ledger: EconomyLedger,
  config: ReturnType<typeof readAppConfig>,
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
  });
}
