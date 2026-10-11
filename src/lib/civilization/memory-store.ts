import { randomUUID } from "node:crypto";
import { applyPlan } from "@/lib/civilization/plan";
import { decideSyncLock } from "@/lib/civilization/sync-policy";
import type {
  ChallengeRecord,
  CivilizationStore,
  MetadataWrite,
  StoredSync,
  SyncFinish,
} from "@/lib/civilization/store";
import { sameAddress } from "@/lib/civilization/token-id";
import type { CivilizationEvent, CitizenRecord, SyncPlan } from "@/lib/civilization/types";

type Run = {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAtMs: number;
  finishedAt: string | null;
  verifiedCount: number | null;
  blockNumber: string | null;
  error: string | null;
};

export class MemoryCivilizationStore implements CivilizationStore {
  citizens: CitizenRecord[] = [];
  events: CivilizationEvent[] = [];
  private challenges = new Map<string, ChallengeRecord>();
  private runs: Run[] = [];
  private failure: "begin" | "persist" | "list" | "finish" | null = null;

  armFailure(operation: "begin" | "persist" | "list" | "finish"): void {
    this.failure = operation;
  }

  async listCitizens(): Promise<CitizenRecord[]> {
    this.throwIf("list");
    return this.citizens.map((citizen) => ({ ...citizen }));
  }

  async findCitizen(chainId: number, nftContract: string, tokenId: string): Promise<CitizenRecord | null> {
    const citizen = this.citizens.find(
      (item) => item.chainId === chainId && item.tokenId === tokenId && sameAddress(item.nftContract, nftContract),
    );
    return citizen ? { ...citizen } : null;
  }

  async listEvents(limit: number): Promise<CivilizationEvent[]> {
    return this.events.slice(-limit).reverse().map((event) => ({ ...event }));
  }

  async latestSync(): Promise<StoredSync | null> {
    const finished = [...this.runs].reverse().find((run) => run.status !== "running");
    const run = finished ?? this.runs.at(-1);
    if (!run) {
      return null;
    }
    return {
      status: run.status,
      finishedAt: run.finishedAt,
      verifiedCount: run.verifiedCount,
      blockNumber: run.blockNumber,
      error: run.error,
    };
  }

  async beginSync(
    nowMs: number,
    minIntervalMs: number,
  ): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    this.throwIf("begin");
    const running = [...this.runs].reverse().find((run) => run.status === "running") ?? null;
    const lastSuccess = [...this.runs].reverse().find((run) => run.status === "succeeded") ?? null;
    const decision = decideSyncLock({
      nowMs,
      minIntervalMs,
      runningStartedAtMs: running?.startedAtMs ?? null,
      lastSuccessFinishedAtMs: lastSuccess?.finishedAt ? Date.parse(lastSuccess.finishedAt) : null,
    });
    if (decision === "already_running") {
      return { ok: false, reason: "A synchronization is already running." };
    }
    if (decision === "too_soon") {
      return { ok: false, reason: "A synchronization finished recently. Wait a few seconds and try again." };
    }
    if (decision === "expire" && running) {
      running.status = "failed";
      running.finishedAt = new Date(nowMs).toISOString();
      running.error = "The previous synchronization lock expired.";
    }
    const run: Run = {
      id: randomUUID(),
      status: "running",
      startedAtMs: nowMs,
      finishedAt: null,
      verifiedCount: null,
      blockNumber: null,
      error: null,
    };
    this.runs.push(run);
    return { ok: true, runId: run.id };
  }

  async finishSync(runId: string, input: SyncFinish): Promise<void> {
    this.throwIf("finish");
    const run = this.runs.find((item) => item.id === runId);
    if (!run) {
      throw new Error("Synchronization run was not found.");
    }
    run.status = input.status;
    run.finishedAt = new Date(run.startedAtMs).toISOString();
    run.verifiedCount = input.verifiedCount ?? null;
    run.blockNumber = input.blockNumber ?? null;
    run.error = input.error ?? null;
  }

  async persistPlan(plan: SyncPlan): Promise<void> {
    this.throwIf("persist");
    const nextCitizens = applyPlan(this.citizens, plan);
    const keys = new Set<string>();
    for (const citizen of nextCitizens) {
      const key = `${citizen.chainId}:${citizen.nftContract.toLowerCase()}:${citizen.tokenId}`;
      if (keys.has(key)) {
        throw new Error(`Duplicate citizen for token ${citizen.tokenId}.`);
      }
      keys.add(key);
    }
    const nextEvents = [...this.events];
    for (const event of plan.events) {
      if (nextEvents.some((existing) => existing.dedupeKey === event.dedupeKey)) {
        continue;
      }
      nextEvents.push({
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        kind: event.kind,
        summary: event.summary,
        citizenId: event.citizenId,
        tokenId: event.tokenId,
        chainStatus: "offchain",
        dedupeKey: event.dedupeKey,
      });
    }
    this.citizens = nextCitizens;
    this.events = nextEvents;
  }

  async saveChallenge(challenge: ChallengeRecord): Promise<void> {
    this.challenges.set(challenge.nonce, { ...challenge, tokenIds: [...challenge.tokenIds] });
  }

  async getChallenge(nonce: string): Promise<ChallengeRecord | null> {
    const challenge = this.challenges.get(nonce);
    return challenge ? { ...challenge, tokenIds: [...challenge.tokenIds] } : null;
  }

  async consumeChallenge(nonce: string, nowIso: string): Promise<boolean> {
    const challenge = this.challenges.get(nonce);
    if (!challenge || challenge.consumedAt) {
      return false;
    }
    if (Date.parse(challenge.expiresAt) <= Date.parse(nowIso)) {
      return false;
    }
    challenge.consumedAt = nowIso;
    return true;
  }

  async saveMetadata(input: MetadataWrite): Promise<void> {
    const citizen = this.citizens.find(
      (item) =>
        item.chainId === input.chainId &&
        item.tokenId === input.tokenId &&
        sameAddress(item.nftContract, input.nftContract),
    );
    if (!citizen) {
      return;
    }
    citizen.metadataName = input.name;
    citizen.metadataDescription = input.description;
    citizen.metadataImage = input.image;
    citizen.metadataStatus = input.status;
  }

  private throwIf(operation: "begin" | "persist" | "list" | "finish"): void {
    if (this.failure === operation) {
      this.failure = null;
      throw new Error("Database write failed.");
    }
  }
}
