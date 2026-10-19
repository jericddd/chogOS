import { getAddress, type Address } from "viem";
import type { BankLimits } from "@/lib/chogbank/types";
import { canSponsorExecution } from "@/lib/watcher/health";
import type { InvalidationState, WatcherHealth } from "@/lib/watcher/types";

export type BalanceRead =
  | {
      ok: true;
      chainId: number;
      address: Address;
      balanceWei: bigint;
      blockNumber: bigint;
      observedAt: string;
    }
  | { ok: false; error: string };

export type GasObservationStatus = "unconfigured" | "observed" | "stale" | "unavailable" | "wrong_chain" | "address_mismatch";

export type GasObservation = {
  status: GasObservationStatus;
  chainId: number | null;
  address: Address | null;
  observedBalanceWei: bigint | null;
  observedAt: string | null;
  blockNumber: bigint | null;
  reservedGasWei: bigint;
  reservedDeploymentWei: bigint;
  /** Reported separately. Never added to available gas and never treated as spendable MON. */
  businessCapitalWei: bigint;
  availableWei: bigint | null;
  limits: BankLimits;
  /** True only for a fresh chain-143 reading with available gas above zero. This does not enable signing. */
  fundsAvailable: boolean;
  reason: string;
};

export type NativeBalanceReader = {
  getChainId(): Promise<number>;
  read(address: Address): Promise<{ balanceWei: bigint; blockNumber: bigint; observedAt: string }>;
};

/**
 * The model cannot supply a treasury balance or mark funds as received.
 * Callers that only have a model claim must use this and get null.
 */
export function fundsFromModel(claim: unknown): null {
  // Any model claim, including a made-up balance or a "received" flag, is not capital.
  if (claim !== undefined) {
    return null;
  }
  return null;
}

export async function readNativeBalance(reader: NativeBalanceReader, address: Address): Promise<BalanceRead> {
  try {
    const chainId = await reader.getChainId();
    const reading = await reader.read(address);
    return { ok: true, chainId, address: getAddress(address), ...reading };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "balance read failed" };
  }
}

/**
 * Read-only view of the gas-paying address. Business capital and hypothetical revenue
 * are not available gas. A failed or stale read has availableWei null, not zero.
 */
export function assessObservedGas(input: {
  configuredAddress: Address | null;
  read: BalanceRead | null;
  nowMs: number;
  maxAgeMs: number;
  reservedGasWei: bigint;
  reservedDeploymentWei: bigint;
  businessCapitalWei: bigint;
  revenueHypothesisWei?: bigint;
  limits: BankLimits;
}): GasObservation {
  const limits = input.limits;
  const reservedGasWei = input.reservedGasWei;
  const reservedDeploymentWei = input.reservedDeploymentWei;
  const businessCapitalWei = input.businessCapitalWei;
  const base = {
    chainId: null as number | null,
    address: input.configuredAddress,
    observedBalanceWei: null as bigint | null,
    observedAt: null as string | null,
    blockNumber: null as bigint | null,
    reservedGasWei,
    reservedDeploymentWei,
    businessCapitalWei,
    availableWei: null as bigint | null,
    limits,
    fundsAvailable: false,
  };
  void input.revenueHypothesisWei;

  if (!input.configuredAddress) {
    return { ...base, status: "unconfigured", reason: "gas-paying address is not configured" };
  }
  let configured: Address;
  try {
    configured = getAddress(input.configuredAddress);
  } catch {
    return { ...base, address: null, status: "unconfigured", reason: "gas-paying address is invalid" };
  }
  if (!input.read || !input.read.ok) {
    return {
      ...base,
      address: configured,
      status: "unavailable",
      reason: input.read && !input.read.ok ? input.read.error : "gas balance was not read",
    };
  }
  if (input.read.chainId !== 143) {
    return {
      ...base,
      chainId: input.read.chainId,
      address: configured,
      status: "wrong_chain",
      reason: `gas balance came from chain ${input.read.chainId}, not 143`,
    };
  }
  if (getAddress(input.read.address) !== configured) {
    return {
      ...base,
      chainId: input.read.chainId,
      address: configured,
      status: "address_mismatch",
      reason: "gas balance was read for a different address",
    };
  }
  const observedMs = Date.parse(input.read.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > input.nowMs + 5_000) {
    return {
      ...base,
      chainId: 143,
      address: configured,
      status: "unavailable",
      reason: "gas observation timestamp is not usable",
    };
  }
  if (input.nowMs - observedMs > input.maxAgeMs) {
    return {
      ...base,
      chainId: 143,
      address: configured,
      observedBalanceWei: input.read.balanceWei,
      observedAt: input.read.observedAt,
      blockNumber: input.read.blockNumber,
      status: "stale",
      reason: "gas observation is stale",
    };
  }
  const reserved = reservedGasWei + reservedDeploymentWei;
  const availableWei = input.read.balanceWei > reserved ? input.read.balanceWei - reserved : 0n;
  return {
    ...base,
    status: "observed",
    chainId: 143,
    address: configured,
    observedBalanceWei: input.read.balanceWei,
    observedAt: input.read.observedAt,
    blockNumber: input.read.blockNumber,
    availableWei,
    fundsAvailable: availableWei > 0n,
    reason: availableWei > 0n ? "gas balance observed" : "observed gas balance does not cover reserved funds",
  };
}

/**
 * Production sponsorship gate. This phase never returns allowed.
 * Watcher and balance failures keep their own reasons. A healthy fresh
 * observation still stops because signing is disabled.
 */
export function sponsorshipDecision(input: {
  health: WatcherHealth;
  sessionInvalidation?: InvalidationState | null;
  gas: GasObservation;
  signerCanSign: boolean;
}): { allowed: false; reason: string } {
  const watcher = canSponsorExecution(input.health, input.sessionInvalidation ?? null);
  if (!watcher.allowed) {
    return watcher;
  }
  if (input.gas.status !== "observed" || input.gas.availableWei === null || !input.gas.fundsAvailable) {
    return { allowed: false, reason: input.gas.reason };
  }
  if (input.signerCanSign) {
    return { allowed: false, reason: "a live signer is not enabled in this phase" };
  }
  return { allowed: false, reason: "signing is disabled" };
}
