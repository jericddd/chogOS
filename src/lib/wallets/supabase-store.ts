import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress, type Address } from "viem";
import { AI_ISSUED_SCHEME, CITIZEN_WALLET_SCHEME } from "@/lib/wallets/authority";
import { planUnassignedWallets, type WalletAssignment, type WalletStatus } from "@/lib/wallets/lifecycle";
import type { SafeVersion } from "@/lib/wallets/infrastructure";
import type { TreasuryVerification } from "@/lib/wallets/lifecycle";
import { mergeFundingRecord } from "@/lib/wallets/funding";
import { isWalletStatus, type StoredBalance, type StoredFunding, type StoredTreasury, type WalletRegistryStore, type WalletStoreResult } from "@/lib/wallets/store";

type DbError = { code?: string; message: string };

function missingTable(error: DbError): boolean {
  return error.code === "PGRST205" || /schema cache|does not exist|could not find the table/i.test(error.message);
}

function fail(error: DbError): { ok: false; reason: "migration_pending" | "unavailable"; detail: string } {
  if (missingTable(error)) {
    return {
      ok: false,
      reason: "migration_pending",
      detail:
        "Phase 2 tables are not in the database yet. In the Supabase SQL editor, run supabase/migrations/20261012220000_phase2_wallets.sql and then 20261012233000_phase2_funding_guards.sql.",
    };
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
      .in("scheme", [AI_ISSUED_SCHEME, CITIZEN_WALLET_SCHEME]);
    if (error) {
      return fail(error);
    }
    const rows = data ?? [];
    const issued = rows.find((row) => row.scheme === AI_ISSUED_SCHEME);
    const plain = rows.find((row) => row.scheme === CITIZEN_WALLET_SCHEME);
    const chosen = issued ?? plain ?? null;
    return { ok: true, value: chosen ? this.toAssignment(chosen) : null };
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
    const normalized = normalizeFunding(input);
    const lookup = this.client
      .from("treasury_funding")
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .eq("chain_id", normalized.chainId)
      .eq("tx_hash", normalized.txHash)
      .eq("asset_kind", normalized.assetKind);
    const existing = await (normalized.tokenAddress
      ? lookup.eq("token_address", normalized.tokenAddress)
      : lookup.is("token_address", null)
    ).maybeSingle();
    if (existing.error) {
      return fail(existing.error);
    }
    if (existing.data) {
      return this.upgradeFunding(this.toFunding(existing.data), normalized);
    }

    const { data, error } = await this.client
      .from("treasury_funding")
      .insert({
        treasury_id: normalized.treasuryId,
        chain_id: normalized.chainId,
        asset_kind: normalized.assetKind,
        token_address: normalized.tokenAddress,
        symbol: normalized.symbol,
        decimals: normalized.decimals,
        tx_hash: normalized.txHash,
        sender: normalized.sender,
        recipient: normalized.recipient,
        amount_raw: normalized.amountRaw,
        block_number: normalized.blockNumber,
        status: normalized.status,
        detail: normalized.detail,
        verified_at: normalized.verifiedAt,
      })
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        const again = await this.listFunding(normalized.chainId);
        if (!again.ok) {
          return again;
        }
        const found = again.value.find(
          (row) =>
            row.txHash.toLowerCase() === normalized.txHash &&
            row.assetKind === normalized.assetKind &&
            (row.tokenAddress ?? "").toLowerCase() === (normalized.tokenAddress ?? "").toLowerCase(),
        );
        if (found) {
          return this.upgradeFunding(found, normalized);
        }
      }
      return fail(error);
    }
    return { ok: true, value: this.toFunding(data) };
  }

  private async upgradeFunding(
    current: StoredFunding,
    incoming: Omit<StoredFunding, "id"> & { treasuryId: string },
  ): Promise<WalletStoreResult<StoredFunding>> {
    const merged = mergeFundingRecord(current, { ...current, ...incoming, id: current.id });
    if (merged === current) {
      return { ok: true, value: current };
    }
    const { data, error } = await this.client
      .from("treasury_funding")
      .update({
        symbol: merged.symbol,
        decimals: merged.decimals,
        sender: merged.sender,
        recipient: merged.recipient,
        amount_raw: merged.amountRaw,
        block_number: merged.blockNumber,
        status: merged.status,
        detail: merged.detail,
        verified_at: merged.verifiedAt,
      })
      .eq("id", current.id)
      .select("id, chain_id, asset_kind, token_address, symbol, decimals, tx_hash, sender, recipient, amount_raw, block_number, status, detail, verified_at")
      .single();
    if (error) {
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
      scheme: row.scheme === AI_ISSUED_SCHEME ? AI_ISSUED_SCHEME : CITIZEN_WALLET_SCHEME,
      status: row.scheme === CITIZEN_WALLET_SCHEME || row.scheme === AI_ISSUED_SCHEME ? status : "failed",
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
      amountRaw: wholeInteger(row.amount_raw),
      blockNumber: wholeInteger(row.block_number),
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
      amountRaw: wholeInteger(row.amount_raw) ?? String(row.amount_raw),
      blockNumber: wholeInteger(row.block_number) ?? String(row.block_number),
      observedAt: String(row.observed_at),
    };
  }
}

function wholeInteger(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const whole = String(value).split(".")[0] ?? "";
  return /^\d+$/.test(whole) ? whole : null;
}

function normalizeFunding(input: Omit<StoredFunding, "id"> & { treasuryId: string }) {
  return {
    ...input,
    txHash: input.txHash.toLowerCase(),
    tokenAddress: input.tokenAddress ? getAddress(input.tokenAddress) : null,
  };
}

export function checksum(value: string): Address {
  return getAddress(value);
}
