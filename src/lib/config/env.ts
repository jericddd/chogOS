import { getAddress, type Address } from "viem";
import { z } from "zod";
import { addresses } from "@/lib/blockchain/addresses";

export type AiProviderId = "none" | "openai" | "anthropic" | "ajax";
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
  if (aiProvider !== "none" && aiProvider !== "openai" && aiProvider !== "anthropic" && aiProvider !== "ajax") {
    throw new Error("Invalid AI_PROVIDER. Use none, openai, anthropic, or ajax.");
  }

  const nftIndexer = blankToUndefined(env.NFT_INDEXER) ?? "none";
  if (nftIndexer !== "none" && nftIndexer !== "alchemy" && nftIndexer !== "custom") {
    throw new Error("Invalid NFT_INDEXER. Use none, alchemy, or custom.");
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
    aiApiKey: blankToUndefined(env.AI_API_KEY),
    aiModel: blankToUndefined(env.AI_MODEL),
    aiBaseUrl: optionalHttpsUrl(blankToUndefined(env.AI_BASE_URL), "AI_BASE_URL"),
  };
}
