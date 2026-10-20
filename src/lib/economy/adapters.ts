import type { Address, Hex } from "viem";
import { findProtocolRule, type ProtocolAsset, type ProtocolRule } from "@/lib/economy/allowlist";

export type QuoteRequest = {
  chainId: 143;
  assetIn: ProtocolAsset;
  assetOut: ProtocolAsset;
  amountInRaw: bigint;
};

export type ProtocolQuote = {
  amountOutRaw: bigint;
  slippageBps: number;
  source: string;
};

/**
 * A future reviewed adapter. The registry starts empty. An adapter cannot
 * bypass the allowlist, and a missing quote is not a price.
 */
export type ProtocolAdapter = {
  id: string;
  label: string;
  target: Address;
  selectors: readonly Hex[];
  assets: readonly ProtocolAsset[];
  quote: (request: QuoteRequest) => Promise<ProtocolQuote | null>;
};

export const EXECUTABLE_ADAPTERS: readonly ProtocolAdapter[] = [];

export function adapterMayExecute(
  rules: readonly ProtocolRule[],
  target: Address,
  selector: Hex,
  asset: ProtocolAsset,
): { executable: false; reason: string } | { executable: true; reason: string } {
  if (EXECUTABLE_ADAPTERS.length === 0 && rules.length === 0) {
    return { executable: false, reason: "No protocol adapter is configured." };
  }
  const rule = findProtocolRule(rules, target, selector, asset);
  if (!rule) {
    return { executable: false, reason: "That target or selector is not on the executable allowlist." };
  }
  const adapter = EXECUTABLE_ADAPTERS.find(
    (item) => item.target.toLowerCase() === target.toLowerCase() && item.selectors.some((entry) => entry.toLowerCase() === selector.toLowerCase()),
  );
  if (!adapter) {
    return {
      executable: false,
      reason: "The allowlist names this call, and no reviewed adapter is registered to execute it.",
    };
  }
  return { executable: true, reason: "The adapter is registered. Execution remains a separate disabled gate." };
}
