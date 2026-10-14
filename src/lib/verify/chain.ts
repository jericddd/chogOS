import { hashEvent, hashesMatch, type CanonicalEventInput } from "@/lib/verify/canonical";
import { verifyInclusion } from "@/lib/verify/merkle";

export const VERIFY_STATUSES = [
  "unverified",
  "event_hash_verified",
  "log_integrity_verified",
  "merkle_proof_verified",
  "onchain_anchor_verified",
  "verification_failed",
] as const;

export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

export type ChainLink = {
  seq: number;
  hash: string;
  prevEventHash: string | null;
};

export type AnchorRecord = {
  chainId: number;
  contract: string;
  txHash: string;
  blockNumber: string;
  root: string;
  batchId: string;
} | null;

export type LocalVerifyInput = {
  event: CanonicalEventInput;
  storedHash: string | null;
  integrityClass: "historical" | "live" | null;
  previous?: ChainLink | null;
  next?: ChainLink | null;
  proof?: { format: string; root: string; proof: string[] } | null;
  expectedRoot?: string | null;
  anchor?: AnchorRecord;
  /** Root actually read from the contract, if a read was performed. */
  onchainRoot?: string | null;
  onchainChainId?: number | null;
};

export type LocalVerifyResult = {
  status: VerifyStatus;
  computedHash: string | null;
  reasons: string[];
};

/**
 * Recomputes integrity locally. API success is not a status. Onchain status
 * requires a contract read whose root matches the Merkle root, on the expected chain.
 */
export function verifyEventLocally(input: LocalVerifyInput): LocalVerifyResult {
  const reasons: string[] = [];
  if (!input.storedHash) {
    return { status: "unverified", computedHash: null, reasons: ["No event hash is stored. This row is from before the verification cutover."] };
  }

  let computedHash: string;
  try {
    computedHash = hashEvent(input.event);
  } catch (error) {
    return {
      status: "verification_failed",
      computedHash: null,
      reasons: [error instanceof Error ? error.message : "The event could not be canonically encoded."],
    };
  }

  if (!hashesMatch(input.storedHash, computedHash)) {
    return { status: "verification_failed", computedHash, reasons: ["Recomputed event hash does not match the stored hash."] };
  }
  reasons.push("Event hash matches the canonical encoding.");

  let logOk = true;
  if (input.integrityClass === "live") {
    const prevStored = (input.event.prevEventHash ?? "").toLowerCase();
    if (input.previous) {
      if (input.previous.seq >= Number(input.event.seq)) {
        logOk = false;
        reasons.push("The previous live event does not have a smaller sequence.");
      }
      if (!hashesMatch(input.previous.hash, prevStored)) {
        logOk = false;
        reasons.push("prevEventHash does not match the previous live event hash.");
      }
    } else if (prevStored) {
      logOk = false;
      reasons.push("prevEventHash is set but the previous live event was not provided.");
    }
    if (input.next && input.next.seq <= Number(input.event.seq)) {
      logOk = false;
      reasons.push("The following live event does not have a greater sequence.");
    }
    if (input.next && !hashesMatch(input.next.prevEventHash, computedHash)) {
      logOk = false;
      reasons.push("The following live event does not point at this event hash.");
    }
  }

  if (!logOk) {
    return { status: "verification_failed", computedHash, reasons };
  }

  if (input.integrityClass === "live") {
    reasons.push("Live hash-chain links for the provided neighbors are intact.");
  } else if (input.integrityClass === "historical") {
    reasons.push("Historical snapshot hashes do not form a live chain. They only commit to event content.");
  }

  const proof = input.proof;
  if (!proof) {
    return {
      status: input.integrityClass === "live" ? "log_integrity_verified" : "event_hash_verified",
      computedHash,
      reasons: [...reasons, "No Merkle inclusion proof is stored for this event yet."],
    };
  }

  const merkleOk =
    Boolean(input.expectedRoot && proof.root.toLowerCase() === input.expectedRoot.toLowerCase()) &&
    verifyInclusion(proof.root, computedHash, proof.proof, proof.format);
  if (!merkleOk) {
    return { status: "verification_failed", computedHash, reasons: [...reasons, "Merkle inclusion proof does not match the batch root."] };
  }
  reasons.push("Merkle inclusion proof matches the batch root.");

  if (!input.anchor) {
    return { status: "merkle_proof_verified", computedHash, reasons: [...reasons, "No onchain anchor is recorded. A Merkle root is a local commitment."] };
  }
  if (!input.onchainRoot) {
    return {
      status: "merkle_proof_verified",
      computedHash,
      reasons: [...reasons, "An anchor is recorded, but this check did not read the contract. Export the bundle and query Monad yourself."],
    };
  }
  if (input.onchainChainId !== input.anchor.chainId) {
    return { status: "verification_failed", computedHash, reasons: [...reasons, "The contract was read on a different chain than the recorded anchor."] };
  }
  if (input.onchainRoot.toLowerCase() !== proof.root.toLowerCase()) {
    return { status: "verification_failed", computedHash, reasons: [...reasons, "The root stored on the contract does not match this batch root."] };
  }
  reasons.push("The batch root matches the value currently stored on the recorded contract.");
  return { status: "onchain_anchor_verified", computedHash, reasons };
}

export function findSeqGaps(seqs: readonly number[]): number[] {
  if (seqs.length === 0) {
    return [];
  }
  const sorted = [...seqs].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const current = sorted[i]!;
    for (let seq = prev + 1; seq < current; seq += 1) {
      missing.push(seq);
    }
  }
  return missing;
}

export function findDuplicateSeqs(seqs: readonly number[]): number[] {
  const seen = new Set<number>();
  const dupes: number[] = [];
  for (const seq of seqs) {
    if (seen.has(seq)) {
      dupes.push(seq);
    }
    seen.add(seq);
  }
  return dupes;
}
