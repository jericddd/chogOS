import { keccak256, toBytes, type Hex } from "viem";

/**
 * Application review limits. These are not the immutable caps of a deployed
 * contract. The contract is not deployed. $CHOG stays closed until a person
 * chooses a raw base-unit cap. 18 decimals was returned by decimals() on the
 * official token at 0x350035555E10d9AfAF1566AaebfCeD5BA6C27777 on Monad
 * mainnet, chain 143. A missing or different live read rejects token amounts.
 */
export const OBSERVED_CHOG_DECIMALS = 18;

export const APPLICATION_TREASURY_LIMITS = {
  chainId: 143,
  windowSeconds: 24 * 60 * 60,
  maxAuthorizationTtl: 60 * 60,
  maxPerTxMon: 100_000_000_000_000_000n,
  maxCitizenWindowMon: 1_000_000_000_000_000_000n,
  maxAggregateWindowMon: 2_000_000_000_000_000_000n,
  maxPerTxChog: 0n,
  maxCitizenWindowChog: 0n,
  maxAggregateWindowChog: 0n,
} as const;

export type TreasuryAsset = "MON" | "CHOG";

export type AllocationDraft = {
  tokenId: string;
  asset: TreasuryAsset;
  amountRaw: bigint;
  reason: string;
  expectedOutcome: string;
};

export type PolicyLimits = {
  chainId: number;
  windowSeconds: number;
  maxAuthorizationTtl: number;
  maxPerTxMon: bigint;
  maxCitizenWindowMon: bigint;
  maxAggregateWindowMon: bigint;
  maxPerTxChog: bigint;
  maxCitizenWindowChog: bigint;
  maxAggregateWindowChog: bigint;
};

export type SpendRecord = {
  decisionId: string;
  tokenId: string;
  asset: TreasuryAsset;
  amountRaw: bigint;
  windowId: string;
};

export type AllocationStatus =
  | "rejected"
  | "duplicate"
  | "budget_exhausted"
  | "insufficient_funds"
  | "accepted_not_executed"
  | "ready_for_signature";

export type AllocationVerdict = {
  status: AllocationStatus;
  reason: string;
  executed: false;
  decisionId: Hex | null;
  reasonHash: Hex | null;
  deadline: number | null;
  windowId: string | null;
  /** True only when a later confirmed receipt is classified. Policy never sets this. */
  onchain: false;
};

const CLOSED = "accepted_not_executed" as const;

export function treasuryDecisionId(tokenId: string, asset: TreasuryAsset, windowId: string): Hex {
  return keccak256(toBytes(`chogos.treasury.v1:${tokenId}:${asset}:${windowId}`));
}

export function treasuryReasonHash(reason: string): Hex {
  return keccak256(toBytes(reason));
}

export function treasuryWindowId(nowMs: number, windowSeconds: number): string {
  const seconds = Math.floor(nowMs / 1000);
  return String(Math.floor(seconds / windowSeconds));
}

