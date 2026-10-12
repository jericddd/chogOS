import { getAddress, type Address } from "viem";
import { mergeFundingRecord } from "@/lib/wallets/funding";
import { planUnassignedWallets, type WalletAssignment } from "@/lib/wallets/lifecycle";
import type {
  StoredBalance,
  StoredFunding,
  StoredTreasury,
  WalletRegistryStore,
  WalletStoreResult,
} from "@/lib/wallets/store";

function ok<T>(value: T): WalletStoreResult<T> {
  return { ok: true, value };
}

export class MemoryWalletStore implements WalletRegistryStore {
  assignments: WalletAssignment[] = [];
  treasuries: StoredTreasury[] = [];
  funding: Array<StoredFunding & { treasuryId: string }> = [];
  balances: Array<StoredBalance & { treasuryId: string }> = [];
  failNext: "migration_pending" | "unavailable" | null = null;

  private gate<T>(value: T): WalletStoreResult<T> {
    if (this.failNext) {
      const reason = this.failNext;
      this.failNext = null;
      return { ok: false, reason, detail: reason };
    }
    return ok(value);
  }

  async listAssignments() {
    return this.gate(this.assignments.map((row) => ({ ...row })));
  }

  async ensureUnassigned(citizens: Array<{ id: string; chainId: 143 | 10143 }>) {
    const plan = planUnassignedWallets({ citizens, existing: this.assignments });
    this.assignments.push(...plan.creates);
    return this.gate({ created: plan.creates.length, unchanged: plan.unchanged });
  }

  async findAssignment(citizenId: string, chainId: 143 | 10143) {
    return this.gate(
      this.assignments.find((row) => row.citizenId === citizenId && row.chainId === chainId) ?? null,
    );
  }

  async getTreasury(chainId: 143 | 10143) {
    return this.gate(this.treasuries.find((row) => row.chainId === chainId) ?? null);
  }

  async saveTreasury(input: Omit<StoredTreasury, "id"> & { id?: string }): Promise<WalletStoreResult<StoredTreasury>> {
    const existing = this.treasuries.find((row) => row.chainId === input.chainId);
    if (existing?.address && input.address && existing.address.toLowerCase() !== input.address.toLowerCase()) {
      return { ok: false, reason: "unavailable", detail: "treasury address cannot be replaced" } as const;
    }
    if (existing) {
      existing.address = input.address ?? existing.address;
      existing.status = input.status;
      existing.accountType = input.accountType;
      existing.verification = input.verification;
      existing.safeVersion = input.safeVersion;
      existing.codeHash = input.codeHash;
      existing.detail = input.detail;
      existing.configuredAt = input.configuredAt;
      return this.gate(existing);
    }
    const created: StoredTreasury = {
      id: input.id ?? `treasury-${input.chainId}`,
      chainId: input.chainId,
      address: input.address,
      status: input.status,
      accountType: input.accountType,
      verification: input.verification,
      safeVersion: input.safeVersion,
      codeHash: input.codeHash,
      detail: input.detail,
      configuredAt: input.configuredAt,
    };
    this.treasuries.push(created);
    return this.gate(created);
  }

  async listFunding(chainId: 143 | 10143) {
    return this.gate(
      this.funding
        .filter((row) => row.chainId === chainId)
        .map((row) => ({
          id: row.id,
          chainId: row.chainId,
          assetKind: row.assetKind,
          tokenAddress: row.tokenAddress,
          symbol: row.symbol,
          decimals: row.decimals,
          txHash: row.txHash,
          sender: row.sender,
          recipient: row.recipient,
          amountRaw: row.amountRaw,
          blockNumber: row.blockNumber,
          status: row.status,
          detail: row.detail,
          verifiedAt: row.verifiedAt,
        })),
    );
  }

  async saveFunding(input: Omit<StoredFunding, "id"> & { treasuryId: string }) {
    const txHash = input.txHash.toLowerCase();
    const tokenAddress = input.tokenAddress?.toLowerCase() ?? null;
    const existing = this.funding.find(
      (row) =>
        row.chainId === input.chainId &&
        row.txHash.toLowerCase() === txHash &&
        row.assetKind === input.assetKind &&
        (row.tokenAddress ?? "").toLowerCase() === (tokenAddress ?? ""),
    );
    if (existing) {
      const merged = mergeFundingRecord(existing, { ...existing, ...input, txHash, tokenAddress });
      existing.status = merged.status;
      existing.amountRaw = merged.amountRaw;
      existing.sender = merged.sender;
      existing.recipient = merged.recipient;
      existing.blockNumber = merged.blockNumber;
      existing.detail = merged.detail;
      existing.verifiedAt = merged.verifiedAt;
      existing.symbol = merged.symbol;
      existing.decimals = merged.decimals;
      return this.listFunding(input.chainId).then((rows) => {
        if (!rows.ok) {
          return rows;
        }
        const found = rows.value.find((row) => row.id === existing.id);
        return found ? ok(found) : { ok: false as const, reason: "unavailable" as const, detail: "Missing funding row." };
      });
    }
    const created = { ...input, txHash, tokenAddress, id: `funding-${this.funding.length + 1}` };
    this.funding.push(created);
    return ok({
      id: created.id,
      chainId: created.chainId,
      assetKind: created.assetKind,
      tokenAddress: created.tokenAddress,
      symbol: created.symbol,
      decimals: created.decimals,
      txHash: created.txHash,
      sender: created.sender,
      recipient: created.recipient,
      amountRaw: created.amountRaw,
      blockNumber: created.blockNumber,
      status: created.status,
      detail: created.detail,
      verifiedAt: created.verifiedAt,
    });
  }

  async latestBalances(treasuryId: string) {
    const rows = this.balances.filter((row) => row.treasuryId === treasuryId);
    const latest = new Map<string, StoredBalance>();
    for (const row of rows) {
      latest.set(row.assetKey, row);
    }
    return this.gate([...latest.values()]);
  }

  async saveBalance(input: StoredBalance & { treasuryId: string }) {
    this.balances.push(input);
    return this.gate(input);
  }
}

export function asAddress(value: string): Address {
  return getAddress(value);
}
