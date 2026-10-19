import { getAddress, type Address } from "viem";
import { z } from "zod";
import { addresses } from "@/lib/blockchain/addresses";

export type AiProviderId = "none" | "openai" | "anthropic" | "ajax" | "gemini";
export type NftIndexerId = "none" | "alchemy" | "custom";

export type AppConfig = {
  chainId: 143 | 10143;
  rpcUrl?: string;
  chogNftAddress: Address;
  chogTokenAddress: Address;
  chogTreasuryAddress: Address;
  /** Comparison figure only. Holdings come from the chain, not from this number. */
  expectedFoundingCount: number;
  ipfsGateway: string;
  nftIndexer: NftIndexerId;
  nftIndexerApiKey?: string;
  nftIndexerUrl?: string;
  syncSecret?: string;
  /** Server-only. Required before the treasury address or a funding hash can be submitted. */
  treasuryAdminSecret?: string;
  /** Server-only. Required by POST /api/world/tick. pg_cron does not need it. */
  worldRunnerSecret?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  aiProvider: AiProviderId;
  aiApiKey?: string;
  aiModel?: string;
  aiBaseUrl?: string;
  /** Server-only. POST /api/ai/run stays closed until this or cronSecret is set. */
  aiRunnerSecret?: string;
  /** Server-only. Vercel Cron sends this as Authorization: Bearer <CRON_SECRET>. */
  cronSecret?: string;
  /** Explicit enable. Credentials alone do not start the mind. */
  aiRunnerEnabled: boolean;
  aiDecisionsPerRun: number;
  aiMinDecisionIntervalSeconds: number;
  aiMaxDecisionsPerHour: number;
  aiMaxDecisionsPerDay: number;
  aiMaxPromptChars: number;
  aiMaxOutputTokens: number;
  aiRequestTimeoutMs: number;
  /** Optional. Displayed as the intended EventAnchor contract. Unset means not deployed. */
  eventAnchorAddress?: Address;
  eventAnchorChainId?: 143 | 10143;
  /** Predicted factory address is not deployment. Unset means the factory is not configured. */
  citizenAccountFactoryAddress?: Address;
  /** Explicit observed-code flag. A predicted CREATE2 address does not set this. */
  citizenAccountFactoryCodeVerified: boolean;
  /** Operator intent only. The relayer still refuses without a signer backend. */
  chogBankRelayerEnabled: boolean;
  chogBankLimits: {
    maxActivationWei: bigint;
    maxTxWei: bigint;
    maxDailyGasWei: bigint;
    maxTreasuryExposureWei: bigint;
  };
  /** Explicit enable. Does not start a scan inside world_tick or on boot. */
  chogWatcherEnabled: boolean;
  chogWatcherMaxLagBlocks: number;
  chogWatcherIntervalSeconds: number;
  chogWatcherMaxStaleMs: number;
  /** First scan start when the cursor is empty. Unset does not imply block zero. */
  chogWatcherBackfillFrom: bigint | null;
  /** Public gas-paying address. Not a private key and not the asset-control treasury. */
  chogBankGasAddress?: Address;
  /** Public asset-control address. Must differ from the gas-paying address. */
  chogBankAssetAddress?: Address;
  chogBankObservationMaxAgeMs: number;
};

const DEFAULT_IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs";

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireAddress(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Invalid ${label}. Expected a 20-byte hexadecimal address.`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function optionalHttpsUrl(
  value: string | undefined,
  label: string,
  options?: { allowLoopbackHttp?: boolean },
): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = z.url().safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}. Expected an https URL.`);
  }

  let url: URL;
  try {
    url = new URL(parsed.data);
  } catch {
    throw new Error(`Invalid ${label}. Expected an https URL.`);
  }

  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(options?.allowLoopbackHttp && loopbackHttp)) {
    throw new Error(`Invalid ${label}. Expected an https URL.`);
  }

  return url.toString().replace(/\/$/, "");
}

function readBoundedInt(
  value: string | undefined,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = blankToUndefined(value);
  if (!raw) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid ${label}. Use a non-negative integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}. Use an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function readWei(value: string | undefined, label: string, fallback: bigint): bigint {
  const raw = blankToUndefined(value);
  if (!raw) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid ${label}. Use a non-negative integer in wei.`);
  }
  return BigInt(raw);
}

function readOptionalInteger(value: string | undefined, label: string): bigint | null {
  const raw = blankToUndefined(value);
  if (!raw) {
    return null;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid ${label}. Use a non-negative integer.`);
  }
  return BigInt(raw);
}

function optionalAddress(value: string | undefined, label: string): Address | undefined {
  const raw = blankToUndefined(value);
  return raw ? requireAddress(raw, label) : undefined;
}

function readExpectedCount(value: string | undefined): number {
  const raw = blankToUndefined(value) ?? "59";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      "Invalid EXPECTED_FOUNDING_COUNT. Use a non-negative integer. It is only a comparison figure.",
    );
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    throw new Error("Invalid EXPECTED_FOUNDING_COUNT. The comparison figure is too large.");
  }
  return count;
}

