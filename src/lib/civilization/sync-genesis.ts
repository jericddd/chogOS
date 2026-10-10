import type { Address } from "viem";
import type { GenesisChainReader } from "@/lib/blockchain/genesis-reader";
import { selectVerifiedHoldings } from "@/lib/blockchain/holdings";
import { resolveDiscoveryCandidates } from "@/lib/civilization/candidates";
import type { IndexerCandidateResult } from "@/lib/civilization/indexer";
import { describeCountDiscrepancy, planGenesisSync } from "@/lib/civilization/plan";
import type { CivilizationStore } from "@/lib/civilization/store";
import { sameAddress } from "@/lib/civilization/token-id";

export type SyncResult =
  | {
      status: "succeeded";
      verifiedCount: number;
      balanceOf: number | null;
      created: number;
      updated: number;
      warnings: string[];
      discrepancy: string | null;
      blockNumber: string;
      source: "tokensOfOwner" | "indexer";
    }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Synchronization failed.";
  return message.slice(0, 400);
}

export async function synchronizeGenesis(input: {
  reader: GenesisChainReader;
  store: CivilizationStore;
  indexer?: IndexerCandidateResult;
  treasury: Address;
  nftContract: Address;
  chainId: 143 | 10143;
  expectedCount: number;
  now?: string;
  minIntervalMs?: number;
  nextId?: () => string;
}): Promise<SyncResult> {
  const now = input.now ?? new Date().toISOString();
  const minIntervalMs = input.minIntervalMs ?? 15_000;
  let runId: string | null = null;

  try {
    const started = await input.store.beginSync(Date.parse(now), minIntervalMs);
    if (!started.ok) {
      return { status: "skipped", reason: started.reason };
    }
    runId = started.runId;

    const inventory = await input.reader.readOwnedInventory(input.treasury);
    const resolution = resolveDiscoveryCandidates({
      tokensOfOwner: inventory.tokensOfOwner,
      indexer: input.indexer ?? { status: "unconfigured" },
    });
    if (resolution.source === "unavailable") {
      const error =
        resolution.warnings.join(" ") ||
        inventory.tokensOfOwnerError ||
        "Treasury discovery failed. No token ids were stored.";
      await input.store.finishSync(runId, { status: "failed", error });
      return { status: "failed", error };
    }

    const existing = await input.store.listCitizens();
    const relevant = existing.filter(
      (citizen) => citizen.chainId === input.chainId && sameAddress(citizen.nftContract, input.nftContract),
    );
    const missing = relevant.filter(
      (citizen) => citizen.foundingMembershipActive && !resolution.tokenIds.includes(citizen.tokenId),
    );
    const ids = [...resolution.tokenIds];
    for (const citizen of missing) {
      if (!ids.includes(citizen.tokenId)) {
        ids.push(citizen.tokenId);
      }
    }

    const observations = await input.reader.readOwners(ids);
    const selected = selectVerifiedHoldings(observations, input.treasury);
    const warnings = [...resolution.warnings];
    for (const rejected of selected.rejected) {
      if (!missing.some((citizen) => citizen.tokenId === rejected.tokenId)) {
        warnings.push(
          `Token ${rejected.tokenId} was not verified in the treasury and was not stored. ${rejected.reason}`,
        );
      }
    }

    const rechecked = missing.map((citizen) => {
      const observation = observations.find((item) => item.tokenId === citizen.tokenId);
      if (!observation || observation.status === "failed") {
        return {
          tokenId: citizen.tokenId,
          status: "failed" as const,
          reason: observation?.status === "failed" ? observation.reason : "ownerOf did not return.",
        };
      }
      return { tokenId: citizen.tokenId, status: "owner" as const, owner: observation.owner };
    });

    let sequence = 0;
    const plan = planGenesisSync({
      existing,
      verifiedHeld: selected.verified,
      rechecked,
      treasury: input.treasury,
      nftContract: input.nftContract,
      chainId: input.chainId,
      blockNumber: inventory.blockNumber,
      now,
      nextId: input.nextId ?? (() => `citizen-${inventory.blockNumber}-${(sequence += 1)}`),
    });
    warnings.push(...plan.warnings);

    await input.store.persistPlan(plan, {
      blockNumber: inventory.blockNumber,
      treasury: input.treasury,
      now,
    });

    const discrepancy = describeCountDiscrepancy(
      selected.verified.length,
      input.expectedCount,
      inventory.balanceOf,
    );
    await input.store.finishSync(runId, {
      status: "succeeded",
      blockNumber: inventory.blockNumber,
      verifiedCount: selected.verified.length,
      detail: {
        warnings,
        discrepancy,
        source: resolution.source,
        balanceOf: inventory.balanceOf,
      },
    });

    return {
      status: "succeeded",
      verifiedCount: selected.verified.length,
      balanceOf: inventory.balanceOf,
      created: plan.creates.length,
      updated: plan.updates.length,
      warnings,
      discrepancy,
      blockNumber: inventory.blockNumber,
      source: resolution.source,
    };
  } catch (error) {
    const message = publicError(error);
    if (runId) {
      try {
        await input.store.finishSync(runId, { status: "failed", error: message });
      } catch {
        // The original database error is the one to report.
      }
    }
    return { status: "failed", error: message };
  }
}
