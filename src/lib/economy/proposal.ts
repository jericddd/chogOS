import { getAddress, type Address, type Hex } from "viem";
import { findProtocolRule, type ProtocolRule } from "@/lib/economy/allowlist";
import { parseRawAmount } from "@/lib/economy/amounts";
import type { TreasurySnapshot } from "@/lib/economy/observe";
import { heldRaw, tryHoldBatch, type Hold, type HoldRequest } from "@/lib/economy/reserve";

export const ECONOMY_OPERATIONS = ["payment", "purchase", "trade", "swap", "business", "return_capital"] as const;
export type EconomicOperation = (typeof ECONOMY_OPERATIONS)[number];

export const ECONOMY_OUTCOMES = [
  "approved",
  "rejected",
  "deferred",
  "insufficient_funds",
  "budget_exhausted",
  "unsupported_protocol",
] as const;

export type EconomyOutcome = (typeof ECONOMY_OUTCOMES)[number];

export type EconomyLimits = {
  maxCitizenCapitalWei: bigint;
  maxBusinessAllocationWei: bigint;
  maxTxWei: bigint;
  maxDailyGasWei: bigint;
  maxTreasuryExposureWei: bigint;
  maxChogPerTxRaw: bigint;
  maxCitizenChogRaw: bigint;
  maxBusinessChogRaw: bigint;
};

export type EconomyDraft = {
  operation: EconomicOperation;
  objective: string;
  rationale: string;
  expectedOutcome: string;
  target: Address | null;
  selector: Hex | null;
  asset: "MON" | "CHOG";
  amountRaw: bigint;
  estimatedGasWei: bigint;
  fundingRequestRaw: bigint;
  quotePriceRaw: bigint | null;
  slippageBps: number | null;
};

export type EconomicProposal = {
  id: string;
  idempotencyKey: string;
  citizenId: string;
  tokenId: string;
  nftContract: Address;
  objective: string;
  rationale: string;
  operation: EconomicOperation;
  target: Address | null;
  selector: Hex | null;
  asset: "MON" | "CHOG";
  amountRaw: bigint;
  estimatedGasWei: bigint;
  fundingRequestRaw: bigint;
  expectedOutcome: string;
  quotePriceRaw: bigint | null;
  slippageBps: number | null;
  expiresAtMs: number;
};

export type EconomyDecision = {
  outcome: EconomyOutcome;
  reason: string;
  hold: Hold | null;
  /** True only when a hold was created. Production execution never sets this by itself. */
  reserved: boolean;
  executed: false;
};

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;

