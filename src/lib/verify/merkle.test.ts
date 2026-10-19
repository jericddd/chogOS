import { describe, expect, it } from "vitest";
import { emptyObservation, OFFCHAIN_ROOT_SENTENCE, treeFormatHash, type AnchorObservationJson } from "@/lib/verify/anchor";
import { hashEvent } from "@/lib/verify/canonical";
import { findDuplicateSeqs, findSeqGaps, verifyEventLocally } from "@/lib/verify/chain";
import { buildEventTree, dumpTree, loadDumpedTree, proofForHash, TREE_FORMAT, verifyInclusion } from "@/lib/verify/merkle";

function observed(root: string, patch: Partial<AnchorObservationJson> = {}): AnchorObservationJson {
  const event = {
    batchId: "0x" + "11".repeat(32),
    merkleRoot: root,
    fromSeq: "1",
    toSeq: "1",
    eventCount: 1,
    treeFormat: treeFormatHash(),
  };
  return emptyObservation({
    observedChainId: 10143,
    codeBytes: 32,
    receiptStatus: "success",
    receiptBlock: "1",
    event,
    storedBatch: { ...event, anchoredAt: "10" },
    ...patch,
  });
}

const h = (n: number) =>
  hashEvent({
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee" + String(n).padStart(2, "0"),
    seq: n,
    kind: "probe",
    category: "world",
    source: "system",
    summary: `n=${n}`,
    occurredAt: "2026-10-13T00:00:00.000Z",
    createdAt: "2026-10-13T00:00:00.000Z",
    chainStatus: "offchain",
    payload: { n },
  });

describe("merkle batches", () => {
  it("proves inclusion and rejects tampers, duplicates, and format mismatches", () => {
    const hashes = [h(1), h(2), h(3)];
    const tree = buildEventTree(hashes);
    expect(tree.format).toBe(TREE_FORMAT);
    const proof = proofForHash(tree, hashes[1]!);
    expect(verifyInclusion(tree.root, hashes[1]!, proof.proof)).toBe(true);
    expect(verifyInclusion(tree.root, hashes[1]!, ["0x" + "00".repeat(32)])).toBe(false);
    expect(verifyInclusion(tree.root, h(9), proof.proof)).toBe(false);
    expect(verifyInclusion(tree.root, hashes[1]!, proof.proof, "other-format")).toBe(false);
    const reordered = buildEventTree([hashes[2]!, hashes[1]!, hashes[0]!]);
    expect(reordered.root).not.toBe(tree.root);
    expect(() => buildEventTree([hashes[0]!, hashes[0]!])).toThrow(/Duplicate/);
    const loaded = loadDumpedTree(dumpTree(tree));
    expect(loaded.root).toBe(tree.root);
    expect(verifyInclusion(loaded.root, hashes[1]!, proofForHash(loaded, hashes[1]!).proof)).toBe(true);
  });
});

describe("local verifier statuses", () => {
  it("does not treat API success or a hash match as an onchain anchor", () => {
    const event = {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01",
      seq: 1,
      kind: "probe",
      category: "world",
      source: "system",
      summary: "n=1",
      occurredAt: "2026-10-13T00:00:00.000Z",
      createdAt: "2026-10-13T00:00:00.000Z",
      chainStatus: "offchain",
      payload: { n: 1 },
      prevEventHash: null,
    };
    const stored = hashEvent(event);
    expect(verifyEventLocally({ event, storedHash: null, integrityClass: null }).status).toBe("unverified");
    expect(verifyEventLocally({ event, storedHash: stored, integrityClass: "historical" }).status).toBe(
      "event_hash_verified",
    );
    expect(
      verifyEventLocally({
        event: { ...event, source: "ai" },
        storedHash: stored,
        integrityClass: "historical",
      }).status,
    ).toBe("verification_failed");
    const live = verifyEventLocally({ event, storedHash: stored, integrityClass: "live" });
    expect(live.status).toBe("log_integrity_verified");
    const tree = buildEventTree([stored]);
    const proof = proofForHash(tree, stored);
    expect(
      verifyEventLocally({
        event,
        storedHash: stored,
        integrityClass: "live",
        proof: { format: TREE_FORMAT, root: tree.root, proof: proof.proof },
        expectedRoot: tree.root,
      }).status,
    ).toBe("merkle_proof_verified");
    const anchor = {
      chainId: 10143,
      contract: "0x0000000000000000000000000000000000000001",
      txHash: "0x" + "11".repeat(32),
      blockNumber: "1",
      root: tree.root,
      batchId: "batch",
    };
    const span = { fromSeq: 1, toSeq: 1, eventCount: 1 };
    const base = {
      event,
      storedHash: stored,
      integrityClass: "live" as const,
      proof: { format: TREE_FORMAT, root: tree.root, proof: proof.proof },
      expectedRoot: tree.root,
      batchSpan: span,
    };
    const absent = verifyEventLocally(base);
    expect(absent.status).toBe("merkle_proof_verified");
    expect(absent.reasons).toContain(OFFCHAIN_ROOT_SENTENCE);
    const recordedOnly = verifyEventLocally({
      ...base,
      anchor,
      recordedAnchorStatus: "confirmed",
    });
    expect(recordedOnly.status).toBe("merkle_proof_verified");
    expect(recordedOnly.status).not.toBe("onchain_anchor_verified");
    expect(recordedOnly.reasons.join(" ")).toMatch(/did not read the contract/);
    const pending = verifyEventLocally({
      ...base,
      anchor,
      recordedAnchorStatus: "submitted",
      anchorObservation: observed(tree.root, { receiptStatus: "missing", event: null, storedBatch: null }),
    });
    expect(pending.status).toBe("merkle_proof_verified");
    expect(pending.reasons.join(" ")).toMatch(/no confirmed receipt/);
    expect(
      verifyEventLocally({
        ...base,
        anchor,
        recordedAnchorStatus: "failed",
      }).reasons.join(" "),
    ).toMatch(/status is failed/);
    expect(
      verifyEventLocally({
        ...base,
        anchor: { ...anchor, chainId: 10143 },
        anchorObservation: observed(tree.root, { observedChainId: 143 }),
      }).status,
    ).toBe("verification_failed");
    expect(
      verifyEventLocally({
        ...base,
        anchor,
        anchorObservation: observed("0x" + "00".repeat(32)),
      }).status,
    ).toBe("verification_failed");
    expect(
      verifyEventLocally({
        ...base,
        anchor,
        anchorObservation: emptyObservation({ rpcError: "timeout" }),
      }).status,
    ).toBe("verification_failed");
    const anchored = verifyEventLocally({
      ...base,
      anchor,
      anchorObservation: observed(tree.root),
    });
    expect(anchored.status).toBe("onchain_anchor_verified");
    expect(anchored.reasons.join(" ")).toMatch(/stores the root only/);
    expect(
      verifyEventLocally({
        event,
        storedHash: stored,
        integrityClass: "live",
        previous: { seq: 0, hash: "0x" + "ab".repeat(32), prevEventHash: null },
      }).status,
    ).toBe("verification_failed");
    expect(findSeqGaps([1, 2, 4])).toEqual([3]);
    expect(findDuplicateSeqs([1, 2, 2])).toEqual([2]);
  });
});
