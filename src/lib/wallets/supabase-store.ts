import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress, type Address } from "viem";
import { CITIZEN_WALLET_SCHEME } from "@/lib/wallets/authority";
import { planUnassignedWallets, type WalletAssignment, type WalletStatus } from "@/lib/wallets/lifecycle";
import type { SafeVersion } from "@/lib/wallets/infrastructure";
import type { TreasuryVerification } from "@/lib/wallets/lifecycle";
import { isWalletStatus, type StoredBalance, type StoredFunding, type StoredTreasury, type WalletRegistryStore, type WalletStoreResult } from "@/lib/wallets/store";

type DbError = { code?: string; message: string };

function missingTable(error: DbError): boolean {
  return error.code === "PGRST205" || /schema cache|does not exist|could not find the table/i.test(error.message);
}

function fail(error: DbError): { ok: false; reason: "migration_pending" | "unavailable"; detail: string } {
  if (missingTable(error)) {
    return { ok: false, reason: "migration_pending", detail: "Phase 2 tables are not in the database yet." };
  }
  return { ok: false, reason: "unavailable", detail: error.message.slice(0, 300) };
}

function chainId(value: number): 143 | 10143 {
  if (value === 143 || value === 10143) {
    return value;
  }
  throw new Error("A wallet row has an unsupported chain id.");
}

export class SupabaseWalletStore implements WalletRegistryStore {
  constructor(private readonly client: SupabaseClient) {}

  async listAssignments(): Promise<WalletStoreResult<WalletAssignment[]>> {
    const { data, error } = await this.client
      .from("citizen_wallet_registry")
      .select("citizen_id, chain_id, scheme, status, predicted_address, account_address");
    if (error) {
      return fail(error);
    }
    return {
      ok: true,
      value: (data ?? []).map((row) => this.toAssignment(row)),
    };
  }

  async ensureUnassigned(
    citizens: Array<{ id: string; chainId: 143 | 10143 }>,
  ): Promise<WalletStoreResult<{ created: number; unchanged: number }>> {
    const existing = await this.listAssignments();
    if (!existing.ok) {
      return existing;
    }
    const plan = planUnassignedWallets({ citizens, existing: existing.value });
    if (plan.creates.length === 0) {
      return { ok: true, value: { created: 0, unchanged: plan.unchanged } };
    }
    const { error } = await this.client.from("citizen_wallet_registry").upsert(
      plan.creates.map((row) => ({
        citizen_id: row.citizenId,
        chain_id: row.chainId,
        scheme: row.scheme,
        status: row.status,
        account_type: "none",
      })),
      { onConflict: "citizen_id,chain_id,scheme", ignoreDuplicates: true },
    );
    if (error) {
      if (error.code === "23505") {
        return { ok: true, value: { created: 0, unchanged: citizens.length } };
      }
      return fail(error);
    }
    return { ok: true, value: { created: plan.creates.length, unchanged: plan.unchanged } };
  }

  async findAssignment(
    citizenId: string,
    targetChain: 143 | 10143,
  ): Promise<WalletStoreResult<WalletAssignment | null>> {
    const { data, error } = await this.client
      .from("citizen_wallet_registry")
      .select("citizen_id, chain_id, scheme, status, predicted_address, account_address")
      .eq("citizen_id", citizenId)
      .eq("chain_id", targetChain)
      .eq("scheme", CITIZEN_WALLET_SCHEME)
      .maybeSingle();
    if (error) {
      return fail(error);
    }
    return { ok: true, value: data ? this.toAssignment(data) : null };
  }

  async getTreasury(targetChain: 143 | 10143): Promise<WalletStoreResult<StoredTreasury | null>> {
    const { data, error } = await this.client
      .from("civilization_treasuries")
      .select("id, chain_id, address, status, account_type, verification, safe_version, code_hash, detail, configured_at")
      .eq("chain_id", targetChain)
      .maybeSingle();
    if (error) {
      return fail(error);
    }
    return { ok: true, value: data ? this.toTreasury(data) : null };
  }

