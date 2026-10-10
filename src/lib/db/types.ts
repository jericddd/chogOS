/**
 * Row shapes for the initial schema in supabase/migrations.
 * The SQL migration is the source of truth. Regenerate types from Supabase
 * after the project exists; do not treat these as a live database connection.
 *
 * Amounts are raw integer strings. A row in balance_observations is a past
 * reading at a block, not a current spendable balance.
 */

export type EnrollmentStatus = "pending" | "active" | "suspended" | "withdrawn";
export type LifeStatus = "unknown" | "active" | "away" | "inactive";
export type WalletKind = "citizen" | "business" | "treasury";

export type CitizenRow = {
  id: string;
  chain_id: 143 | 10143;
  nft_contract: string;
  token_id: string;
  enrollment_status: EnrollmentStatus;
  observed_owner: string | null;
  ownership_observed_block: number | null;
  ownership_observed_at: string | null;
  enrolled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WalletRow = {
  id: string;
  chain_id: 143 | 10143;
  address: string;
  kind: WalletKind;
  citizen_id: string | null;
  business_id: string | null;
  factory_address: string | null;
  deployment_tx_hash: string | null;
  deployed_at: string | null;
};

export type BalanceObservationRow = {
  id: string;
  wallet_id: string;
  asset_key: string;
  amount_raw: string;
  block_number: number;
  observed_at: string;
  source: "rpc";
};

export type BusinessLedgerRow = {
  id: string;
  business_id: string;
  summary: string;
  amount_raw: string | null;
  is_onchain_verified: boolean;
  receipt_id: string | null;
};
