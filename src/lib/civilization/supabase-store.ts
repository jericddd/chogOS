import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAddress, type Address } from "viem";
import { decideSyncLock } from "@/lib/civilization/sync-policy";
import type {
  ChallengeRecord,
  CivilizationStore,
  MetadataWrite,
  StoredSync,
  SyncFinish,
} from "@/lib/civilization/store";
import type {
  CivilizationEvent,
  CitizenRecord,
  EnrollmentStatus,
  MetadataStatus,
  RosterVerification,
  SyncPlan,
} from "@/lib/civilization/types";

type RosterJoin = { verification_status: RosterVerification } | RosterJoin[] | null;

type CitizenRow = {
  id: string;
  chain_id: number;
  nft_contract: string;
  token_id: string | number;
  origin: CitizenRecord["origin"];
  founding_membership_active: boolean;
  enrollment_status: EnrollmentStatus;
  observed_owner: string | null;
  ownership_observed_block: number | string | null;
  ownership_observed_at: string | null;
  enrolled_at: string | null;
  metadata_name: string | null;
  metadata_description: string | null;
  metadata_image: string | null;
  metadata_status: MetadataStatus;
  genesis_roster: RosterJoin;
};

function asChainId(value: number): 143 | 10143 {
  if (value === 143 || value === 10143) {
    return value;
  }
  throw new Error("A citizen row has an unsupported chain id.");
}

function rosterStatus(value: RosterJoin): RosterVerification | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const row = value[0];
    if (!row || Array.isArray(row) || !("verification_status" in row)) {
      return null;
    }
    return row.verification_status;
  }
  return value.verification_status;
}

function toCitizen(row: CitizenRow): CitizenRecord {
  return {
    id: row.id,
    chainId: asChainId(row.chain_id),
    nftContract: getAddress(row.nft_contract),
    tokenId: String(row.token_id).split(".")[0] ?? String(row.token_id),
    origin: row.origin,
    foundingMembershipActive: row.founding_membership_active,
    enrollmentStatus: row.enrollment_status,
    observedOwner: row.observed_owner ? getAddress(row.observed_owner) : null,
    ownershipObservedBlock:
      row.ownership_observed_block === null || row.ownership_observed_block === undefined
        ? null
        : String(row.ownership_observed_block),
    ownershipObservedAt: row.ownership_observed_at,
    enrolledAt: row.enrolled_at,
    metadataName: row.metadata_name,
    metadataDescription: row.metadata_description,
    metadataImage: row.metadata_image,
    metadataStatus: row.metadata_status,
    rosterVerification: rosterStatus(row.genesis_roster),
  };
}

function dbError(error: { message: string }, action: string): Error {
  return new Error(`${action} ${error.message}`.slice(0, 400));
}

export class SupabaseCivilizationStore implements CivilizationStore {
  constructor(private readonly client: SupabaseClient) {}

  async listCitizens(): Promise<CitizenRecord[]> {
    const { data, error } = await this.client
      .from("citizens")
      .select("*, genesis_roster(verification_status)");
    if (error) {
      throw dbError(error, "Could not read citizens.");
    }
    return ((data ?? []) as CitizenRow[]).map(toCitizen);
  }

  async findCitizen(chainId: number, nftContract: string, tokenId: string): Promise<CitizenRecord | null> {
    const { data, error } = await this.client
      .from("citizens")
      .select("*, genesis_roster(verification_status)")
      .eq("chain_id", chainId)
      .eq("nft_contract", getAddress(nftContract))
      .eq("token_id", tokenId)
      .maybeSingle();
    if (error) {
      throw dbError(error, "Could not read a citizen.");
    }
    return data ? toCitizen(data as CitizenRow) : null;
  }