  async saveTreasury(input: Omit<StoredTreasury, "id"> & { id?: string }): Promise<WalletStoreResult<StoredTreasury>> {
    const existing = await this.getTreasury(input.chainId);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value?.address && input.address && existing.value.address.toLowerCase() !== input.address.toLowerCase()) {
      return { ok: false, reason: "unavailable", detail: "treasury address cannot be replaced" };
    }
    const row = {
      chain_id: input.chainId,
      address: input.address,
      status: input.status,
      account_type: input.accountType,
      verification: input.verification,
      safe_version: input.safeVersion,
      code_hash: input.codeHash,
      detail: input.detail,
      configured_at: input.configuredAt,
      verified_at: input.verification === "safe_proxy" ? input.configuredAt : null,
    };
    if (!existing.value) {
      const { data, error } = await this.client.from("civilization_treasuries").insert(row).select("id, chain_id, address, status, account_type, verification, safe_version, code_hash, detail, configured_at").single();
      if (error) {
        return fail(error);
      }
      return { ok: true, value: this.toTreasury(data) };
    }
    const { data, error } = await this.client
      .from("civilization_treasuries")
      .update(row)
      .eq("id", existing.value.id)
      .select("id, chain_id, address, status, account_type, verification, safe_version, code_hash, detail, configured_at")
      .single();
    if (error) {
      return fail(error);
    }
    return { ok: true, value: this.toTreasury(data) };
  }

  async listFunding(targetChain: 143 | 10143): Promise<WalletStoreResult<StoredFunding[]>> {
    const { data, error } = await this.client
      .from("treasury_funding")
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .eq("chain_id", targetChain)
      .order("created_at", { ascending: false })
      .limit(40);
    if (error) {
      return fail(error);
    }
    return { ok: true, value: (data ?? []).map((row) => this.toFunding(row)) };
  }

  async saveFunding(input: Omit<StoredFunding, "id"> & { treasuryId: string }): Promise<WalletStoreResult<StoredFunding>> {
    const lookup = this.client
      .from("treasury_funding")
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .eq("chain_id", input.chainId)
      .eq("tx_hash", input.txHash)
      .eq("asset_kind", input.assetKind);
    const existing = await (input.tokenAddress ? lookup.eq("token_address", input.tokenAddress) : lookup.is("token_address", null)).maybeSingle();
    if (existing.error) {
      return fail(existing.error);
    }
    if (existing.data) {
      return { ok: true, value: this.toFunding(existing.data) };
    }

    const { data, error } = await this.client
      .from("treasury_funding")
      .insert({
        treasury_id: input.treasuryId,
        chain_id: input.chainId,
        asset_kind: input.assetKind,
        token_address: input.tokenAddress,
        symbol: input.symbol,
        decimals: input.decimals,
        tx_hash: input.txHash,
        sender: input.sender,
        recipient: input.recipient,
        amount_raw: input.amountRaw,
        block_number: input.blockNumber,
        status: input.status,
        detail: input.detail,
        verified_at: input.verifiedAt,
      })
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        const again = await this.listFunding(input.chainId);
        if (!again.ok) {
          return again;
        }
        const found = again.value.find(
          (row) =>
            row.txHash.toLowerCase() === input.txHash.toLowerCase() &&
            row.assetKind === input.assetKind &&
            (row.tokenAddress ?? "") === (input.tokenAddress ?? ""),
        );
        if (found) {
          return { ok: true, value: found };
        }
      }
      return fail(error);
    }
    return { ok: true, value: this.toFunding(data) };
  }

  async latestBalances(treasuryId: string): Promise<WalletStoreResult<StoredBalance[]>> {
    const { data, error } = await this.client
      .from("treasury_balance_readings")
      .select("asset_key, symbol, decimals, amount_raw, block_number, observed_at")
      .eq("treasury_id", treasuryId)
      .order("observed_at", { ascending: false })
      .limit(20);
    if (error) {
      return fail(error);
    }
    const latest = new Map<string, StoredBalance>();
    for (const row of data ?? []) {
      if (!latest.has(row.asset_key)) {
        latest.set(String(row.asset_key), this.toBalance(row));
      }
    }
    return { ok: true, value: [...latest.values()] };
  }

  async saveBalance(input: StoredBalance & { treasuryId: string }): Promise<WalletStoreResult<StoredBalance>> {
    const { error } = await this.client.from("treasury_balance_readings").insert({
      treasury_id: input.treasuryId,
      asset_key: input.assetKey,
      symbol: input.symbol,
      decimals: input.decimals,
      amount_raw: input.amountRaw,
      block_number: input.blockNumber,
      observed_at: input.observedAt,
      source: "rpc",
    });
    if (error) {
      return fail(error);
    }
    return { ok: true, value: input };
  }

  private toAssignment(row: {
    citizen_id: string;
    chain_id: number;
    scheme: string;
    status: string;
    predicted_address: string | null;
    account_address: string | null;
  }): WalletAssignment {
    const status: WalletStatus = isWalletStatus(row.status) ? row.status : "failed";
    return {
      citizenId: String(row.citizen_id),
      chainId: chainId(row.chain_id),
      scheme: CITIZEN_WALLET_SCHEME,
      status: row.scheme === CITIZEN_WALLET_SCHEME ? status : "failed",
      predictedAddress: row.predicted_address,
      accountAddress: row.account_address,
    };
  }

  private toTreasury(row: {
    id: string;
    chain_id: number;
    address: string | null;
    status: string;
    account_type: string;
    verification: string;
    safe_version: string | null;
    code_hash: string | null;
    detail: string | null;
    configured_at: string | null;
  }): StoredTreasury {
    const status = row.status === "configured" || row.status === "failed" ? row.status : "not_configured";
    const accountType = row.account_type === "eoa" || row.account_type === "contract" ? row.account_type : "unknown";
    const verification: TreasuryVerification =
      row.verification === "observed" || row.verification === "safe_proxy" ? row.verification : "unread";
    return {
      id: String(row.id),
      chainId: chainId(row.chain_id),
      address: row.address ? getAddress(row.address) : null,
      status,
      accountType,
      verification,
      safeVersion: (row.safe_version as SafeVersion | null) ?? null,
      codeHash: row.code_hash,
      detail: row.detail,
      configuredAt: row.configured_at,
    };
  }

  private toFunding(row: {
    id: string;
    chain_id: number;
    asset_kind: string;
    token_address: string | null;
    symbol: string;
    decimals: number | null;
    tx_hash: string;
    sender: string | null;
    recipient: string | null;
    amount_raw: string | number | null;
    block_number: string | number | null;
    status: StoredFunding["status"];
    detail: string | null;
    verified_at: string | null;
  }): StoredFunding {
    const assetKind = row.asset_kind === "native" || row.asset_kind === "erc20" ? row.asset_kind : "unknown";
    return {
      id: String(row.id),
      chainId: chainId(row.chain_id),
      assetKind,
      tokenAddress: row.token_address,
      symbol: String(row.symbol),
      decimals: row.decimals,
      txHash: String(row.tx_hash),
      sender: row.sender,
      recipient: row.recipient,
      amountRaw: row.amount_raw === null || row.amount_raw === undefined ? null : String(row.amount_raw).split(".")[0] ?? null,
      blockNumber: row.block_number === null || row.block_number === undefined ? null : String(row.block_number).split(".")[0] ?? null,
      status: row.status,
      detail: row.detail,
      verifiedAt: row.verified_at,
    };
  }

  private toBalance(row: {
    asset_key: string;
    symbol: string;
    decimals: number;
    amount_raw: string | number;
    block_number: string | number;
    observed_at: string;
  }): StoredBalance {
    return {
      assetKey: String(row.asset_key),
      symbol: String(row.symbol),
      decimals: Number(row.decimals),
      amountRaw: String(row.amount_raw).split(".")[0] ?? "0",
      blockNumber: String(row.block_number).split(".")[0] ?? "0",
      observedAt: String(row.observed_at),
    };
  }
}

export function checksum(value: string): Address {
  return getAddress(value);
}
