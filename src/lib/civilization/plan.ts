import type { Address } from "viem";
import type { CitizenRecord, Holding, NewEvent, Recheck, SyncPlan } from "@/lib/civilization/types";
import { sameAddress } from "@/lib/civilization/token-id";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function describeCountDiscrepancy(
  verifiedCount: number,
  expectedCount: number,
  balanceOf: number | null,
): string | null {
  const notes: string[] = [];
  if (verifiedCount !== expectedCount) {
    notes.push(
      `Verified treasury NFTs: ${verifiedCount}. The expected founding count was ${expectedCount}.`,
    );
  }
  if (balanceOf !== null && balanceOf !== verifiedCount) {
    notes.push(`balanceOf reported ${balanceOf}, while ${verifiedCount} token ids passed ownerOf.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

export function citizenKey(chainId: number, nftContract: string, tokenId: string): string {
  return `${chainId}:${nftContract.toLowerCase()}:${tokenId}`;
}

function blankCitizen(input: {
  id: string;
  chainId: 143 | 10143;
  nftContract: Address;
  tokenId: string;
  origin: CitizenRecord["origin"];
  owner: Address;
  blockNumber: string;
  now: string;
  foundingActive: boolean;
  enrollmentStatus: CitizenRecord["enrollmentStatus"];
}): CitizenRecord {
  return {
    id: input.id,
    chainId: input.chainId,
    nftContract: input.nftContract,
    tokenId: input.tokenId,
    origin: input.origin,
    foundingMembershipActive: input.foundingActive,
    enrollmentStatus: input.enrollmentStatus,
    observedOwner: input.owner,
    ownershipObservedBlock: input.blockNumber,
    ownershipObservedAt: input.now,
    enrolledAt: input.now,
    metadataName: null,
    metadataDescription: null,
    metadataImage: null,
    metadataStatus: "missing",
    rosterVerification: input.foundingActive ? "verified" : null,
  };
}

function event(input: {
  kind: string;
  summary: string;
  tokenId: string;
  chainId: 143 | 10143;
  blockNumber: string;
  nftContract: string;
  owner: string;
  citizenId: string | null;
}): NewEvent {
  return {
    dedupeKey: `${input.kind}:${input.chainId}:${input.nftContract.toLowerCase()}:${input.tokenId}:${input.blockNumber}:${input.owner.toLowerCase()}`,
    kind: input.kind,
    summary: input.summary,
    tokenId: input.tokenId,
    chainId: input.chainId,
    citizenId: input.citizenId,
    payload: {
      tokenId: input.tokenId,
      owner: input.owner,
      blockNumber: input.blockNumber,
    },
  };
}

export function planGenesisSync(input: {
  existing: CitizenRecord[];
  verifiedHeld: Holding[];
  rechecked: Recheck[];
  treasury: Address;
  nftContract: Address;
  chainId: 143 | 10143;
  blockNumber: string;
  now: string;
  nextId: () => string;
}): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], events: [], warnings: [] };
  const relevant = input.existing.filter(
    (citizen) => citizen.chainId === input.chainId && sameAddress(citizen.nftContract, input.nftContract),
  );
  const byToken = new Map(relevant.map((citizen) => [citizen.tokenId, citizen]));
  const held = new Set<string>();

  for (const holding of input.verifiedHeld) {
    if (!sameAddress(holding.owner, input.treasury) || sameAddress(holding.owner, ZERO_ADDRESS)) {
      plan.warnings.push(`Token ${holding.tokenId} was not verified as a treasury holding.`);
      continue;
    }
    if (held.has(holding.tokenId)) {
      continue;
    }
    held.add(holding.tokenId);

    const existing = byToken.get(holding.tokenId);
    if (!existing) {
      const created = blankCitizen({
        id: input.nextId(),
        chainId: input.chainId,
        nftContract: input.nftContract,
        tokenId: holding.tokenId,
        origin: "founding_treasury",
        owner: input.treasury,
        blockNumber: input.blockNumber,
        now: input.now,
        foundingActive: true,
        enrollmentStatus: "active",
      });
      byToken.set(holding.tokenId, created);
      plan.creates.push(created);
      plan.events.push(
        event({
          kind: "genesis_joined",
          summary: `Chog Genesis #${holding.tokenId} verified in the ChogTreasury founding roster.`,
          tokenId: holding.tokenId,
          chainId: input.chainId,
          blockNumber: input.blockNumber,
          nftContract: input.nftContract,
          owner: input.treasury,
          citizenId: created.id,
        }),
      );
      continue;
    }

    const ownerChanged = !existing.observedOwner || !sameAddress(existing.observedOwner, input.treasury);
    const rejoined = !existing.foundingMembershipActive;
    if (!ownerChanged && !rejoined && existing.rosterVerification === "verified") {
      continue;
    }

    plan.updates.push({
      id: existing.id,
      patch: {
        observedOwner: input.treasury,
        foundingMembershipActive: true,
        enrollmentStatus: "active",
        ownershipObservedBlock: input.blockNumber,
        ownershipObservedAt: input.now,
        rosterVerification: "verified",
      },
    });
    if (ownerChanged) {
      plan.events.push(
        event({
          kind: "ownership_changed",
          summary: `Chog Genesis #${holding.tokenId} ownership verified as the ChogTreasury wallet.`,
          tokenId: holding.tokenId,
          chainId: input.chainId,
          blockNumber: input.blockNumber,
          nftContract: input.nftContract,
          owner: input.treasury,
          citizenId: existing.id,
        }),
      );
    }
    if (rejoined) {
      plan.events.push(
        event({
          kind: "genesis_joined",
          summary: `Chog Genesis #${holding.tokenId} is in the ChogTreasury founding roster.`,
          tokenId: holding.tokenId,
          chainId: input.chainId,
          blockNumber: input.blockNumber,
          nftContract: input.nftContract,
          owner: input.treasury,
          citizenId: existing.id,
        }),
      );
    }
  }

  for (const citizen of relevant) {
    if (!citizen.foundingMembershipActive || held.has(citizen.tokenId)) {
      continue;
    }
    const check = input.rechecked.find((item) => item.tokenId === citizen.tokenId);
    if (!check || check.status === "failed") {
      plan.warnings.push(
        `Token ${citizen.tokenId} could not be rechecked. Its founding record was left unchanged.`,
      );
      plan.updates.push({
        id: citizen.id,
        patch: { rosterVerification: "stale" },
      });
      continue;
    }
    if (sameAddress(check.owner, input.treasury)) {
      continue;
    }
    plan.updates.push({
      id: citizen.id,
      patch: {
        observedOwner: check.owner,
        foundingMembershipActive: false,
        enrollmentStatus: "suspended",
        ownershipObservedBlock: input.blockNumber,
        ownershipObservedAt: input.now,
        rosterVerification: "verified",
      },
    });
    plan.events.push(
      event({
        kind: "genesis_left",
        summary: `Chog Genesis #${citizen.tokenId} left the ChogTreasury wallet. Founding membership is inactive until the current owner claims it.`,
        tokenId: citizen.tokenId,
        chainId: input.chainId,
        blockNumber: input.blockNumber,
        nftContract: input.nftContract,
        owner: check.owner,
        citizenId: citizen.id,
      }),
    );
    plan.events.push(
      event({
        kind: "ownership_changed",
        summary: `Chog Genesis #${citizen.tokenId} owner changed on Monad.`,
        tokenId: citizen.tokenId,
        chainId: input.chainId,
        blockNumber: input.blockNumber,
        nftContract: input.nftContract,
        owner: check.owner,
        citizenId: citizen.id,
      }),
    );
  }

  return plan;
}

