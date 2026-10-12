import "server-only";
import { getAddress, type Address, type Hash } from "viem";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { readAppConfig } from "@/lib/config/env";
import { treasuryAddressProblem } from "@/lib/wallets/authority";
import { readBalances, readCode, readFunding, readMasterCopy } from "@/lib/wallets/chain";
import { assessTreasuryCode } from "@/lib/wallets/lifecycle";
import { openWalletStore } from "@/lib/wallets/open-store";
import type { StoredBalance, StoredFunding, StoredTreasury, WalletStoreResult } from "@/lib/wallets/store";

export async function ensureCitizenWallets(): Promise<
  WalletStoreResult<{ created: number; unchanged: number }>
> {
  const wallets = openWalletStore();
  const citizens = openCivilizationStore();
  if (!wallets || !citizens) {
    return { ok: false, reason: "unavailable", detail: "Supabase is not configured." };
  }
  const rows = await citizens.listCitizens();
  return wallets.ensureUnassigned(rows.map((row) => ({ id: row.id, chainId: row.chainId })));
}

export async function configureCivilizationTreasury(rawAddress: string): Promise<
  WalletStoreResult<StoredTreasury> | { ok: false; reason: "rejected"; detail: string }
> {
  const config = readAppConfig();
  const problem = treasuryAddressProblem(rawAddress, {
    chogTreasury: config.chogTreasuryAddress,
    nft: config.chogNftAddress,
    token: config.chogTokenAddress,
  });
  if (problem) {
    return { ok: false, reason: "rejected", detail: problem };
  }
  const store = openWalletStore();
  if (!store) {
    return { ok: false, reason: "unavailable", detail: "Supabase is not configured." };
  }
  const address = getAddress(rawAddress);
  const code = await readCode(config.chainId, address, config.rpcUrl);
  if (code.error) {
    return { ok: false, reason: "unavailable", detail: code.error };
  }
  const masterCopy = code.empty ? null : await readMasterCopy(config.chainId, address, config.rpcUrl);
  const assessed = assessTreasuryCode({ codeEmpty: code.empty, masterCopy });
  const now = new Date().toISOString();
  return store.saveTreasury({
    chainId: config.chainId,
    address,
    status: "configured",
    accountType: assessed.accountType,
    verification: assessed.verification,
    safeVersion: assessed.safeVersion,
    codeHash: code.hash,
    detail: assessed.detail,
    configuredAt: now,
  });
}

export async function verifyTreasuryFunding(rawHash: string): Promise<
  WalletStoreResult<StoredFunding[]> | { ok: false; reason: "rejected"; detail: string }
> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
    return { ok: false, reason: "rejected", detail: "Transaction hash must be 32 bytes of hexadecimal." };
  }
  const config = readAppConfig();
  const store = openWalletStore();
  if (!store) {
    return { ok: false, reason: "unavailable", detail: "Supabase is not configured." };
  }
  const treasury = await store.getTreasury(config.chainId);
  if (!treasury.ok) {
    return treasury;
  }
  if (!treasury.value?.address || treasury.value.status !== "configured") {
    return { ok: false, reason: "rejected", detail: "Configure the civilization treasury before verifying a funding transaction." };
  }
  const legs = await readFunding({
    chainId: config.chainId,
    txHash: rawHash as Hash,
    treasury: treasury.value.address,
    chogToken: config.chogTokenAddress,
    rpcUrl: config.rpcUrl,
  });
  const now = new Date().toISOString();
  const saved: StoredFunding[] = [];
  for (const leg of legs) {
    const row = await store.saveFunding({
      treasuryId: treasury.value.id,
      chainId: config.chainId,
      assetKind: leg.assetKind,
      tokenAddress: leg.tokenAddress,
      symbol: leg.symbol,
      decimals: leg.decimals,
      txHash: rawHash,
      sender: leg.sender,
      recipient: leg.recipient,
      amountRaw: leg.amountRaw,
      blockNumber: leg.blockNumber,
      status: leg.status,
      detail: leg.detail,
      verifiedAt: leg.status === "confirmed" || leg.status === "reverted" || leg.status === "failed" ? now : null,
    });
    if (!row.ok) {
      return row;
    }
    saved.push(row.value);
  }
  return { ok: true, value: saved };
}

export async function readTreasuryBalances(treasury: StoredTreasury): Promise<
  | { state: "unconfigured" }
  | { state: "unavailable"; detail: string; lastKnown: StoredBalance[] }
  | { state: "live"; blockNumber: string; observedAt: string; native: StoredBalance; chog: StoredBalance | { unavailable: string } }
> {
  if (!treasury.address || treasury.status !== "configured") {
    return { state: "unconfigured" };
  }
  const store = openWalletStore();
  const config = readAppConfig();
  const last = store ? await store.latestBalances(treasury.id) : { ok: true as const, value: [] as StoredBalance[] };
  const lastKnown = last.ok ? last.value : [];
  const live = await readBalances({
    chainId: config.chainId,
    treasury: treasury.address,
    chogToken: config.chogTokenAddress,
    rpcUrl: config.rpcUrl,
  });
  if (!live.ok || !live.native) {
    return {
      state: "unavailable",
      detail: live.ok ? "Native balance was not returned." : live.detail,
      lastKnown,
    };
  }
  const native: StoredBalance = {
    assetKey: "native",
    symbol: "MON",
    decimals: 18,
    amountRaw: live.native.amountRaw,
    blockNumber: live.blockNumber,
    observedAt: live.observedAt,
  };
  if (store) {
    await store.saveBalance({ ...native, treasuryId: treasury.id });
  }
  if (live.chog && "amountRaw" in live.chog && store) {
    await store.saveBalance({
      treasuryId: treasury.id,
      assetKey: config.chogTokenAddress,
      symbol: "CHOG",
      decimals: live.chog.decimals,
      amountRaw: live.chog.amountRaw,
      blockNumber: live.blockNumber,
      observedAt: live.observedAt,
    });
  }
  return {
    state: "live",
    blockNumber: live.blockNumber,
    observedAt: live.observedAt,
    native,
    chog:
      live.chog && "amountRaw" in live.chog
        ? {
            assetKey: config.chogTokenAddress,
            symbol: "CHOG",
            decimals: live.chog.decimals,
            amountRaw: live.chog.amountRaw,
            blockNumber: live.blockNumber,
            observedAt: live.observedAt,
          }
        : { unavailable: live.chog && "unavailable" in live.chog ? live.chog.unavailable : "Token balance was not read." },
  };
}

export function configuredAddress(treasury: StoredTreasury | null): Address | null {
  return treasury?.address ?? null;
}