export function parseEconomicProposal(value: unknown, nowMs: number): { ok: true; proposal: EconomicProposal } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "An economic proposal must be an object." };
  }
  const row = value as Record<string, unknown>;
  const operation = typeof row.operation === "string" ? row.operation : "";
  if (!(ECONOMY_OPERATIONS as readonly string[]).includes(operation)) {
    return { ok: false, reason: "The economic operation is not supported." };
  }
  const asset = row.asset === "MON" || row.asset === "CHOG" ? row.asset : null;
  if (!asset) {
    return { ok: false, reason: "The asset must be MON or CHOG." };
  }
  const amountRaw = parseRawAmount(row.amountRaw);
  const estimatedGasWei = parseRawAmount(row.estimatedGasWei);
  const fundingRequestRaw = parseRawAmount(row.fundingRequestRaw);
  if (amountRaw === null || estimatedGasWei === null || fundingRequestRaw === null) {
    return { ok: false, reason: "Amounts must be non-negative integer base units, not decimals." };
  }
  const objective = text(row.objective, 180);
  const rationale = text(row.rationale, 320);
  const expectedOutcome = text(row.expectedOutcome, 240);
  const idempotencyKey = text(row.idempotencyKey, 120);
  const citizenId = text(row.citizenId, 80);
  const tokenId = text(row.tokenId, 78);
  if (!objective || !rationale || !expectedOutcome || !idempotencyKey || !citizenId || !/^[0-9]+$/.test(tokenId)) {
    return { ok: false, reason: "The proposal is missing its objective, rationale, outcome, identity, or idempotency key." };
  }
  if (/https?:\/\//i.test(`${objective} ${rationale} ${expectedOutcome}`)) {
    return { ok: false, reason: "Proposal text may not include URLs." };
  }
  let nftContract: Address;
  try {
    nftContract = getAddress(String(row.nftContract ?? ""));
  } catch {
    return { ok: false, reason: "The NFT contract is not a valid address." };
  }
  let target: Address | null = null;
  if (row.target != null && row.target !== "") {
    try {
      target = getAddress(String(row.target));
    } catch {
      return { ok: false, reason: "The protocol target is not a valid address." };
    }
  }
  let selector: Hex | null = null;
  if (row.selector != null && row.selector !== "") {
    if (typeof row.selector !== "string" || !SELECTOR.test(row.selector)) {
      return { ok: false, reason: "The function selector is malformed." };
    }
    selector = row.selector.toLowerCase() as Hex;
  }
  const quotePriceRaw = row.quotePriceRaw == null || row.quotePriceRaw === "" ? null : parseRawAmount(row.quotePriceRaw);
  if (row.quotePriceRaw != null && row.quotePriceRaw !== "" && quotePriceRaw === null) {
    return { ok: false, reason: "A quote price must be an integer base-unit amount." };
  }
  const slippageBps = row.slippageBps == null || row.slippageBps === "" ? null : slippage(row.slippageBps);
  if (row.slippageBps != null && row.slippageBps !== "" && slippageBps === null) {
    return { ok: false, reason: "Slippage must be an integer number of basis points from 0 to 1000." };
  }
  if (operation === "swap" && (quotePriceRaw === null || quotePriceRaw === 0n || slippageBps === null)) {
    return { ok: false, reason: "A swap needs an explicit quote and a slippage bound. No price is assumed." };
  }
  const expiresAtMs = typeof row.expiresAtMs === "number" && Number.isInteger(row.expiresAtMs) ? row.expiresAtMs : nowMs + 60 * 60 * 1000;
  return {
    ok: true,
    proposal: {
      id: text(row.id, 80) || idempotencyKey,
      idempotencyKey,
      citizenId,
      tokenId,
      nftContract,
      objective,
      rationale,
      operation: operation as EconomicOperation,
      target,
      selector,
      asset,
      amountRaw,
      estimatedGasWei,
      fundingRequestRaw,
      expectedOutcome,
      quotePriceRaw,
      slippageBps,
      expiresAtMs,
    },
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function slippage(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
    return null;
  }
  return value;
}