export function applyPlan(existing: CitizenRecord[], plan: SyncPlan): CitizenRecord[] {
  const next = existing.map((citizen) => ({ ...citizen }));
  const byId = new Map(next.map((citizen) => [citizen.id, citizen]));
  for (const created of plan.creates) {
    if (next.some((citizen) => citizen.tokenId === created.tokenId && citizen.chainId === created.chainId)) {
      continue;
    }
    next.push({ ...created });
    byId.set(created.id, created);
  }
  for (const update of plan.updates) {
    const citizen = byId.get(update.id);
    if (!citizen) {
      continue;
    }
    Object.assign(citizen, update.patch);
  }
  return next;
}

export type EnrollmentDecision =
  | { action: "reject"; reason: string }
  | { action: "unchanged"; citizenId: string }
  | {
      action: "create";
      citizen: CitizenRecord;
      event: NewEvent;
    }
  | {
      action: "claim";
      citizenId: string;
      patch: Partial<CitizenRecord>;
      event: NewEvent;
    };

export function planCommunityEnrollment(input: {
  existing: CitizenRecord | null;
  signer: Address;
  onChainOwner: Address;
  treasury: Address;
  nftContract: Address;
  chainId: 143 | 10143;
  tokenId: string;
  blockNumber: string;
  now: string;
  nextId: () => string;
}): EnrollmentDecision {
  if (!sameAddress(input.signer, input.onChainOwner)) {
    return { action: "reject", reason: "The signed wallet is not the current on-chain owner." };
  }
  if (sameAddress(input.onChainOwner, input.treasury)) {
    return {
      action: "reject",
      reason: "This NFT is held by ChogTreasury. It is a founding citizen, not a personal community enrollment.",
    };
  }

  if (!input.existing) {
    const citizen = blankCitizen({
      id: input.nextId(),
      chainId: input.chainId,
      nftContract: input.nftContract,
      tokenId: input.tokenId,
      origin: "community",
      owner: input.onChainOwner,
      blockNumber: input.blockNumber,
      now: input.now,
      foundingActive: false,
      enrollmentStatus: "active",
    });
    return {
      action: "create",
      citizen,
      event: event({
        kind: "citizen_enrolled",
        summary: `Chog Genesis #${input.tokenId} enrolled by its verified owner.`,
        tokenId: input.tokenId,
        chainId: input.chainId,
        blockNumber: input.blockNumber,
        nftContract: input.nftContract,
        owner: input.onChainOwner,
        citizenId: citizen.id,
      }),
    };
  }

  const sameOwner = input.existing.observedOwner
    ? sameAddress(input.existing.observedOwner, input.onChainOwner)
    : false;
  if (sameOwner && input.existing.enrollmentStatus === "active" && !input.existing.foundingMembershipActive) {
    return { action: "unchanged", citizenId: input.existing.id };
  }

  return {
    action: "claim",
    citizenId: input.existing.id,
    patch: {
      observedOwner: input.onChainOwner,
      foundingMembershipActive: false,
      enrollmentStatus: "active",
      ownershipObservedBlock: input.blockNumber,
      ownershipObservedAt: input.now,
      rosterVerification: "verified",
    },
    event: event({
      kind: "ownership_claimed",
      summary: `Chog Genesis #${input.tokenId} claimed by the current verified owner.`,
      tokenId: input.tokenId,
      chainId: input.chainId,
      blockNumber: input.blockNumber,
      nftContract: input.nftContract,
      owner: input.onChainOwner,
      citizenId: input.existing.id,
    }),
  };
}

export function canActAsCurrentOwner(signer: Address, currentOnChainOwner: Address): boolean {
  return sameAddress(signer, currentOnChainOwner) && !sameAddress(signer, ZERO_ADDRESS);
}
