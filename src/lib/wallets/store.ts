import type { Address } from "viem";
import type { WalletAssignment, WalletStatus } from "@/lib/wallets/lifecycle";
import type { FundingStatus } from "@/lib/wallets/funding";
import type { TreasuryVerification } from "@/lib/wallets/lifecycle";
import type { SafeVersion } from "@/lib/wallets/infrastructure";

export type StoredTreasury = {
  id: string;
  chainId: 143 | 10143;
  address: Address | null;
  status: "not_configured" | "configured" | "failed";
  accountType: "unknown" | "eoa" | "contract";
  verification: TreasuryVerification;
  safeVersion: SafeVersion | null;
  codeHash: string | null;
  detail: string | null;
  configuredAt: string | null;
};

export type StoredFunding = {
  id: string;
  chainId: 143 | 10143;
  assetKind: "native" | "erc20" | "unknown";
  tokenAddress: string | null;
  symbol: string;
  decimals: number | null;
  txHash: string;
  sender: string | null;
  recipient: string | null;
  amountRaw: string | null;
  blockNumber: string | null;
  status: FundingStatus;
  detail: string | null;
  verifiedAt: string | null;
};

export type StoredBalance = {
  assetKey: string;
  symbol: string;
  decimals: number;
  amountRaw: string;
  blockNumber: string;
  observedAt: string;
};

export type WalletStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "migration_pending" | "unavailable"; detail: string };

export interface WalletRegistryStore {
  listAssignments(): Promise<WalletStoreResult<WalletAssignment[]>>;
  ensureUnassigned(citizens: Array<{ id: string; chainId: 143 | 10143 }>): Promise<WalletStoreResult<{ created: number; unchanged: number }>>;
  findAssignment(citizenId: string, chainId: 143 | 10143): Promise<WalletStoreResult<WalletAssignment | null>>;
  getTreasury(chainId: 143 | 10143): Promise<WalletStoreResult<StoredTreasury | null>>;
  saveTreasury(input: Omit<StoredTreasury, "id"> & { id?: string }): Promise<WalletStoreResult<StoredTreasury>>;
  listFunding(chainId: 143 | 10143): Promise<WalletStoreResult<StoredFunding[]>>;
  saveFunding(input: Omit<StoredFunding, "id"> & { treasuryId: string }): Promise<WalletStoreResult<StoredFunding>>;
  latestBalances(treasuryId: string): Promise<WalletStoreResult<StoredBalance[]>>;
  saveBalance(input: StoredBalance & { treasuryId: string }): Promise<WalletStoreResult<StoredBalance>>;
}

export function isWalletStatus(value: string): value is WalletStatus {
  return (
    value === "not_configured" ||
    value === "pending" ||
    value === "address_predicted" ||
    value === "deployment_pending" ||
    value === "deployed" ||
    value === "verified" ||
    value === "failed"
  );
}