export function decideEconomicProposal(input: {
  proposal: EconomicProposal;
  observation: TreasurySnapshot;
  holds: readonly Hold[];
  limits: EconomyLimits;
  dailyGasWei: bigint;
  /** False when today's gas total has not been loaded. Unknown usage is not zero. */
  dailyGasKnown: boolean;
  allowlist: readonly ProtocolRule[];
  factoryDeployed: boolean;
  nowMs: number;
  executionEnabled: boolean;
}): { decision: EconomyDecision; holds: Hold[] } {
  const proposal = input.proposal;
  const refuse = (outcome: EconomyOutcome, reason: string): { decision: EconomyDecision; holds: Hold[] } => ({
    decision: { outcome, reason, hold: null, reserved: false, executed: false },
    holds: [...input.holds],
  });

  if (proposal.expiresAtMs <= input.nowMs) {
    return refuse("deferred", "The proposal has expired. Submit it again if it is still wanted.");
  }
  if (proposal.amountRaw === 0n && proposal.fundingRequestRaw === 0n) {
    return refuse("rejected", "The proposal does not name a positive amount or funding request.");
  }
  if (proposal.operation === "swap" && (proposal.quotePriceRaw === null || proposal.slippageBps === null)) {
    return refuse("unsupported_protocol", "A swap without a quote and slippage bound is not executable.");
  }
  if (!proposal.target || !proposal.selector) {
    return refuse("unsupported_protocol", "No reviewed target and selector were proposed, so this stays a proposal.");
  }
  const rule = findProtocolRule(input.allowlist, proposal.target, proposal.selector, proposal.asset);
  if (!rule) {
    return refuse("unsupported_protocol", "That target or selector is not on the executable allowlist.");
  }
  if (input.executionEnabled && !input.factoryDeployed) {
    return refuse("deferred", "The citizen wallet factory is not deployed. A predicted address is not a balance.");
  }
  const capital = proposal.fundingRequestRaw;
  if (proposal.asset === "MON" && (proposal.amountRaw > input.limits.maxTxWei || capital > input.limits.maxTxWei)) {
    return refuse("rejected", "The MON amount exceeds the per-transaction limit.");
  }
  if (proposal.asset === "CHOG") {
    const chogAsked = proposal.amountRaw > capital ? proposal.amountRaw : capital;
    if (input.limits.maxChogPerTxRaw === 0n || chogAsked > input.limits.maxChogPerTxRaw) {
      return refuse("budget_exhausted", "The $CHOG amount exceeds the configured token limit.");
    }
  }
  if (proposal.estimatedGasWei > input.limits.maxTxWei) {
    return refuse("rejected", "Estimated gas exceeds the per-transaction limit.");
  }
  if (input.dailyGasKnown && input.dailyGasWei + proposal.estimatedGasWei > input.limits.maxDailyGasWei) {
    return refuse("budget_exhausted", "Daily gas exposure would be exceeded.");
  }
  const citizenHolds = input.holds.filter((hold) => hold.tokenId === proposal.tokenId);
  const citizenMon = heldRaw(citizenHolds, "MON", "business_capital");
  const citizenChog = heldRaw(citizenHolds, "CHOG", "business_capital");
  if (proposal.asset === "MON" && citizenMon + capital > input.limits.maxCitizenCapitalWei) {
    return refuse("budget_exhausted", "This citizen's capital budget would be exceeded.");
  }
  if (proposal.asset === "CHOG" && citizenChog + capital > input.limits.maxCitizenChogRaw) {
    return refuse("budget_exhausted", "This citizen's $CHOG budget would be exceeded.");
  }
  if (proposal.asset === "MON" && capital > input.limits.maxBusinessAllocationWei) {
    return refuse("budget_exhausted", "The business allocation limit would be exceeded.");
  }
  if (proposal.asset === "CHOG" && capital > input.limits.maxBusinessChogRaw) {
    return refuse("budget_exhausted", "The $CHOG business allocation limit would be exceeded.");
  }
  const monNeeded = (proposal.asset === "MON" ? capital : 0n) + proposal.estimatedGasWei;
  const exposure = heldRaw(input.holds, "MON") + monNeeded + (input.dailyGasKnown ? input.dailyGasWei : 0n);
  if (exposure > input.limits.maxTreasuryExposureWei) {
    return refuse("budget_exhausted", "Total treasury exposure would be exceeded.");
  }
  if (!input.dailyGasKnown) {
    return refuse("deferred", "Daily gas usage has not been loaded. Production execution is disabled, and no funds were reserved.");
  }
  if (input.observation.status !== "observed" || input.observation.chainId !== 143) {
    return refuse("deferred", "The economic treasury is not a fresh mainnet observation, so no funds are reserved.");
  }
  const observed = proposal.asset === "MON" ? input.observation.mon.raw : input.observation.chog.raw;
  const gasObserved = input.observation.mon.raw;
  if (observed === null || gasObserved === null) {
    return refuse("deferred", "A balance is missing, so the bank will not invent funds.");
  }
  if (proposal.asset === "MON" && observed < capital + proposal.estimatedGasWei) {
    return refuse("insufficient_funds", "Observed MON cannot cover the funding request and estimated gas.");
  }
  if (proposal.asset === "CHOG" && capital > 0n && observed < capital) {
    return refuse("insufficient_funds", "Observed $CHOG cannot cover the funding request.");
  }
  if (gasObserved < proposal.estimatedGasWei) {
    return refuse("insufficient_funds", "Observed MON cannot cover the estimated gas.");
  }
  const reserved = reserveApproved(input.holds, proposal, observed, gasObserved);
  if (reserved.decision.outcome !== "approved" || input.executionEnabled) {
    return reserved;
  }
  return {
    ...reserved,
    decision: {
      ...reserved.decision,
      reason: reserved.decision.reserved
        ? "Offchain reservation recorded against the observed balance. Production execution is disabled, so nothing was signed or broadcast."
        : "The offchain reservation already exists. Production execution is disabled, so nothing was signed or broadcast.",
    },
  };
}

