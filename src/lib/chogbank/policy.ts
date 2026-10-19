import type {
  ActivationMotive,
  ActivationRequest,
  ActivationState,
  BankLimits,
  ObservedTreasury,
  Reservation,
  SponsoredJob,
} from "@/lib/chogbank/types";
import { ACTIVATION_MOTIVES } from "@/lib/chogbank/types";

const MOTIVE_SET = new Set<string>(ACTIVATION_MOTIVES);

export type BankDecision =
  | { action: "approve"; reserveDeploymentWei: bigint; reserveGasWei: bigint }
  | { action: "reject"; reason: string }
  | { action: "defer"; reason: string };

export function parseMotive(value: string): ActivationMotive | null {
  return MOTIVE_SET.has(value) ? (value as ActivationMotive) : null;
}

export function availableWei(treasury: ObservedTreasury): bigint {
  if (!treasury.configured) {
    return 0n;
  }
  return treasury.availableWei > treasury.reservedWei ? treasury.availableWei - treasury.reservedWei : 0n;
}

export function requestLooksFabricated(request: Pick<ActivationRequest, "goal" | "proposedActions" | "motive">): string | null {
  const goal = request.goal.trim().toLowerCase();
  const actions = request.proposedActions.trim().toLowerCase();
  if (goal.length < 12 || actions.length < 12) {
    return "activation needs a concrete goal and proposed onchain actions";
  }
  if (/want a wallet|just because|test wallet|everyone should/.test(goal)) {
    return "activation is not automatic and needs a real onchain purpose";
  }
  if (request.motive === "start_business" && !/business|trade|shop|service|goods/.test(`${goal} ${actions}`)) {
    return "business activation needs a specific trade or service";
  }
  return null;
}

export function evaluateActivation(input: {
  request: ActivationRequest;
  treasury: ObservedTreasury;
  limits: BankLimits;
  openReservations: Reservation[];
  dailyGasSpentWei: bigint;
  factoryDeployed: boolean;
  relayerEnabled: boolean;
  existing: ActivationRequest | null;
}): BankDecision {
  if (input.existing && (input.existing.state === "awaiting_bank_approval" || input.existing.state === "activation_requested")) {
    return { action: "defer", reason: "a request is already awaiting a bank decision" };
  }
  if (
    input.existing &&
    (input.existing.state === "predicted" ||
      input.existing.state === "deployment_pending" ||
      input.existing.state === "deployed" ||
      input.existing.state === "authorization_pending" ||
      input.existing.state === "active")
  ) {
    return { action: "reject", reason: "this NFT already has an activation in progress or an account" };
  }

  const fabricated = requestLooksFabricated(input.request);
  if (fabricated) {
    return { action: "reject", reason: fabricated };
  }

  if (!input.treasury.configured || input.treasury.source === "unset") {
    return { action: "defer", reason: "external funding is required; no treasury source is configured" };
  }

  const deployment = input.request.estimatedDeploymentWei;
  const gas = input.request.estimatedGasWei;
  const total = deployment + gas;
  if (total === 0n) {
    return { action: "defer", reason: "cost estimate is missing; the bank will not invent a balance" };
  }
  if (deployment > input.limits.maxActivationWei) {
    return { action: "reject", reason: "activation exceeds the per-citizen deployment limit" };
  }
  if (gas > input.limits.maxTxWei) {
    return { action: "reject", reason: "estimated gas exceeds the per-transaction limit" };
  }
  if (input.dailyGasSpentWei + gas > input.limits.maxDailyGasWei) {
    return { action: "defer", reason: "daily gas budget is exhausted" };
  }

  const held = input.openReservations.reduce((sum, row) => (row.state === "held" ? sum + row.amountWei : sum), 0n);
  const exposure = held + total + input.dailyGasSpentWei;
  if (exposure > input.limits.maxTreasuryExposureWei) {
    return { action: "reject", reason: "treasury exposure limit would be exceeded" };
  }

  const free = availableWei(input.treasury);
  if (free === 0n) {
    return { action: "defer", reason: "treasury available MON is zero; external funding is required" };
  }
  if (free < total) {
    return { action: "defer", reason: "insufficient available MON for deployment and gas" };
  }
  if (!input.factoryDeployed) {
    return { action: "defer", reason: "CitizenAccountFactory is not deployed; predicted is not deployed" };
  }
  if (!input.relayerEnabled) {
    return { action: "defer", reason: "relayer is disabled; the bank will not broadcast" };
  }
  return { action: "approve", reserveDeploymentWei: deployment, reserveGasWei: gas };
}

export function evaluateSponsorship(input: {
  job: Omit<SponsoredJob, "id" | "state" | "txHash" | "gasUsedWei" | "failureReason">;
  sessionAlive: boolean;
  sessionSelector: string;
  sessionTarget: string;
  treasury: ObservedTreasury;
  limits: BankLimits;
  dailyGasSpentWei: bigint;
  duplicate: SponsoredJob | null;
  relayerEnabled: boolean;
}): BankDecision | { action: "skip"; reason: string } {
  if (input.duplicate && (input.duplicate.state === "queued" || input.duplicate.state === "submitted" || input.duplicate.state === "confirmed")) {
    return { action: "skip", reason: "duplicate job" };
  }
  if (!input.relayerEnabled) {
    return { action: "defer", reason: "relayer is disabled; the bank will not broadcast" };
  }
  if (input.job.op === "account.executeSession") {
    if (!input.sessionAlive) {
      return { action: "reject", reason: "no live executor session" };
    }
    if (input.job.selector.toLowerCase() !== input.sessionSelector.toLowerCase()) {
      return { action: "reject", reason: "selector is not authorized" };
    }
    if (input.job.target.toLowerCase() !== input.sessionTarget.toLowerCase()) {
      return { action: "reject", reason: "target is not authorized" };
    }
  }
  if (input.job.valueWei > input.limits.maxTxWei) {
    return { action: "reject", reason: "value exceeds the per-transaction limit" };
  }
  if (input.job.estimatedGasWei > input.limits.maxTxWei) {
    return { action: "reject", reason: "estimated gas exceeds the per-transaction limit" };
  }
  const free = availableWei(input.treasury);
  if (!input.treasury.configured || free === 0n) {
    return { action: "defer", reason: "treasury available MON is zero; external funding is required" };
  }
  if (free < input.job.estimatedGasWei) {
    return { action: "defer", reason: "insufficient available MON for deployment and gas" };
  }
  if (input.dailyGasSpentWei + input.job.estimatedGasWei > input.limits.maxDailyGasWei) {
    return { action: "defer", reason: "daily gas budget is exhausted" };
  }
  return { action: "approve", reserveDeploymentWei: 0n, reserveGasWei: input.job.estimatedGasWei };
}

export function nextStateAfterBank(decision: BankDecision, factoryDeployed: boolean): ActivationState {
  if (decision.action === "reject") {
    return "rejected";
  }
  if (decision.action === "defer") {
    return "deferred";
  }
  if (!factoryDeployed) {
    return "deferred";
  }
  return "predicted";
}

export function isTerminalSuccess(state: ActivationState): boolean {
  return state === "active";
}

export function canRequestAgain(state: ActivationState | null): boolean {
  return state == null || state === "unassigned" || state === "rejected" || state === "deferred" || state === "error";
}
