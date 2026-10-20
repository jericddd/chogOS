import { getAddress, type Address } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import type { AppConfig } from "@/lib/config/env";
import { parseProtocolAllowlist } from "@/lib/economy/allowlist";
import { economicAddressProblem, emptySnapshot, readEconomicTreasury, type TreasurySnapshot } from "@/lib/economy/observe";
import { decideEconomicProposal, type EconomicProposal, type EconomyDecision, type EconomyLimits } from "@/lib/economy/proposal";
import type { Hold } from "@/lib/economy/reserve";

export function economyLimitsFrom(config: AppConfig): EconomyLimits {
  return {
    maxCitizenCapitalWei: config.economyLimits.maxCitizenCapitalWei,
    maxBusinessAllocationWei: config.economyLimits.maxBusinessAllocationWei,
    maxTxWei: config.chogBankLimits.maxTxWei,
    maxDailyGasWei: config.chogBankLimits.maxDailyGasWei,
    maxTreasuryExposureWei: config.chogBankLimits.maxTreasuryExposureWei,
    maxChogPerTxRaw: config.economyLimits.maxChogPerTxRaw,
    maxCitizenChogRaw: config.economyLimits.maxCitizenChogRaw,
    maxBusinessChogRaw: config.economyLimits.maxBusinessChogRaw,
  };
}

export async function readConfiguredEconomicTreasury(config: AppConfig, nowMs: number): Promise<TreasurySnapshot> {
  const address = config.chogBankAssetAddress ?? null;
  const problem = economicAddressProblem(address, {
    nftTreasury: addresses.chogTreasury,
    nft: addresses.chogGenesis,
    token: addresses.chogToken,
    gas: config.chogBankGasAddress ?? null,
    also: config.chogTreasuryAddress,
  });
  if (!address) {
    return emptySnapshot("not_configured", "Economic treasury address is not configured.");
  }
  if (problem) {
    return emptySnapshot("malformed", problem, safeAddress(address));
  }
  if (config.chainId !== 143) {
    return {
      ...emptySnapshot("wrong_chain", `Application chain is ${config.chainId}, not Monad mainnet 143.`, address),
      observedChainId: config.chainId,
    };
  }
  return readEconomicTreasury({
    address,
    rpcUrl: config.rpcUrl,
    nowMs,
    maxAgeMs: config.chogBankObservationMaxAgeMs,
  });
}

/**
 * The production decision path. executionEnabled is fixed false in this
 * function. Callers cannot turn it on with an environment variable.
 * A passing proposal can still record an offchain hold. That hold is not a broadcast.
 */
export async function evaluateProductionEconomy(input: {
  config: AppConfig;
  proposal: EconomicProposal;
  nowMs: number;
  holds?: readonly Hold[];
  dailyGasWei?: bigint;
  dailyGasKnown?: boolean;
  observation?: TreasurySnapshot;
}): Promise<{ decision: EconomyDecision; holds: Hold[]; observation: TreasurySnapshot }> {
  const observation = input.observation ?? (await readConfiguredEconomicTreasury(input.config, input.nowMs));
  const decided = decideEconomicProposal({
    proposal: input.proposal,
    observation,
    holds: input.holds ?? [],
    limits: economyLimitsFrom(input.config),
    dailyGasWei: input.dailyGasWei ?? 0n,
    dailyGasKnown: input.dailyGasKnown ?? false,
    allowlist: parseProtocolAllowlist(input.config.economyAllowlist).rules,
    // A configured address or CODE_VERIFIED flag is not observed bytecode.
    factoryDeployed: false,
    nowMs: input.nowMs,
    executionEnabled: false,
  });
  return { ...decided, observation };
}

function safeAddress(value: string): Address | null {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}
