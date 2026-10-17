import { getAddress, type Address } from "viem";
import type { ParsedDecision } from "@/lib/ai/schema";
import { evaluateActivation, nextStateAfterBank, type BankDecision } from "@/lib/chogbank/policy";
import { UNSET_TREASURY, type BankRuntime } from "@/lib/chogbank/runtime";
import type { ActivationRequest } from "@/lib/chogbank/types";

export function isActivationDraft(
  value: ActivationRequest | { ok: false; reason: string },
): value is ActivationRequest {
  return !("ok" in value);
}

export function activationDraftFromDecision(input: {
  id: string;
  citizenId: string;
  tokenId: string;
  nftContract: Address;
  decisionId: string;
  decision: ParsedDecision;
  createdAt: string;
}): ActivationRequest | { ok: false; reason: string } {
  if (input.decision.action !== "request_wallet_activation") {
    return { ok: false, reason: "not an activation decision" };
  }
  if (!input.decision.activationMotive) {
    return { ok: false, reason: "activation motive is required" };
  }
  if (!input.decision.proposedOnchainActions) {
    return { ok: false, reason: "proposed onchain actions are required" };
  }
  return {
    id: input.id,
    citizenId: input.citizenId,
    tokenId: input.tokenId,
    chainId: 143,
    nftContract: getAddress(input.nftContract),
    motive: input.decision.activationMotive,
    goal: input.decision.summary,
    proposedActions: input.decision.proposedOnchainActions,
    revenueHypothesis: input.decision.revenueHypothesis ?? "",
    estimatedDeploymentWei: input.decision.claimedDeploymentWei ?? 0n,
    estimatedGasWei: input.decision.claimedGasWei ?? 0n,
    decisionId: input.decisionId,
    state: "activation_requested",
    predictedAddress: null,
    accountAddress: null,
    reservationId: null,
    rejectReason: null,
    createdAt: input.createdAt,
  };
}

export function evaluateDecisionActivation(input: {
  request: ActivationRequest;
  existing: ActivationRequest | null;
  runtime: BankRuntime;
  openReservationsHeldWei?: bigint;
  dailyGasSpentWei?: bigint;
}): { request: ActivationRequest; decision: BankDecision } {
  const treasury = input.runtime.treasury ?? UNSET_TREASURY;
  const decision = evaluateActivation({
    request: input.request,
    treasury,
    limits: input.runtime.limits,
    openReservations: input.openReservationsHeldWei
      ? [{ id: "held", requestId: "aggregate", bucket: "gas", amountWei: input.openReservationsHeldWei, state: "held" }]
      : [],
    dailyGasSpentWei: input.dailyGasSpentWei ?? 0n,
    factoryDeployed: input.runtime.factoryDeployed,
    relayerEnabled: input.runtime.relayerEnabled,
    existing: input.existing,
  });
  return {
    request: {
      ...input.request,
      state: nextStateAfterBank(decision, input.runtime.factoryDeployed),
      rejectReason: decision.action === "approve" ? null : decision.reason,
    },
    decision,
  };
}
