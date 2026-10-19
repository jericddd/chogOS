import "server-only";
import { connection } from "next/server";
import { readAppConfig } from "@/lib/config/env";
import { parseProtocolAllowlist } from "@/lib/economy/allowlist";
import { productionExecutionStatus } from "@/lib/economy/execution";
import { presentEconomy, type EconomyOperationsView } from "@/lib/economy/present";
import { readConfiguredEconomicTreasury } from "@/lib/economy/production";

export async function loadEconomicOperations(): Promise<EconomyOperationsView> {
  await connection();
  const config = readAppConfig();
  const nowMs = Date.now();
  const snapshot = await readConfiguredEconomicTreasury(config, nowMs);
  const allowlist = parseProtocolAllowlist(config.economyAllowlist);
  return presentEconomy({
    snapshot,
    execution: productionExecutionStatus(),
    allowlistReason: allowlist.reason,
    ledgerLoaded: false,
    dailyGasLimitRaw: config.chogBankLimits.maxDailyGasWei.toString(10),
  });
}
