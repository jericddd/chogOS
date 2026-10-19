import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, type Address } from "viem";
import type { GenesisChainReader } from "@/lib/blockchain/genesis-reader";
import { buildEnrollmentMessage, signatureMatches } from "@/lib/civilization/enrollment-message";
import { planCommunityEnrollment, type EnrollmentDecision } from "@/lib/civilization/plan";
import type { CivilizationStore } from "@/lib/civilization/store";
import { parseTokenId } from "@/lib/civilization/token-id";
import type { SyncPlan } from "@/lib/civilization/types";

const MAX_TOKEN_IDS = 50;
const CHALLENGE_MS = 10 * 60 * 1000;

export type DiscoverResult =
  | {
      ok: true;
      source: "tokensOfOwner" | "manual";
      owned: Array<{ tokenId: string; owner: Address }>;
      rejected: Array<{ tokenId: string; reason: string }>;
    }
  | { ok: false; error: string; manualTokenIdsRequired: boolean };

export async function discoverOwnedTokens(input: {
  reader: GenesisChainReader;
  wallet: Address;
  manualTokenIds: string[] | null;
}): Promise<DiscoverResult> {
  let source: "tokensOfOwner" | "manual";
  let tokenIds: string[];

  if (input.manualTokenIds) {
    const parsed = parseIdList(input.manualTokenIds);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, manualTokenIdsRequired: false };
    }
    source = "manual";
    tokenIds = parsed.tokenIds;
  } else {
    const inventory = await input.reader.readOwnedInventory(input.wallet);
    if (!inventory.tokensOfOwner) {
      return {
        ok: false,
        error:
          inventory.tokensOfOwnerError ??
          "The NFT contract did not return tokensOfOwner. Enter the token ids you own.",
        manualTokenIdsRequired: true,
      };
    }
    const parsed = parseIdList(inventory.tokensOfOwner);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, manualTokenIdsRequired: true };
    }
    source = "tokensOfOwner";
    tokenIds = parsed.tokenIds;
  }

  const observations = await input.reader.readOwners(tokenIds);
  const owned: Array<{ tokenId: string; owner: Address }> = [];
  const rejected: Array<{ tokenId: string; reason: string }> = [];
  for (const tokenId of tokenIds) {
    const observation = observations.find((item) => item.tokenId === tokenId);
    if (!observation || observation.status === "failed") {
      rejected.push({
        tokenId,
        reason: observation?.status === "failed" ? observation.reason : "ownerOf did not return.",
      });
      continue;
    }
    if (observation.owner.toLowerCase() !== input.wallet.toLowerCase()) {
      rejected.push({ tokenId, reason: "ownerOf does not match the connected wallet." });
      continue;
    }
    owned.push({ tokenId, owner: observation.owner });
  }

  return { ok: true, source, owned, rejected };
}

export async function createEnrollmentChallenge(input: {
  store: CivilizationStore;
  reader: GenesisChainReader;
  chainId: 143 | 10143;
  nftContract: Address;
  treasury: Address;
  wallet: Address;
  tokenIds: string[];
  now?: Date;
}): Promise<
  { ok: true; message: string; nonce: string; expiresAt: string; tokenIds: string[] } | { ok: false; error: string }
> {
  const parsed = parseIdList(input.tokenIds);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.tokenIds.length === 0) {
    return { ok: false, error: "Choose at least one token id." };
  }

  const discovered = await discoverOwnedTokens({
    reader: input.reader,
    wallet: input.wallet,
    manualTokenIds: parsed.tokenIds,
  });
  if (!discovered.ok) {
    return { ok: false, error: discovered.error };
  }
  if (discovered.owned.length !== parsed.tokenIds.length) {
    const reason = discovered.rejected[0]?.reason ?? "Ownership could not be verified.";
    return { ok: false, error: reason };
  }
  if (input.wallet.toLowerCase() === input.treasury.toLowerCase()) {
    return {
      ok: false,
      error: "This NFT is held by ChogTreasury. It is a founding citizen, not a personal community enrollment.",
    };
  }

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_MS).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const message = buildEnrollmentMessage({
    chainId: input.chainId,
    wallet: input.wallet,
    tokenIds: parsed.tokenIds,
    nonce,
    expires: expiresAt,
  });
  await input.store.saveChallenge({
    nonce,
    address: input.wallet,
    message,
    tokenIds: parsed.tokenIds,
    expiresAt,
    consumedAt: null,
  });
  return { ok: true, message, nonce, expiresAt, tokenIds: parsed.tokenIds };
}

