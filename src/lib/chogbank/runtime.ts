import { getAddress, type Address } from "viem";
import type { AppConfig } from "@/lib/config/env";
import type { BankLimits, ObservedTreasury } from "@/lib/chogbank/types";

export const DEFAULT_BANK_LIMITS: BankLimits = {
  maxActivationWei: 500_000_000_000_000_000n,
  maxTxWei: 100_000_000_000_000_000n,
  maxDailyGasWei: 1_000_000_000_000_000_000n,
  maxTreasuryExposureWei: 5_000_000_000_000_000_000n,
};

export type BankRuntime = {
  treasury: ObservedTreasury;
  limits: BankLimits;
  factoryAddress: Address | null;
  factoryDeployed: boolean;
  relayerEnabled: boolean;
};

export const UNSET_TREASURY: ObservedTreasury = {
  configured: false,
  chainId: 143,
  availableWei: 0n,
  reservedWei: 0n,
  source: "unset",
};

/**
 * Production runtime is fail-closed: no observed treasury, relayer off.
 * A configured factory address is not deployment. Code verification is a
 * separate observed flag and stays false unless an operator records it.
 */
export function productionBankRuntime(
  config: Pick<
    AppConfig,
    "citizenAccountFactoryAddress" | "citizenAccountFactoryCodeVerified" | "chogBankLimits"
  >,
): BankRuntime {
  const address = config.citizenAccountFactoryAddress ?? null;
  return {
    treasury: UNSET_TREASURY,
    limits: config.chogBankLimits,
    factoryAddress: address,
    factoryDeployed: factoryIsDeployed({ address, codeVerified: config.citizenAccountFactoryCodeVerified }),
    relayerEnabled: false,
  };
}

export function factoryIsDeployed(input: {
  address: Address | null | undefined;
  codeVerified: boolean;
}): boolean {
  if (!input.address || !input.codeVerified) {
    return false;
  }
  try {
    getAddress(input.address);
  } catch {
    return false;
  }
  return true;
}

export function injectedTreasury(availableWei: bigint, reservedWei = 0n): ObservedTreasury {
  return {
    configured: true,
    chainId: 143,
    availableWei,
    reservedWei,
    source: "injected",
  };
}
