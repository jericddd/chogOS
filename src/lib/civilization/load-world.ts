import "server-only";
import { getChain } from "@/lib/blockchain/chains";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { selectVerifiedHoldings } from "@/lib/blockchain/holdings";
import { resolveDiscoveryCandidates } from "@/lib/civilization/candidates";
import { loadIndexerCandidates } from "@/lib/civilization/indexer-fetch";
import { formatUtc, foundingCountLabel } from "@/lib/civilization/labels";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { describeCountDiscrepancy } from "@/lib/civilization/plan";
import { mergeCitizensForDisplay, type DisplayCitizen } from "@/lib/civilization/roster";
import type { CivilizationEvent, CitizenRecord } from "@/lib/civilization/types";
import { aiStatusLabel, readAppConfig, type AppConfig } from "@/lib/config/env";
import type { Address } from "viem";

export type WorldSnapshot = {
  chainId: 143 | 10143;
  chainName: string;
  treasury: Address;
  nft: Address;
  tokenSymbol: string;
  expectedFoundingCount: number;
  networkLabel: string;
  countLabel: string;
  discrepancy: string | null;
  notice: string | null;
  liveStatus: "verified" | "unavailable";
  liveError: string | null;
  treasuryCount: number | null;
  tokenIds: string[];
  balanceOf: number | null;
  observedAt: string | null;
  blockNumber: string | null;
  source: string | null;
  persistence: "unconfigured" | "ready" | "error";
  persistenceLabel: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  foundingRecords: number | null;
  communityRecords: number | null;
  citizens: CitizenRecord[];
  events: CivilizationEvent[];
  display: DisplayCitizen[];
  aiLabel: string;
  syncSecretRequired: boolean;
};

const CACHE_MS = 30_000;
let cached: { at: number; snapshot: WorldSnapshot } | null = null;

export function clearWorldCache(): void {
  cached = null;
}

export async function loadWorldSnapshot(): Promise<WorldSnapshot> {
  if (cached && Date.now() - cached.at < CACHE_MS && cached.snapshot.liveStatus === "verified") {
    return cached.snapshot;
  }
  const snapshot = await readSnapshot(readAppConfig());
  if (snapshot.liveStatus === "verified") {
    cached = { at: Date.now(), snapshot };
  }
  return snapshot;
}

