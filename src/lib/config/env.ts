import { getAddress, type Address } from "viem";
import { z } from "zod";

const DEFAULT_NFT_ADDRESS = "0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763";
const DEFAULT_TOKEN_ADDRESS = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";

export type AiProviderId = "none" | "openai" | "anthropic";

export type AppConfig = {
  chainId: 143 | 10143;
  rpcUrl?: string;
  chogNftAddress: Address;
  chogTokenAddress: Address;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  aiProvider: AiProviderId;
  aiApiKey?: string;
  aiModel?: string;
  aiBaseUrl?: string;
};

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

function optionalUrl(value: string | undefined, label: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = z.url().safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}. Expected an http or https URL.`);
  }

  return parsed.data;
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
  if (aiProvider !== "none" && aiProvider !== "openai" && aiProvider !== "anthropic") {
    throw new Error("Invalid AI_PROVIDER. Use none, openai, or anthropic.");
  }

  return {
    chainId: chainRaw === "143" ? 143 : 10143,
    rpcUrl: optionalUrl(blankToUndefined(env.MONAD_RPC_URL), "MONAD_RPC_URL"),
    chogNftAddress: requireAddress(
      blankToUndefined(env.CHOG_NFT_ADDRESS) ?? DEFAULT_NFT_ADDRESS,
      "CHOG_NFT_ADDRESS",
    ),
    chogTokenAddress: requireAddress(
      blankToUndefined(env.CHOG_TOKEN_ADDRESS) ?? DEFAULT_TOKEN_ADDRESS,
      "CHOG_TOKEN_ADDRESS",
    ),
    supabaseUrl: optionalUrl(blankToUndefined(env.SUPABASE_URL), "SUPABASE_URL"),
    supabaseAnonKey: blankToUndefined(env.SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: blankToUndefined(env.SUPABASE_SERVICE_ROLE_KEY),
    aiProvider,
    aiApiKey: blankToUndefined(env.AI_API_KEY),
    aiModel: blankToUndefined(env.AI_MODEL),
    aiBaseUrl: optionalUrl(blankToUndefined(env.AI_BASE_URL), "AI_BASE_URL"),
  };
}
