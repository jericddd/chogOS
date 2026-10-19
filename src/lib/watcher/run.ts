import { getAddress } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import type { AppConfig } from "@/lib/config/env";
import { runDurableScan, type Sql } from "@/lib/watcher/durable";
import type { LogSource } from "@/lib/watcher/types";

export type WatcherRunResult = {
  exitCode: number;
  message: string;
  scanned: boolean;
};

export function planWatcherRun(config: Pick<AppConfig, "chogWatcherEnabled" | "chainId" | "rpcUrl" | "supabaseUrl" | "supabaseServiceRoleKey" | "chogNftAddress">):
  | { action: "skip"; exitCode: 0; message: string }
  | { action: "stop"; exitCode: 1; message: string }
  | { action: "scan" } {
  if (!config.chogWatcherEnabled) {
    return {
      action: "skip",
      exitCode: 0,
      message: "CHOG_WATCHER_ENABLED is not true. The watcher stays off and does not read the chain.",
    };
  }
  if (config.chainId !== 143) {
    return { action: "stop", exitCode: 1, message: "watcher refuses a chain other than Monad mainnet 143" };
  }
  if (getAddress(config.chogNftAddress) !== getAddress(addresses.chogGenesis)) {
    return { action: "stop", exitCode: 1, message: "watcher only follows the Chog Genesis contract" };
  }
  if (!config.rpcUrl) {
    return { action: "stop", exitCode: 1, message: "MONAD_RPC_URL is required before the watcher can read chain 143" };
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return {
      action: "stop",
      exitCode: 1,
      message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required before the watcher can persist a cursor",
    };
  }
  return { action: "scan" };
}

/**
 * Opens the database and the RPC only when the plan is an explicit scan.
 * Disabled, wrong-chain, and unconfigured runs do not call `open`.
 */
export async function executeWatcher(input: {
  config: AppConfig;
  now?: string;
  open: () => Promise<{ sql: Sql; source: LogSource }>;
}): Promise<WatcherRunResult> {
  const plan = planWatcherRun(input.config);
  if (plan.action !== "scan") {
    return { exitCode: plan.exitCode, message: plan.message, scanned: false };
  }
  let opened: { sql: Sql; source: LogSource };
  try {
    opened = await input.open();
  } catch (error) {
    return {
      exitCode: 1,
      message: error instanceof Error ? error.message : "watcher could not open its database",
      scanned: false,
    };
  }
  const result = await runDurableScan({
    sql: opened.sql,
    source: opened.source,
    nftContract: input.config.chogNftAddress,
    now: input.now ?? new Date().toISOString(),
    backfillFrom: input.config.chogWatcherBackfillFrom,
    maxLagBlocks: BigInt(input.config.chogWatcherMaxLagBlocks),
    maxStaleMs: input.config.chogWatcherMaxStaleMs,
    scan: {
      rangeBlocks: BigInt(input.config.chogWatcherRangeBlocks),
      maxBlocks: BigInt(input.config.chogWatcherMaxBlocksPerRun),
      maxLogsPerRange: input.config.chogWatcherMaxLogsPerRange,
      maxAttempts: input.config.chogWatcherRpcAttempts,
      retryMs: input.config.chogWatcherRpcRetryMs,
      pauseMs: input.config.chogWatcherRpcPauseMs,
    },
  });
  return {
    exitCode: result.report.ok ? 0 : 1,
    scanned: result.scanned,
    message: JSON.stringify({
      ok: result.report.ok,
      reason: result.report.ok ? null : result.report.reason,
      caughtUp: result.report.ok ? result.report.caughtUp : false,
      ranges: result.report.ok ? result.report.ranges : 0,
      fromBlock: result.report.ok ? result.report.fromBlock.toString() : null,
      toBlock: result.report.ok ? result.report.toBlock.toString() : null,
      status: result.health.status,
      executionAllowed: result.health.executionAllowed,
      sponsorshipAllowed: result.health.sponsorshipAllowed,
      cursorBlock: result.health.cursorBlock?.toString() ?? null,
      tipBlock: result.health.tipBlock?.toString() ?? null,
      lagBlocks: result.health.lagBlocks?.toString() ?? null,
      lastError: result.health.lastError,
      lastSuccessAt: result.health.lastSuccessAt,
      pendingInvalidations: result.health.pendingInvalidations,
      failedInvalidations: result.health.failedInvalidations,
    }),
  };
}

/**
 * One-shot by default. A loop stops on the first failed scan so a supervisor can restart it.
 * A disabled watcher returns before `run` is called.
 */
export async function startWatcher(input: {
  config: Pick<AppConfig, "chogWatcherEnabled" | "chogWatcherIntervalSeconds">;
  loop: boolean;
  maxRuns?: number;
  run: () => Promise<WatcherRunResult>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<{ exitCode: number; runs: number }> {
  if (!input.config.chogWatcherEnabled) {
    input.log?.("CHOG_WATCHER_ENABLED is not true. The watcher stays off and does not read the chain.");
    return { exitCode: 0, runs: 0 };
  }
  const limit = input.maxRuns ?? Number.POSITIVE_INFINITY;
  let runs = 0;
  let exitCode = 1;
  while (runs < limit) {
    const result = await input.run();
    runs += 1;
    exitCode = result.exitCode;
    input.log?.(result.message);
    if (!input.loop || result.exitCode !== 0) {
      return { exitCode, runs };
    }
    if (runs >= limit) {
      break;
    }
    await input.sleep?.(input.config.chogWatcherIntervalSeconds * 1000);
  }
  return { exitCode, runs };
}