  async listEvents(limit: number): Promise<CivilizationEvent[]> {
    const { data, error } = await this.client
      .from("civilization_events")
      .select("id, occurred_at, kind, summary, actor_citizen_id, payload, chain_status, dedupe_key")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      throw dbError(error, "Could not read civilization events.");
    }
    return (data ?? []).map((row) => {
      const payload = row.payload as { tokenId?: unknown } | null;
      const tokenId = payload && typeof payload.tokenId === "string" ? payload.tokenId : null;
      return {
        id: String(row.id),
        occurredAt: String(row.occurred_at),
        kind: String(row.kind),
        summary: String(row.summary),
        citizenId: row.actor_citizen_id ? String(row.actor_citizen_id) : null,
        tokenId,
        chainStatus: row.chain_status as CivilizationEvent["chainStatus"],
        dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
      };
    });
  }

  async latestSync(): Promise<StoredSync | null> {
    const { data, error } = await this.client
      .from("sync_runs")
      .select("status, finished_at, verified_count, block_number, error")
      .eq("kind", "genesis_treasury")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw dbError(error, "Could not read synchronization status.");
    }
    if (!data) {
      return null;
    }
    return {
      status: data.status as StoredSync["status"],
      finishedAt: data.finished_at ? String(data.finished_at) : null,
      verifiedCount: typeof data.verified_count === "number" ? data.verified_count : null,
      blockNumber: data.block_number === null || data.block_number === undefined ? null : String(data.block_number),
      error: data.error ? String(data.error) : null,
    };
  }

  async beginSync(
    nowMs: number,
    minIntervalMs: number,
  ): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    const { data: running, error: runningError } = await this.client
      .from("sync_runs")
      .select("id, started_at")
      .eq("kind", "genesis_treasury")
      .eq("status", "running")
      .maybeSingle();
    if (runningError) {
      throw dbError(runningError, "Could not read the synchronization lock.");
    }

    const { data: lastSuccess, error: successError } = await this.client
      .from("sync_runs")
      .select("finished_at")
      .eq("kind", "genesis_treasury")
      .eq("status", "succeeded")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (successError) {
      throw dbError(successError, "Could not read the last synchronization.");
    }

    const decision = decideSyncLock({
      nowMs,
      minIntervalMs,
      runningStartedAtMs: running?.started_at ? Date.parse(String(running.started_at)) : null,
      lastSuccessFinishedAtMs: lastSuccess?.finished_at ? Date.parse(String(lastSuccess.finished_at)) : null,
    });
    if (decision === "already_running") {
      return { ok: false, reason: "A synchronization is already running." };
    }
    if (decision === "too_soon") {
      return { ok: false, reason: "A synchronization finished recently. Wait a few seconds and try again." };
    }
    if (decision === "expire" && running) {
      const { error } = await this.client
        .from("sync_runs")
        .update({
          status: "failed",
          finished_at: new Date(nowMs).toISOString(),
          error: "The previous synchronization lock expired.",
        })
        .eq("id", running.id);
      if (error) {
        throw dbError(error, "Could not expire a synchronization lock.");
      }
    }

    const { data, error } = await this.client
      .from("sync_runs")
      .insert({ kind: "genesis_treasury", status: "running" })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        return { ok: false, reason: "A synchronization is already running." };
      }
      throw dbError(error, "Could not start synchronization.");
    }
    return { ok: true, runId: String(data.id) };
  }

  async finishSync(runId: string, input: SyncFinish): Promise<void> {
    const { error } = await this.client
      .from("sync_runs")
      .update({
        status: input.status,
        finished_at: new Date().toISOString(),
        block_number: input.blockNumber ?? null,
        verified_count: input.verifiedCount ?? null,
        error: input.error ?? null,
        detail: input.detail ?? {},
      })
      .eq("id", runId);
    if (error) {
      throw dbError(error, "Could not finish synchronization.");
    }
  }

  async persistPlan(
    plan: SyncPlan,
    context: { blockNumber: string; treasury: Address; now: string },
  ): Promise<void> {
    if (plan.events.length > 0) {
      const { error } = await this.client.from("civilization_events").upsert(
        plan.events.map((event) => ({
          dedupe_key: event.dedupeKey,
          kind: event.kind,
          summary: event.summary,
          actor_citizen_id: null,
          chain_id: event.chainId,
          chain_status: "offchain",
          payload: event.payload,
        })),
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      );
      if (error) {
        throw dbError(error, "Could not write civilization events.");
      }
    }

    for (const citizen of plan.creates) {
      await this.insertCitizen(citizen, context);
    }
    for (const update of plan.updates) {
      await this.applyPatch(update.id, update.patch, context);
    }

    for (const event of plan.events) {
      if (!event.citizenId) {
        continue;
      }
      const { error } = await this.client
        .from("civilization_events")
        .update({ actor_citizen_id: event.citizenId })
        .eq("dedupe_key", event.dedupeKey)
        .is("actor_citizen_id", null);
      if (error) {
        throw dbError(error, "Could not attach an event to its citizen.");
      }
    }
  }

  async saveChallenge(challenge: ChallengeRecord): Promise<void> {
    const { error } = await this.client.from("enrollment_challenges").insert({
      address: challenge.address,
      nonce: challenge.nonce,
      message: challenge.message,
      token_ids: challenge.tokenIds,
      expires_at: challenge.expiresAt,
    });
    if (error) {
      throw dbError(error, "Could not store the enrollment challenge.");
    }
  }

  async getChallenge(nonce: string): Promise<ChallengeRecord | null> {
    const { data, error } = await this.client
      .from("enrollment_challenges")
      .select("address, nonce, message, token_ids, expires_at, consumed_at")
      .eq("nonce", nonce)
      .maybeSingle();
    if (error) {
      throw dbError(error, "Could not read the enrollment challenge.");
    }
    if (!data) {
      return null;
    }
    const tokenIds = Array.isArray(data.token_ids) ? data.token_ids.filter((item) => typeof item === "string") : [];
    return {
      nonce: String(data.nonce),
      address: getAddress(String(data.address)),
      message: String(data.message),
      tokenIds,
      expiresAt: String(data.expires_at),
      consumedAt: data.consumed_at ? String(data.consumed_at) : null,
    };
  }

  async consumeChallenge(nonce: string, nowIso: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("enrollment_challenges")
      .update({ consumed_at: nowIso })
      .eq("nonce", nonce)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (error) {
      throw dbError(error, "Could not consume the enrollment challenge.");
    }
    return (data ?? []).length > 0;
  }

  async saveMetadata(input: MetadataWrite): Promise<void> {
    const { error } = await this.client
      .from("citizens")
      .update({
        metadata_name: input.name,
        metadata_description: input.description,
        metadata_image: input.image,
        metadata_status: input.status,
        metadata_checked_at: input.checkedAt,
      })
      .eq("chain_id", input.chainId)
      .eq("nft_contract", getAddress(input.nftContract))
      .eq("token_id", input.tokenId);
    if (error) {
      throw dbError(error, "Could not save NFT metadata.");
    }
  }

  private async insertCitizen(
    citizen: CitizenRecord,
    context: { blockNumber: string; treasury: Address; now: string },
  ): Promise<void> {
    const row = citizenRow(citizen);
    const { error } = await this.client.from("citizens").insert(row);
    if (error?.code === "23505") {
      const existing = await this.findCitizen(citizen.chainId, citizen.nftContract, citizen.tokenId);
      if (!existing) {
        throw dbError(error, "Could not save a citizen.");
      }
      await this.applyPatch(
        existing.id,
        {
          observedOwner: citizen.observedOwner,
          foundingMembershipActive: citizen.foundingMembershipActive,
          enrollmentStatus: citizen.enrollmentStatus,
          ownershipObservedBlock: citizen.ownershipObservedBlock,
          ownershipObservedAt: citizen.ownershipObservedAt,
          rosterVerification: citizen.rosterVerification ?? undefined,
        },
        context,
      );
      return;
    }
    if (error) {
      throw dbError(error, "Could not save a citizen.");
    }

    const { error: profileError } = await this.client.from("citizen_profiles").insert({ citizen_id: citizen.id });
    if (profileError && profileError.code !== "23505") {
      throw dbError(profileError, "Could not save a citizen profile.");
    }
    await this.syncRoster(citizen.id, citizen.foundingMembershipActive, citizen.rosterVerification, context);
    if (citizen.observedOwner) {
      await this.insertSnapshot(citizen.id, citizen.observedOwner, context.blockNumber);
    }
  }

  private async applyPatch(
    id: string,
    patch: Partial<CitizenRecord>,
    context: { blockNumber: string; treasury: Address; now: string },
  ): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.observedOwner !== undefined) {
      row.observed_owner = patch.observedOwner;
    }
    if (patch.foundingMembershipActive !== undefined) {
      row.founding_membership_active = patch.foundingMembershipActive;
    }
    if (patch.enrollmentStatus !== undefined) {
      row.enrollment_status = patch.enrollmentStatus;
    }
    if (patch.ownershipObservedBlock !== undefined) {
      row.ownership_observed_block = patch.ownershipObservedBlock;
    }
    if (patch.ownershipObservedAt !== undefined) {
      row.ownership_observed_at = patch.ownershipObservedAt;
    }
    if (Object.keys(row).length > 0) {
      const { error } = await this.client.from("citizens").update(row).eq("id", id);
      if (error) {
        throw dbError(error, "Could not update a citizen.");
      }
    }
    if (patch.foundingMembershipActive !== undefined || patch.rosterVerification !== undefined) {
      await this.syncRoster(id, patch.foundingMembershipActive, patch.rosterVerification ?? null, context);
    }
    if (patch.observedOwner) {
      await this.insertSnapshot(id, patch.observedOwner, context.blockNumber);
    }
  }

  private async syncRoster(
    citizenId: string,
    membership: boolean | undefined,
    verification: RosterVerification | null,
    context: { treasury: Address; now: string },
  ): Promise<void> {
    if (membership === undefined && !verification) {
      return;
    }
    const { data, error } = await this.client
      .from("genesis_roster")
      .select("membership_active, verification_status, last_verified_at, left_treasury_at")
      .eq("citizen_id", citizenId)
      .maybeSingle();
    if (error) {
      throw dbError(error, "Could not read genesis roster membership.");
    }
    if (!data) {
      if (!membership) {
        return;
      }
      const { error: insertError } = await this.client.from("genesis_roster").insert({
        citizen_id: citizenId,
        treasury_address: context.treasury,
        membership_active: true,
        verification_status: verification ?? "verified",
        first_verified_at: context.now,
        last_verified_at: context.now,
      });
      if (insertError) {
        throw dbError(insertError, "Could not save genesis roster membership.");
      }
      return;
    }

    const nextMembership = membership === undefined ? Boolean(data.membership_active) : membership;
    const nextVerification = verification ?? (data.verification_status as RosterVerification);
    const { error: updateError } = await this.client
      .from("genesis_roster")
      .update({
        membership_active: nextMembership,
        verification_status: nextVerification,
        last_verified_at: verification === "stale" ? data.last_verified_at : context.now,
        left_treasury_at: membership === false ? context.now : membership === true ? null : data.left_treasury_at,
      })
      .eq("citizen_id", citizenId);
    if (updateError) {
      throw dbError(updateError, "Could not update genesis roster membership.");
    }
  }

  private async insertSnapshot(citizenId: string, owner: Address, blockNumber: string): Promise<void> {
    const { error } = await this.client.from("ownership_snapshots").insert({
      citizen_id: citizenId,
      owner_address: owner,
      block_number: blockNumber,
      source: "ownerOf",
    });
    if (error) {
      throw dbError(error, "Could not save an ownership snapshot.");
    }
  }
}

function citizenRow(citizen: CitizenRecord): Record<string, unknown> {
  return {
    id: citizen.id,
    chain_id: citizen.chainId,
    nft_contract: citizen.nftContract,
    token_id: citizen.tokenId,
    origin: citizen.origin,
    founding_membership_active: citizen.foundingMembershipActive,
    enrollment_status: citizen.enrollmentStatus,
    observed_owner: citizen.observedOwner,
    ownership_observed_block: citizen.ownershipObservedBlock,
    ownership_observed_at: citizen.ownershipObservedAt,
    enrolled_at: citizen.enrolledAt,
    metadata_name: citizen.metadataName,
    metadata_description: citizen.metadataDescription,
    metadata_image: citizen.metadataImage,
    metadata_status: citizen.metadataStatus,
  };
}
