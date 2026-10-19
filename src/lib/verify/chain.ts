import { assessAnchorObservation, OFFCHAIN_ROOT_SENTENCE, type AnchorObservationJson } from "@/lib/verify/anchor";
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
  blockNumber: string | null;
  root: string;
  batchId: string;
} | null;

export type BatchSpan = {
  fromSeq: number;
  toSeq: number;
  eventCount: number;
};

export type LocalVerifyInput = {
  event: CanonicalEventInput;
  storedHash: string | null;
  integrityClass: "historical" | "live" | null;
  previous?: ChainLink | null;
  next?: ChainLink | null;
  proof?: { format: string; root: string; proof: string[] } | null;
  expectedRoot?: string | null;
  batchSpan?: BatchSpan | null;
  anchor?: AnchorRecord;
  /** Database anchor status. A confirmed value is not a live check. */
  recordedAnchorStatus?: string | null;
  /** Set when the recorded anchor identifiers are malformed. */
  anchorIssue?: string | null;
  /**
   * Raw read-only RPC observation. A root string, a database status, or an
   * explorer link cannot produce onchain_anchor_verified.
   */
  anchorObservation?: AnchorObservationJson | null;
};

export type LocalVerifyResult = {
  status: VerifyStatus;
  computedHash: string | null;
  reasons: string[];
};

/**
 * Recomputes integrity locally. API success is not a status.
 * onchain_anchor_verified requires assessAnchorObservation to accept a live read.
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
  reasons.push(
    "Merkle inclusion proof matches the supplied batch root. That shows the leaf is in that root. It does not publish the root onchain, and it does not prove the event describes a real-world occurrence.",
  );

  if (input.anchorIssue) {
    return { status: "verification_failed", computedHash, reasons: [...reasons, input.anchorIssue] };
  }

  if (!input.anchorObservation) {
    if (input.recordedAnchorStatus === "failed") {
      return {
        status: "merkle_proof_verified",
        computedHash,
        reasons: [...reasons, `The recorded anchor status is failed. ${OFFCHAIN_ROOT_SENTENCE}`],
      };
    }
    if (input.anchor || input.recordedAnchorStatus === "submitted" || input.recordedAnchorStatus === "confirmed") {
      return {
        status: "merkle_proof_verified",
        computedHash,
        reasons: [
          ...reasons,
          "An anchor is recorded, but this check did not read the contract. A database status, transaction hash, or explorer link is not an onchain root.",
        ],
      };
    }
    return {
      status: "merkle_proof_verified",
      computedHash,
      reasons: [...reasons, OFFCHAIN_ROOT_SENTENCE],
    };
  }

  const span = input.batchSpan;
  const root = input.expectedRoot ?? proof.root;
  if (!input.anchor || !span || !root) {
    return {
      status: "verification_failed",
      computedHash,
      reasons: [...reasons, "An anchor observation was supplied without the batch range, chain, or root needed to check it."],
    };
  }
  let blockNumber: bigint | null = null;
  if (input.anchor.blockNumber) {
    if (!/^[0-9]+$/.test(input.anchor.blockNumber)) {
      return {
        status: "verification_failed",
        computedHash,
        reasons: [...reasons, "The recorded anchor block is not a decimal number."],
      };
    }
    blockNumber = BigInt(input.anchor.blockNumber);
  }
  const assessment = assessAnchorObservation(
    {
      chainId: input.anchor.chainId,
      root,
      fromSeq: BigInt(span.fromSeq),
      toSeq: BigInt(span.toSeq),
      eventCount: span.eventCount,
      blockNumber,
    },
    input.anchorObservation,
  );
  if (assessment.pending) {
    return { status: "merkle_proof_verified", computedHash, reasons: [...reasons, ...assessment.reasons] };
  }
  if (!assessment.ok) {
    return { status: "verification_failed", computedHash, reasons: [...reasons, ...assessment.reasons] };
  }
  return {
    status: "onchain_anchor_verified",
    computedHash,
    reasons: [
      ...reasons,
      ...assessment.reasons,
      "EventAnchor stores the root only. It does not verify this inclusion proof and it does not prove the event is true.",
    ],
  };
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
