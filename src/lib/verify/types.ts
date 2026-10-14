import type { CanonicalEventInput } from "@/lib/verify/canonical";
import type { AnchorRecord } from "@/lib/verify/chain";

export type VerifyBundle = {
  schema: "chogos-verify-export-v1";
  event: CanonicalEventInput;
  storedHash: string | null;
  integrityClass: "historical" | "live" | null;
  previous: { seq: number; hash: string; prevEventHash: string | null } | null;
  next: { seq: number; hash: string; prevEventHash: string | null } | null;
  proof: { format: string; root: string; proof: string[] } | null;
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
  explorerTxUrl: string | null;
  explorerContractUrl: string | null;
  notes: string[];
};