function reserveApproved(
  holds: readonly Hold[],
  proposal: EconomicProposal,
  observed: bigint,
  gasObserved: bigint,
): { decision: EconomyDecision; holds: Hold[] } {
  const requests: HoldRequest[] = [];
  if (proposal.fundingRequestRaw > 0n) {
    requests.push({
      id: `${proposal.id}:capital`,
      key: proposal.idempotencyKey,
      proposalId: `${proposal.citizenId}:${proposal.tokenId}:${proposal.id}`,
      tokenId: proposal.tokenId,
      asset: proposal.asset,
      bucket: "business_capital",
      amountRaw: proposal.fundingRequestRaw,
      observedRaw: observed,
    });
  }
  if (proposal.estimatedGasWei > 0n) {
    requests.push({
      id: `${proposal.id}:gas`,
      key: `${proposal.idempotencyKey}:gas`,
      proposalId: `${proposal.citizenId}:${proposal.tokenId}:${proposal.id}`,
      tokenId: proposal.tokenId,
      asset: "MON",
      bucket: "gas",
      amountRaw: proposal.estimatedGasWei,
      observedRaw: gasObserved,
    });
  }
  if (requests.length === 0) {
    return {
      decision: {
        outcome: "approved",
        reason: "The reservation already exists. This approval does not broadcast a transaction.",
        hold: null,
        reserved: false,
        executed: false,
      },
      holds: [...holds],
    };
  }
  const batch = tryHoldBatch(holds, requests);
  if (!batch.ok) {
    return {
      decision: {
        outcome: batch.outcome === "insufficient_funds" ? "insufficient_funds" : "rejected",
        reason: batch.reason,
        hold: null,
        reserved: false,
        executed: false,
      },
      holds: batch.holds,
    };
  }
  const primary =
    batch.holds.find((hold) => hold.key === proposal.idempotencyKey) ??
    batch.holds.find((hold) => hold.key === `${proposal.idempotencyKey}:gas`) ??
    null;
  return {
    decision: {
      outcome: "approved",
      reason: batch.created
        ? "Reserved against the observed balance. This approval does not broadcast a transaction."
        : "The reservation already exists. This approval does not broadcast a transaction.",
      hold: primary,
      reserved: batch.created,
      executed: false,
    },
    holds: batch.holds,
  };
}

export function parseEconomyDraft(value: unknown): { ok: true; draft: EconomyDraft } | { ok: false; reason: string } {
  const parsed = parseEconomicProposal(
    {
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
      idempotencyKey: "draft",
      citizenId: "draft",
      tokenId: "0",
      nftContract: "0x0000000000000000000000000000000000000001",
    },
    0,
  );
  if (!parsed.ok) {
    return parsed;
  }
  const { proposal } = parsed;
  return {
    ok: true,
    draft: {
      operation: proposal.operation,
      objective: proposal.objective,
      rationale: proposal.rationale,
      expectedOutcome: proposal.expectedOutcome,
      target: proposal.target,
      selector: proposal.selector,
      asset: proposal.asset,
      amountRaw: proposal.amountRaw,
      estimatedGasWei: proposal.estimatedGasWei,
      fundingRequestRaw: proposal.fundingRequestRaw,
      quotePriceRaw: proposal.quotePriceRaw,
      slippageBps: proposal.slippageBps,
    },
  };
}

export function proposalFromDraft(
  draft: EconomyDraft,
  identity: {
    id: string;
    idempotencyKey: string;
    citizenId: string;
    tokenId: string;
    nftContract: Address;
    nowMs: number;
    expiresAtMs?: number;
  },
): EconomicProposal {
  return {
    id: identity.id,
    idempotencyKey: identity.idempotencyKey,
    citizenId: identity.citizenId,
    tokenId: identity.tokenId,
    nftContract: identity.nftContract,
    objective: draft.objective,
    rationale: draft.rationale,
    operation: draft.operation,
    target: draft.target,
    selector: draft.selector,
    asset: draft.asset,
    amountRaw: draft.amountRaw,
    estimatedGasWei: draft.estimatedGasWei,
    fundingRequestRaw: draft.fundingRequestRaw,
    expectedOutcome: draft.expectedOutcome,
    quotePriceRaw: draft.quotePriceRaw,
    slippageBps: draft.slippageBps,
    expiresAtMs: identity.expiresAtMs ?? identity.nowMs + 60 * 60 * 1000,
  };
}