export function evaluateTreasuryAllocation(input: {
  draft: AllocationDraft;
  limits: PolicyLimits;
  nowMs: number;
  eligibleTokenIds: ReadonlySet<string>;
  spent: readonly SpendRecord[];
  monBalance: bigint | null;
  chogBalance: bigint | null;
  chogDecimals: number | null;
  walletDeployed: boolean;
  executionEnabled: boolean;
  walletObservation?: WalletObservation;
}): AllocationVerdict {
  const draft = input.draft;
  const fail = (status: AllocationStatus, reason: string): AllocationVerdict => ({
    status,
    reason,
    executed: false,
    decisionId: null,
    reasonHash: null,
    deadline: null,
    windowId: null,
    onchain: false,
  });

  if (input.limits.chainId !== 143) {
    return fail("rejected", `The supported chain is Monad mainnet, chain id 143. This review saw ${input.limits.chainId}.`);
  }
  if (!/^[0-9]+$/.test(draft.tokenId) || !input.eligibleTokenIds.has(draft.tokenId)) {
    return fail("rejected", "The recipient must be a citizen token id from the eligible roster. An address is not accepted.");
  }
  if (draft.asset !== "MON" && draft.asset !== "CHOG") {
    return fail("rejected", "The only supported assets are native MON and the official $CHOG token.");
  }
  if (draft.amountRaw <= 0n) {
    return fail("rejected", "The amount must be a positive integer in base units.");
  }
  if (!draft.reason.trim() || !draft.expectedOutcome.trim()) {
    return fail("rejected", "The allocation needs a reason and an expected outcome.");
  }
  if (draft.asset === "CHOG") {
    if (input.chogDecimals == null) {
      return fail("rejected", "The official $CHOG decimals() value was not read, so no token amount can be approved.");
    }
    if (input.chogDecimals !== OBSERVED_CHOG_DECIMALS) {
      return fail("rejected", `The official $CHOG token reported ${input.chogDecimals} decimals. This review only accepts the observed 18.`);
    }
    if (input.limits.maxPerTxChog <= 0n || input.limits.maxCitizenWindowChog <= 0n || input.limits.maxAggregateWindowChog <= 0n) {
      return fail("budget_exhausted", "The application cap for $CHOG is closed. No token amount was assumed from a price.");
    }
  }

  const perTx = draft.asset === "MON" ? input.limits.maxPerTxMon : input.limits.maxPerTxChog;
  const perCitizen = draft.asset === "MON" ? input.limits.maxCitizenWindowMon : input.limits.maxCitizenWindowChog;
  const aggregate = draft.asset === "MON" ? input.limits.maxAggregateWindowMon : input.limits.maxAggregateWindowChog;
  if (perTx <= 0n || perCitizen <= 0n || aggregate <= 0n) {
    return fail("budget_exhausted", "This asset has no open spending cap.");
  }
  if (draft.amountRaw > perTx) {
    return fail("budget_exhausted", "The amount is above the per-transaction cap.");
  }

  if (input.walletObservation) {
    const gate = citizenWalletPayoutGate(input.walletObservation);
    if (gate.state !== "ready") {
      return fail("rejected", gate.reason);
    }
  }
  const windowId = treasuryWindowId(input.nowMs, input.limits.windowSeconds);
  const decisionId = treasuryDecisionId(draft.tokenId, draft.asset, windowId);
  const sameWindow = input.spent.filter((row) => row.windowId === windowId && row.asset === draft.asset);
  if (sameWindow.some((row) => row.decisionId === decisionId || (row.tokenId === draft.tokenId && row.asset === draft.asset))) {
    return fail("duplicate", "This citizen already has an allocation for that asset in the current window.");
  }
  const citizenSpent = sameWindow.filter((row) => row.tokenId === draft.tokenId).reduce((sum, row) => sum + row.amountRaw, 0n);
  const windowSpent = sameWindow.reduce((sum, row) => sum + row.amountRaw, 0n);
  if (citizenSpent + draft.amountRaw > perCitizen) {
    return fail("budget_exhausted", "The amount is above the per-citizen cap for this window.");
  }
  if (windowSpent + draft.amountRaw > aggregate) {
    return fail("budget_exhausted", "The amount is above the aggregate cap for this window.");
  }

  const balance = draft.asset === "MON" ? input.monBalance : input.chogBalance;
  if (balance != null && balance < draft.amountRaw) {
    return fail("insufficient_funds", "The observed treasury balance is below the requested amount.");
  }

  const nowSec = Math.floor(input.nowMs / 1000);
  const deadline = nowSec + input.limits.maxAuthorizationTtl;
  const parts = [
    input.executionEnabled
      ? "The allocation passes the application review."
      : "Production signing is disabled. This record is not a signature and not a payment.",
    input.walletDeployed
      ? "A deployed citizen wallet was observed for this token id."
      : "No citizen wallet bytecode was observed, so funds are not sent to a predicted address.",
    balance == null ? "The treasury balance was not read." : "The observed balance covers this amount.",
  ];
  return {
    status: input.executionEnabled && input.walletDeployed && balance != null ? "ready_for_signature" : CLOSED,
    reason: parts.join(" "),
    executed: false,
    decisionId,
    reasonHash: treasuryReasonHash(draft.reason),
    deadline,
    windowId,
    onchain: false,
  };
}

export function evaluateProductionTreasuryAllocation(
  input: Omit<Parameters<typeof evaluateTreasuryAllocation>[0], "executionEnabled" | "walletDeployed">,
): AllocationVerdict {
  return evaluateTreasuryAllocation({
    ...input,
    executionEnabled: false,
    walletDeployed: false,
  });
}

export function productionTreasurySubmission(): { broadcast: false; reason: string } {
  return {
    broadcast: false,
    reason: "Production signing and broadcasting stay disabled. No transaction was created.",
  };
}

