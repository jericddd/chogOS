import type { Address } from "viem";
import type { CivilizationEvent, CitizenRecord, SyncPlan } from "@/lib/civilization/types";

export type StoredSync = {
  status: "succeeded" | "failed" | "running";
  finishedAt: string | null;
  verifiedCount: number | null;
  blockNumber: string | null;
  error: string | null;
};

export type SyncFinish = {
  status: "succeeded" | "failed";
  blockNumber?: string;
  verifiedCount?: number;
  error?: string;
  detail?: Record<string, unknown>;
};

export type ChallengeRecord = {
  nonce: string;
  address: Address;
  message: string;
  tokenIds: string[];
  expiresAt: string;
  consumedAt: string | null;
};

export type MetadataWrite = {
  chainId: number;
  nftContract: string;
  tokenId: string;
  name: string | null;
  description: string | null;
  image: string | null;
  status: "fetched" | "unavailable";
  checkedAt: string;
};

export interface CivilizationStore {
  listCitizens(): Promise<CitizenRecord[]>;
  findCitizen(chainId: number, nftContract: string, tokenId: string): Promise<CitizenRecord | null>;
  listEvents(limit: number): Promise<CivilizationEvent[]>;
  latestSync(): Promise<StoredSync | null>;
  beginSync(
    nowMs: number,
    minIntervalMs: number,
  ): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  finishSync(runId: string, input: SyncFinish): Promise<void>;
  persistPlan(
    plan: SyncPlan,
    context: { blockNumber: string; treasury: Address; now: string },
  ): Promise<void>;
  saveChallenge(challenge: ChallengeRecord): Promise<void>;
  getChallenge(nonce: string): Promise<ChallengeRecord | null>;
  consumeChallenge(nonce: string, nowIso: string): Promise<boolean>;
  saveMetadata(input: MetadataWrite): Promise<void>;
}
