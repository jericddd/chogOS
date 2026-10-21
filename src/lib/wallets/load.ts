import "server-only";
import { loadLatestIssuance } from "@/lib/ai/wallet-db";
import { readAppConfig } from "@/lib/config/env";
import { openEconomyClient } from "@/lib/economy/db";
import { openWalletStore } from "@/lib/wallets/open-store";
import {
  citizenWalletWorldLine,
  presentCitizenWallet,
  presentCivilizationTreasury,
  type BalanceReading,
  type CitizenIssuanceView,
  type CitizenWalletView,
  type CivilizationTreasuryView,
} from "@/lib/wallets/present";
import { readTreasuryBalances } from "@/lib/wallets/service";
import type { StoredBalance, StoredTreasury } from "@/lib/wallets/store";

export async function loadCivilizationTreasury(): Promise<CivilizationTreasuryView> {
  const config = readAppConfig();
  const chogTreasury = config.chogTreasuryAddress;
  const store = openWalletStore();
  if (!store) {
    return presentCivilizationTreasury({
      chainId: config.chainId,
      chogTreasury,
      persistence: "not_persisted",
      treasury: null,
      native: { state: "unconfigured" },
      chog: { state: "unconfigured" },
      funding: [],
    });
  }

  const treasury = await store.getTreasury(config.chainId);
  if (!treasury.ok) {
    return presentCivilizationTreasury({
      chainId: config.chainId,
      chogTreasury,
      persistence: treasury.reason === "migration_pending" ? "migration_pending" : "unavailable",
      persistenceDetail: treasury.detail,
      treasury: null,
      native: { state: "unconfigured" },
      chog: { state: "unconfigured" },
      funding: [],
    });
  }

  const funding = await store.listFunding(config.chainId);
  const readings = treasury.value ? await balanceReadings(treasury.value) : { native: { state: "unconfigured" as const }, chog: { state: "unconfigured" as const } };
  return presentCivilizationTreasury({
    chainId: config.chainId,
    chogTreasury,
    persistence: "ready",
    treasury: treasury.value,
    native: readings.native,
    chog: readings.chog,
    funding: funding.ok ? funding.value : [],
    fundingNote: funding.ok ? null : funding.detail,
  });
}

async function balanceReadings(treasury: StoredTreasury): Promise<{ native: BalanceReading; chog: BalanceReading }> {
  if (!treasury.address || treasury.status !== "configured") {
    return { native: { state: "unconfigured" }, chog: { state: "unconfigured" } };
  }
  const live = await readTreasuryBalances(treasury);
  if (live.state === "unconfigured") {
    return { native: { state: "unconfigured" }, chog: { state: "unconfigured" } };
  }
  if (live.state === "unavailable") {
    return {
      native: {
        state: "unavailable",
        detail: live.detail,
        lastKnown: toLastKnown(live.lastKnown, "native"),
      },
      chog: {
        state: "unavailable",
        detail: live.detail,
        lastKnown: toLastKnown(live.lastKnown, "chog"),
      },
    };
  }
  const chog = live.chog;
  return {
    native: {
      state: "live",
      symbol: "MON",
      amountRaw: live.native.amountRaw,
      decimals: live.native.decimals,
      observedAt: live.observedAt,
      blockNumber: live.blockNumber,
    },
    chog:
      "unavailable" in chog
        ? { state: "unavailable", detail: chog.unavailable, lastKnown: null }
        : {
            state: "live",
            symbol: "CHOG",
            amountRaw: chog.amountRaw,
            decimals: chog.decimals,
            observedAt: chog.observedAt,
            blockNumber: chog.blockNumber,
          },
  };
}

function toLastKnown(
  rows: StoredBalance[],
  kind: "native" | "chog",
): { symbol: string; amountRaw: string; decimals: number; observedAt: string; blockNumber: string } | null {
  const row = rows.find((item) => (kind === "native" ? item.assetKey === "native" : item.symbol === "CHOG"));
  if (!row) {
    return null;
  }
  return {
    symbol: row.symbol,
    amountRaw: row.amountRaw,
    decimals: row.decimals,
    observedAt: row.observedAt,
    blockNumber: row.blockNumber,
  };
}

export async function loadCitizenWalletView(citizenId: string | null): Promise<CitizenWalletView> {
  const issuance = await readIssuance(citizenId);
  if (!citizenId) {
    return presentCitizenWallet({ citizenId: null, assignment: null, persistence: "not_persisted", issuance });
  }
  const store = openWalletStore();
  if (!store) {
    return presentCitizenWallet({ citizenId, assignment: null, persistence: "not_persisted", issuance });
  }
  const found = await store.findAssignment(citizenId, readAppConfig().chainId);
  if (!found.ok) {
    return presentCitizenWallet({
      citizenId,
      assignment: null,
      persistence: found.reason === "migration_pending" ? "migration_pending" : "unavailable",
      detail: found.detail,
      issuance,
    });
  }
  return presentCitizenWallet({ citizenId, assignment: found.value, persistence: "ready", issuance });
}

async function readIssuance(citizenId: string | null): Promise<CitizenIssuanceView | null | undefined> {
  if (!citizenId) return undefined;
  const client = openEconomyClient();
  if (!client) return undefined;
  return loadLatestIssuance(client, citizenId);
}

export async function loadWalletWorldLine(): Promise<string> {
  const store = openWalletStore();
  if (!store) {
    return citizenWalletWorldLine({ persistence: "not_persisted", assignments: null });
  }
  const listed = await store.listAssignments();
  if (!listed.ok) {
    return citizenWalletWorldLine({
      persistence: listed.reason === "migration_pending" ? "migration_pending" : "unavailable",
      assignments: null,
    });
  }
  return citizenWalletWorldLine({ persistence: "ready", assignments: listed.value });
}