export function applyAllocations(input: {
  drafts: readonly AllocationDraft[];
  limits: PolicyLimits;
  nowMs: number;
  eligibleTokenIds: ReadonlySet<string>;
  monBalance: bigint | null;
  chogBalance: bigint | null;
  chogDecimals: number | null;
  walletDeployed: boolean;
  executionEnabled: boolean;
}): AllocationVerdict[] {
  const spent: SpendRecord[] = [];
  let mon = input.monBalance;
  let chog = input.chogBalance;
  return input.drafts.map((draft) => {
    const verdict = evaluateTreasuryAllocation({
      draft,
      limits: input.limits,
      nowMs: input.nowMs,
      eligibleTokenIds: input.eligibleTokenIds,
      spent,
      monBalance: mon,
      chogBalance: chog,
      chogDecimals: input.chogDecimals,
      walletDeployed: input.walletDeployed,
      executionEnabled: input.executionEnabled,
    });
    if (verdict.decisionId && verdict.windowId && (verdict.status === "accepted_not_executed" || verdict.status === "ready_for_signature")) {
      spent.push({
        decisionId: verdict.decisionId,
        tokenId: draft.tokenId,
        asset: draft.asset,
        amountRaw: draft.amountRaw,
        windowId: verdict.windowId,
      });
      if (draft.asset === "MON" && mon != null) mon -= draft.amountRaw;
      if (draft.asset === "CHOG" && chog != null) chog -= draft.amountRaw;
    }
    return verdict;
  });
}

export type PayoutReceipt = {
  status: "success" | "reverted" | "missing";
  chainId: number | null;
  txHash: string | null;
  blockNumber: string | null;
  distributedDecisionIds: readonly string[];
};

export type PayoutClassification = {
  status: "confirmed" | "failed" | "pending";
  payout: boolean;
  duplicate: boolean;
  reason: string;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function classifyPayout(receipt: PayoutReceipt, decisionId: string, alreadyConfirmed = false): PayoutClassification {
  if (receipt.status === "missing") {
    return { status: "pending", payout: false, duplicate: false, reason: "No receipt has been read. This is not a payment." };
  }
  if (receipt.status !== "success" || receipt.chainId !== 143 || !receipt.txHash || !HASH.test(receipt.txHash) || !receipt.blockNumber) {
    return {
      status: "failed",
      payout: false,
      duplicate: false,
      reason: "The transaction is not a confirmed Monad mainnet receipt. It is not a payout.",
    };
  }
  if (!receipt.distributedDecisionIds.includes(decisionId)) {
    return {
      status: "failed",
      payout: false,
      duplicate: false,
      reason: "The receipt does not contain this allocation's Distributed event. It is not a payout.",
    };
  }
  return {
    status: "confirmed",
    payout: true,
    duplicate: alreadyConfirmed,
    reason: alreadyConfirmed
      ? "This confirmed payout was already recorded. It was not counted again."
      : "The receipt contains the Distributed event on Monad mainnet.",
  };
}

/** Two overlapping reviews can both look acceptable before either is stored. Only the first decision id is kept. */
export function keepFirstDecision(verdicts: readonly AllocationVerdict[]): AllocationVerdict[] {
  const seen = new Set<string>();
  return verdicts.map((verdict) => {
    if (!verdict.decisionId || (verdict.status !== "accepted_not_executed" && verdict.status !== "ready_for_signature")) {
      return verdict;
    }
    if (seen.has(verdict.decisionId)) {
      return {
        ...verdict,
        status: "duplicate",
        reason: "A concurrent review already admitted this decision id. It was not signed or paid again.",
        executed: false,
        onchain: false,
      };
    }
    seen.add(verdict.decisionId);
    return verdict;
  });
}

export type WalletObservation = {
  codeBytes: number | null;
  wallet: string | null;
  /** True when the deployed wallet's stored token id, NFT contract, and chain match this citizen. */
  identityMatches: boolean | null;
};

export type WalletPayoutState = "unread" | "missing" | "ready" | "inconsistent";

/** Mirrors ChogBank.payoutRecipient. An empty prediction is not a payable wallet. NFT custody is not required. */
export function citizenWalletPayoutGate(input: WalletObservation): { state: WalletPayoutState; reason: string } {
  if (input.codeBytes == null || input.wallet == null || input.identityMatches == null) {
    return { state: "unread", reason: "Wallet code and identity were not read. No payout is authorized from an unread wallet." };
  }
  if (input.codeBytes < 1) {
    return { state: "missing", reason: "The citizen wallet has no code. A predicted address is not a recipient." };
  }
  if (!input.identityMatches) {
    return {
      state: "inconsistent",
      reason: "The contract at that address is not the wallet for this citizen. The bank must not pay it.",
    };
  }
  return {
    state: "ready",
    reason: "The deployed wallet matches this citizen. The NFT holder does not have to custody the NFT, and does not control the wallet.",
  };
}

export function recoveryAction(
  classification: PayoutClassification,
  stored: "absent" | "confirmed" | "other",
): "record_confirmation" | "leave_recorded" | "do_not_record_as_payout" {
  if (!classification.payout || classification.status !== "confirmed") {
    return "do_not_record_as_payout";
  }
  if (stored === "confirmed" || classification.duplicate) {
    return "leave_recorded";
  }
  return "record_confirmation";
}