async function readSnapshot(config: AppConfig): Promise<WorldSnapshot> {
  const chainName = getChain(config.chainId).name;
  const observedAt = new Date().toISOString();
  let treasuryCount: number | null = null;
  let tokenIds: string[] = [];
  let balanceOf: number | null = null;
  let blockNumber: string | null = null;
  let source: string | null = null;
  let discrepancy: string | null = null;
  let notice: string | null = null;
  let liveError: string | null = null;
  let liveStatus: "verified" | "unavailable" = "unavailable";

  try {
    const reader = createGenesisReaderForConfig(config);
    const indexer = await loadIndexerCandidates(config, config.chogTreasuryAddress, config.chogNftAddress);
    const inventory = await reader.readOwnedInventory(config.chogTreasuryAddress);
    blockNumber = inventory.blockNumber;
    balanceOf = inventory.balanceOf;
    const resolution = resolveDiscoveryCandidates({
      tokensOfOwner: inventory.tokensOfOwner,
      indexer,
    });
    if (resolution.source === "unavailable") {
      liveError = resolution.warnings.join(" ") || inventory.tokensOfOwnerError || "Treasury discovery failed.";
    } else {
      const observations = await reader.readOwners(resolution.tokenIds);
      const selected = selectVerifiedHoldings(observations, config.chogTreasuryAddress);
      treasuryCount = selected.verified.length;
      tokenIds = selected.verified.map((holding) => holding.tokenId);
      source = resolution.source;
      discrepancy = describeCountDiscrepancy(treasuryCount, config.expectedFoundingCount, balanceOf);
      const extra = [...resolution.warnings];
      if (selected.rejected.length > 0) {
        extra.push(
          `${selected.rejected.length} candidate id${selected.rejected.length === 1 ? "" : "s"} failed ownerOf and ${selected.rejected.length === 1 ? "was" : "were"} left out.`,
        );
      }
      notice = extra.length > 0 ? extra.join(" ") : null;
      liveStatus = "verified";
    }
  } catch (error) {
    liveError = error instanceof Error ? error.message.slice(0, 280) : "The Monad RPC could not be read.";
  }

  const persisted = await readPersisted(config);
  const display = mergeCitizensForDisplay({
    liveTokenIds: liveStatus === "verified" ? tokenIds : null,
    treasury: config.chogTreasuryAddress,
    citizens: persisted.citizens,
    chainId: config.chainId,
    nftContract: config.chogNftAddress,
  });

  return {
    chainId: config.chainId,
    chainName,
    treasury: config.chogTreasuryAddress,
    nft: config.chogNftAddress,
    tokenSymbol: "CHOG",
    expectedFoundingCount: config.expectedFoundingCount,
    networkLabel:
      liveStatus === "verified" && blockNumber
        ? `${chainName} · chain ${config.chainId} · block ${blockNumber}`
        : `${chainName} · chain ${config.chainId} · RPC unavailable`,
    countLabel: foundingCountLabel(
      liveStatus === "verified" ? treasuryCount : null,
      config.expectedFoundingCount,
      discrepancy,
    ),
    discrepancy,
    notice,
    liveStatus,
    liveError,
    treasuryCount: liveStatus === "verified" ? treasuryCount : null,
    tokenIds,
    balanceOf,
    observedAt: liveStatus === "verified" ? observedAt : null,
    blockNumber,
    source,
    persistence: persisted.persistence,
    persistenceLabel: persisted.persistenceLabel,
    lastSyncAt: persisted.lastSyncAt,
    lastSyncError: persisted.lastSyncError,
    foundingRecords: persisted.foundingRecords,
    communityRecords: persisted.communityRecords,
    citizens: persisted.citizens,
    events: persisted.events,
    display,
    aiLabel: aiStatusLabel(config),
    syncSecretRequired: Boolean(config.syncSecret),
  };
}

async function readPersisted(config: AppConfig): Promise<{
  persistence: WorldSnapshot["persistence"];
  persistenceLabel: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  foundingRecords: number | null;
  communityRecords: number | null;
  citizens: CitizenRecord[];
  events: CivilizationEvent[];
}> {
  const store = openCivilizationStore();
  if (!store) {
    return {
      persistence: "unconfigured",
      persistenceLabel: "Database not configured. Founding records are not persisted.",
      lastSyncAt: null,
      lastSyncError: null,
      foundingRecords: null,
      communityRecords: null,
      citizens: [],
      events: [],
    };
  }

  try {
    const [citizens, events, latest] = await Promise.all([
      store.listCitizens(),
      store.listEvents(40),
      store.latestSync(),
    ]);
    const relevant = citizens.filter(
      (citizen) => citizen.chainId === config.chainId && citizen.nftContract.toLowerCase() === config.chogNftAddress.toLowerCase(),
    );
    const foundingRecords = relevant.filter(
      (citizen) => citizen.origin === "founding_treasury" && citizen.enrollmentStatus === "active",
    ).length;
    const communityRecords = relevant.filter(
      (citizen) => citizen.origin === "community" && citizen.enrollmentStatus === "active",
    ).length;
    const lastSyncAt = latest?.status === "succeeded" ? latest.finishedAt : null;
    return {
      persistence: "ready",
      persistenceLabel: lastSyncAt
        ? `Last synchronization ${formatUtc(lastSyncAt)}.`
        : "Database connected. Synchronization has not stored a roster yet.",
      lastSyncAt,
      lastSyncError: latest?.status === "failed" ? latest.error : null,
      foundingRecords,
      communityRecords,
      citizens: relevant,
      events,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 280) : "Database read failed.";
    return {
      persistence: "error",
      persistenceLabel: `Database read failed. ${message}`,
      lastSyncAt: null,
      lastSyncError: message,
      foundingRecords: null,
      communityRecords: null,
      citizens: [],
      events: [],
    };
  }
}
