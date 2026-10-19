import type { CanonicalEventInput } from "@/lib/verify/canonical";
import type { AnchorObservationJson } from "@/lib/verify/anchor";
import type { ArtifactView } from "@/lib/verify/artifacts";
import type { AnchorRecord } from "@/lib/verify/chain";
import type { PublicProvenance } from "@/lib/verify/provenance";
import type { TransferEvidence } from "@/lib/world/transfer";

export type VerifyBundle = {
  schema: "chogos-verify-export-v2";
  event: CanonicalEventInput;
  storedHash: string | null;
  /** Convenience digest from this server. Recompute it. Do not trust it as a status. */
  serverRecomputedHash: string | null;
  integrityClass: "historical" | "live" | null;
  previous: { seq: number; hash: string; prevEventHash: string | null } | null;
  next: { seq: number; hash: string; prevEventHash: string | null } | null;
  proof: { format: string; leafEncoding: string[]; root: string; proof: string[] } | null;
  batch: {
    id: string;
    kind: string;
    treeFormat: string;
    fromSeq: number;
    toSeq: number;
    eventCount: number;
    merkleRoot: string;
    snapshotCommittedAt: string | null;
    anchorStatus: string;
  } | null;
  anchor: AnchorRecord;
  anchorObservation: AnchorObservationJson | null;
  anchorRead: { attempted: boolean; reason: string };
  anchorIssue: string | null;
  explorerTxUrl: string | null;
  explorerContractUrl: string | null;
  explorerBlockUrl: string | null;
  transfer: TransferEvidence | null;
  provenance: PublicProvenance;
  artifacts: ArtifactView[];
  eventPath: string;
  reviewerChecks: string[];
  notes: string[];
};
