import type { Address, Hex } from "viem";

export const ACTIVATION_STATES = [
  "unassigned",
  "activation_requested",
  "awaiting_bank_approval",
  "predicted",
  "deployment_pending",
  "deployed",
  "authorization_pending",
  "active",
  "rejected",
  "deferred",
  "error",
] as const;

export type ActivationState = (typeof ACTIVATION_STATES)[number];

export const ACTIVATION_MOTIVES = [
  "start_business",
  "trade_asset",
  "payment",
  "economic_opportunity",
] as const;

export type ActivationMotive = (typeof ACTIVATION_MOTIVES)[number];

export type LedgerBucket =
  | "treasury_balance"
  | "gas_reserved"
  | "gas_available"
  | "deployment_spent"
  | "sponsored_gas_spent"
  | "business_capital"
  | "citizen_earnings"
  | "treasury_returns"
  | "outstanding_capital"
  | "realized_losses";

export type ObservedTreasury = {
  configured: boolean;
  chainId: 143;
  availableWei: bigint;
  reservedWei: bigint;
  source: "unset" | "observed" | "injected";
};

export type BankLimits = {
  maxActivationWei: bigint;
  maxTxWei: bigint;
  maxDailyGasWei: bigint;
  maxTreasuryExposureWei: bigint;
};

export type ActivationRequest = {
  id: string;
  citizenId: string;
  tokenId: string;
  chainId: 143;
  nftContract: Address;
  motive: ActivationMotive;
  goal: string;
  proposedActions: string;
  revenueHypothesis: string;
  estimatedDeploymentWei: bigint;
  estimatedGasWei: bigint;
  decisionId: string | null;
  state: ActivationState;
  predictedAddress: Address | null;
  accountAddress: Address | null;
  reservationId: string | null;
  rejectReason: string | null;
  createdAt: string;
};

export type Reservation = {
  id: string;
  requestId: string;
  bucket: "gas" | "deployment" | "business_capital";
  amountWei: bigint;
  state: "held" | "reconciled" | "released";
};

export const RELAYER_OPS = ["factory.create", "account.executeSession", "account.invalidateSession"] as const;

export type RelayerOp = (typeof RELAYER_OPS)[number];

export type SponsoredJob = {
  id: string;
  requestId: string;
  idempotencyKey: string;
  op: RelayerOp;
  target: Address;
  selector: Hex;
  valueWei: bigint;
  estimatedGasWei: bigint;
  state: "queued" | "submitted" | "confirmed" | "reverted" | "failed";
  txHash: Hex | null;
  gasUsedWei: bigint | null;
  failureReason: string | null;
};

export type LedgerEntry = {
  id: string;
  bucket: LedgerBucket;
  deltaWei: bigint;
  ref: string;
  at: string;
};

export type SessionPolicy = {
  executor: Address;
  ownerAtOpen: Address;
  target: Address;
  selector: Hex;
  maxValuePerCall: bigint;
  maxCumulativeValue: bigint;
  spent: bigint;
  expiresAt: number;
  openedBlock: bigint;
  nonce: bigint;
  dead: boolean;
  paused: boolean;
};

export type TransferLog = {
  blockNumber: bigint;
  from: Address;
  to: Address;
};