export async function submitEnrollment(input: {
  store: CivilizationStore;
  reader: GenesisChainReader;
  chainId: 143 | 10143;
  nftContract: Address;
  treasury: Address;
  wallet: Address;
  nonce: string;
  signature: string;
  now?: Date;
  nextId?: () => string;
}): Promise<{ ok: true; enrolled: string[]; unchanged: string[] } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const challenge = await input.store.getChallenge(input.nonce);
  if (!challenge || challenge.address.toLowerCase() !== input.wallet.toLowerCase()) {
    return { ok: false, error: "This enrollment challenge is not valid for the signed wallet." };
  }
  if (challenge.consumedAt || Date.parse(challenge.expiresAt) <= now.getTime()) {
    return { ok: false, error: "This enrollment challenge has expired. Request a new one." };
  }

  const matches = await signatureMatches(challenge.message, input.signature, input.wallet);
  if (!matches) {
    return { ok: false, error: "The signature does not match the enrollment challenge." };
  }

  const consumed = await input.store.consumeChallenge(input.nonce, now.toISOString());
  if (!consumed) {
    return { ok: false, error: "This enrollment challenge was already used." };
  }

  const plan: SyncPlan = { creates: [], updates: [], events: [], warnings: [] };
  const unchanged: string[] = [];
  const enrolled: string[] = [];
  const blockNumber = await input.reader.readOwnedInventory(input.wallet).then((inventory) => inventory.blockNumber);

  for (const tokenId of challenge.tokenIds) {
    const observation = await input.reader.readOwner(tokenId);
    if (observation.status === "failed") {
      return { ok: false, error: `ownerOf failed for token ${tokenId}. Nothing new was enrolled from this challenge.` };
    }
    const existing = await input.store.findCitizen(input.chainId, input.nftContract, tokenId);
    const decision = planCommunityEnrollment({
      existing,
      signer: input.wallet,
      onChainOwner: observation.owner,
      treasury: input.treasury,
      nftContract: input.nftContract,
      chainId: input.chainId,
      tokenId,
      blockNumber,
      now: now.toISOString(),
      nextId: input.nextId ?? (() => randomUUID()),
    });
    if (decision.action === "reject") {
      return { ok: false, error: decision.reason };
    }
    if (decision.action === "create" || decision.action === "claim") {
      enrolled.push(tokenId);
    }
    if (decision.action === "refresh") {
      unchanged.push(tokenId);
    }
    absorbDecision(plan, decision, unchanged);
  }

  if (plan.creates.length > 0 || plan.updates.length > 0 || plan.events.length > 0) {
    await input.store.persistPlan(plan, {
      blockNumber,
      treasury: input.treasury,
      now: now.toISOString(),
    });
  }

  return { ok: true, enrolled, unchanged };
}

function absorbDecision(plan: SyncPlan, decision: EnrollmentDecision, unchanged: string[]): void {
  if (decision.action === "unchanged") {
    unchanged.push(decision.citizenId);
    return;
  }
  if (decision.action === "create") {
    plan.creates.push(decision.citizen);
    plan.events.push(decision.event);
    return;
  }
  if (decision.action === "claim") {
    plan.updates.push({ id: decision.citizenId, patch: decision.patch });
    plan.events.push(decision.event);
    return;
  }
  if (decision.action === "refresh") {
    plan.updates.push({ id: decision.citizenId, patch: decision.patch });
  }
}

function parseIdList(values: string[]): { ok: true; tokenIds: string[] } | { ok: false; error: string } {
  if (values.length > MAX_TOKEN_IDS) {
    return { ok: false, error: `Enrollment accepts at most ${MAX_TOKEN_IDS} token ids at a time.` };
  }
  const tokenIds: string[] = [];
  for (const value of values) {
    const parsed = parseTokenId(value);
    if (!parsed.ok) {
      return { ok: false, error: parsed.reason };
    }
    if (!tokenIds.includes(parsed.tokenId)) {
      tokenIds.push(parsed.tokenId);
    }
  }
  return { ok: true, tokenIds };
}

export function parseWallet(value: unknown): Address | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}