/**
 * Read deployment configuration. This does not connect to a network.
 * Callers that hold secrets must stay in server modules.
 */
export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const chainRaw = blankToUndefined(env.MONAD_CHAIN_ID) ?? "143";
  if (chainRaw !== "143" && chainRaw !== "10143") {
    throw new Error("Invalid MONAD_CHAIN_ID. Use 143 for mainnet or 10143 for testnet.");
  }

  const aiProvider = blankToUndefined(env.AI_PROVIDER) ?? "none";
  if (
    aiProvider !== "none" &&
    aiProvider !== "openai" &&
    aiProvider !== "anthropic" &&
    aiProvider !== "ajax" &&
    aiProvider !== "gemini"
  ) {
    throw new Error("Invalid AI_PROVIDER. Use none, gemini, openai, anthropic, or ajax.");
  }

  const nftIndexer = blankToUndefined(env.NFT_INDEXER) ?? "none";
  if (nftIndexer !== "none" && nftIndexer !== "alchemy" && nftIndexer !== "custom") {
    throw new Error("Invalid NFT_INDEXER. Use none, alchemy, or custom.");
  }

  const chogBankGasAddress = optionalAddress(env.CHOG_BANK_GAS_ADDRESS, "CHOG_BANK_GAS_ADDRESS");
  const chogBankAssetAddress = optionalAddress(env.CHOG_BANK_ASSET_ADDRESS, "CHOG_BANK_ASSET_ADDRESS");
  if (
    chogBankGasAddress &&
    chogBankAssetAddress &&
    chogBankGasAddress.toLowerCase() === chogBankAssetAddress.toLowerCase()
  ) {
    throw new Error(
      "CHOG_BANK_GAS_ADDRESS must differ from CHOG_BANK_ASSET_ADDRESS. Gas-paying funds stay separate from treasury assets.",
    );
  }

  return {
    chainId: chainRaw === "143" ? 143 : 10143,
    rpcUrl: optionalHttpsUrl(blankToUndefined(env.MONAD_RPC_URL), "MONAD_RPC_URL"),
    chogNftAddress: requireAddress(
      blankToUndefined(env.CHOG_NFT_ADDRESS) ?? addresses.chogGenesis,
      "CHOG_NFT_ADDRESS",
    ),
    chogTokenAddress: requireAddress(
      blankToUndefined(env.CHOG_TOKEN_ADDRESS) ?? addresses.chogToken,
      "CHOG_TOKEN_ADDRESS",
    ),
    chogTreasuryAddress: requireAddress(
      blankToUndefined(env.CHOG_TREASURY_ADDRESS) ?? addresses.chogTreasury,
      "CHOG_TREASURY_ADDRESS",
    ),
    expectedFoundingCount: readExpectedCount(env.EXPECTED_FOUNDING_COUNT),
    ipfsGateway:
      optionalHttpsUrl(blankToUndefined(env.IPFS_GATEWAY), "IPFS_GATEWAY") ?? DEFAULT_IPFS_GATEWAY,
    nftIndexer,
    nftIndexerApiKey: blankToUndefined(env.NFT_INDEXER_API_KEY),
    nftIndexerUrl: optionalHttpsUrl(blankToUndefined(env.NFT_INDEXER_URL), "NFT_INDEXER_URL"),
    syncSecret: blankToUndefined(env.SYNC_SECRET),
    treasuryAdminSecret: blankToUndefined(env.TREASURY_ADMIN_SECRET),
    worldRunnerSecret: blankToUndefined(env.WORLD_RUNNER_SECRET),
    supabaseUrl: optionalHttpsUrl(blankToUndefined(env.SUPABASE_URL), "SUPABASE_URL", {
      allowLoopbackHttp: true,
    }),
    supabaseAnonKey: blankToUndefined(env.SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: blankToUndefined(env.SUPABASE_SERVICE_ROLE_KEY),
    aiProvider,
    aiApiKey: blankToUndefined(env.AI_API_KEY) ?? blankToUndefined(env.GEMINI_API_KEY),
    aiModel:
      blankToUndefined(env.AI_MODEL) ?? (aiProvider === "gemini" ? "gemini-3.8-flash" : undefined),
    aiBaseUrl: optionalHttpsUrl(blankToUndefined(env.AI_BASE_URL), "AI_BASE_URL"),
    aiRunnerSecret: blankToUndefined(env.AI_RUNNER_SECRET),
    cronSecret: blankToUndefined(env.CRON_SECRET),
    aiRunnerEnabled: blankToUndefined(env.AI_RUNNER_ENABLED) === "true",
    aiDecisionsPerRun: readBoundedInt(env.AI_DECISIONS_PER_RUN, "AI_DECISIONS_PER_RUN", 1, 1, 8),
    aiMinDecisionIntervalSeconds: readBoundedInt(
      env.AI_MIN_DECISION_INTERVAL_SECONDS,
      "AI_MIN_DECISION_INTERVAL_SECONDS",
      1800,
      60,
      86_400,
    ),
    aiMaxDecisionsPerHour: readBoundedInt(env.AI_MAX_DECISIONS_PER_HOUR, "AI_MAX_DECISIONS_PER_HOUR", 12, 1, 500),
    aiMaxDecisionsPerDay: readBoundedInt(env.AI_MAX_DECISIONS_PER_DAY, "AI_MAX_DECISIONS_PER_DAY", 48, 1, 2000),
    aiMaxPromptChars: readBoundedInt(env.AI_MAX_PROMPT_CHARS, "AI_MAX_PROMPT_CHARS", 8000, 500, 32_000),
    aiMaxOutputTokens: readBoundedInt(env.AI_MAX_OUTPUT_TOKENS, "AI_MAX_OUTPUT_TOKENS", 2048, 64, 4096),
    aiRequestTimeoutMs: readBoundedInt(env.AI_REQUEST_TIMEOUT_MS, "AI_REQUEST_TIMEOUT_MS", 40_000, 1000, 120_000),
    eventAnchorAddress: (() => {
      const raw = blankToUndefined(env.EVENT_ANCHOR_ADDRESS);
      return raw ? requireAddress(raw, "EVENT_ANCHOR_ADDRESS") : undefined;
    })(),
    eventAnchorChainId: (() => {
      const raw = blankToUndefined(env.EVENT_ANCHOR_CHAIN_ID);
      if (!raw) {
        return undefined;
      }
      if (raw !== "143" && raw !== "10143") {
        throw new Error("Invalid EVENT_ANCHOR_CHAIN_ID. Use 143 or 10143.");
      }
      return raw === "143" ? 143 : 10143;
    })(),
    citizenAccountFactoryAddress: (() => {
      const raw = blankToUndefined(env.CITIZEN_ACCOUNT_FACTORY_ADDRESS);
      return raw ? requireAddress(raw, "CITIZEN_ACCOUNT_FACTORY_ADDRESS") : undefined;
    })(),
    citizenAccountFactoryCodeVerified: blankToUndefined(env.CITIZEN_ACCOUNT_FACTORY_CODE_VERIFIED) === "true",
    chogBankRelayerEnabled: blankToUndefined(env.CHOG_BANK_RELAYER_ENABLED) === "true",
    chogBankLimits: {
      maxActivationWei: readWei(
        env.CHOG_BANK_MAX_ACTIVATION_WEI,
        "CHOG_BANK_MAX_ACTIVATION_WEI",
        500_000_000_000_000_000n,
      ),
      maxTxWei: readWei(env.CHOG_BANK_MAX_TX_WEI, "CHOG_BANK_MAX_TX_WEI", 100_000_000_000_000_000n),
      maxDailyGasWei: readWei(
        env.CHOG_BANK_MAX_DAILY_GAS_WEI,
        "CHOG_BANK_MAX_DAILY_GAS_WEI",
        1_000_000_000_000_000_000n,
      ),
      maxTreasuryExposureWei: readWei(
        env.CHOG_BANK_MAX_TREASURY_EXPOSURE_WEI,
        "CHOG_BANK_MAX_TREASURY_EXPOSURE_WEI",
        5_000_000_000_000_000_000n,
      ),
    },
    chogWatcherEnabled: blankToUndefined(env.CHOG_WATCHER_ENABLED) === "true",
    chogWatcherMaxLagBlocks: readBoundedInt(env.CHOG_WATCHER_MAX_LAG_BLOCKS, "CHOG_WATCHER_MAX_LAG_BLOCKS", 20, 0, 10_000),
    chogWatcherIntervalSeconds: readBoundedInt(env.CHOG_WATCHER_SECONDS, "CHOG_WATCHER_SECONDS", 60, 15, 86_400),
    chogWatcherMaxStaleMs: readBoundedInt(env.CHOG_WATCHER_MAX_STALE_MS, "CHOG_WATCHER_MAX_STALE_MS", 120_000, 1_000, 3_600_000),
    chogWatcherBackfillFrom: readOptionalInteger(env.CHOG_WATCHER_BACKFILL_FROM, "CHOG_WATCHER_BACKFILL_FROM"),
    chogBankGasAddress,
    chogBankAssetAddress,
    chogBankObservationMaxAgeMs: readBoundedInt(
      env.CHOG_BANK_OBSERVATION_MAX_AGE_MS,
      "CHOG_BANK_OBSERVATION_MAX_AGE_MS",
      120_000,
      1_000,
      3_600_000,
    ),
  };
}

/** Public header copy. Never includes keys or that a model call is in flight. */
export function aiStatusLabel(config: AppConfig): string {
  if (config.aiProvider === "ajax") {
    return "Awaiting AI activation. Ajax has no verified endpoint.";
  }
  if (config.aiProvider !== "none" && config.aiRunnerEnabled) {
    return config.aiProvider === "gemini" ? "AI mind on Gemini" : `AI mind on ${config.aiProvider}`;
  }
  if (config.aiProvider !== "none") {
    return `${config.aiProvider} configured · runner off`;
  }
  return "Awaiting AI activation";
}
