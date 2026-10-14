import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";

/**
 * Must match EventAnchor.TREE_FORMAT and event_integrity_batches.tree_format.
 * OpenZeppelin StandardMerkleTree with leaf type bytes32:
 * leaf = keccak256(bytes.concat(keccak256(abi.encode(eventHash))))
 * parent = keccak256(concat(sort(left, right)))  // commutative, matches MerkleProof.sol
 * sortLeaves is off so the committed tree shape follows sequence order.
 * Single-leaf proofs remain compatible with OpenZeppelin MerkleProof.verify.
 */
export const TREE_FORMAT = "openzeppelin-standard-v1";
export const LEAF_ENCODING = ["bytes32"] as const;

export type MerkleProof = {
  format: typeof TREE_FORMAT;
  leafEncoding: typeof LEAF_ENCODING;
  hash: Hex;
  proof: Hex[];
  root: Hex;
};

export type EventMerkleTree = {
  format: typeof TREE_FORMAT;
  root: Hex;
  hashes: Hex[];
  tree: StandardMerkleTree<[string]>;
};

function asHash(value: string): Hex {
  const lower = value.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(lower)) {
    throw new Error("Merkle leaves must be 0x-prefixed 32-byte hashes.");
  }
  return lower;
}

/** Leaves are event hashes in seq order. sortLeaves is off so order is committed. */
export function buildEventTree(hashes: readonly string[]): EventMerkleTree {
  if (hashes.length === 0) {
    throw new Error("A Merkle batch needs at least one event hash.");
  }
  const unique = new Set<string>();
  const normalized = hashes.map((hash) => {
    const next = asHash(hash);
    if (unique.has(next)) {
      throw new Error("Duplicate event hashes cannot be leaves in one batch.");
    }
    unique.add(next);
    return next;
  });
  const tree = StandardMerkleTree.of(
    normalized.map((hash) => [hash] as [string]),
    [...LEAF_ENCODING],
    { sortLeaves: false },
  );
  return {
    format: TREE_FORMAT,
    root: tree.root as Hex,
    hashes: normalized,
    tree,
  };
}

export function proofForHash(built: EventMerkleTree, hash: string): MerkleProof {
  const want = asHash(hash);
  for (const [index, value] of built.tree.entries()) {
    if (value[0]?.toLowerCase() === want) {
      return {
        format: TREE_FORMAT,
        leafEncoding: LEAF_ENCODING,
        hash: want,
        proof: built.tree.getProof(index) as Hex[],
        root: built.root,
      };
    }
  }
  throw new Error("That event hash is not in this Merkle batch.");
}

export function verifyInclusion(root: string, hash: string, proof: readonly string[], format = TREE_FORMAT): boolean {
  if (format !== TREE_FORMAT) {
    return false;
  }
  try {
    return StandardMerkleTree.verify(root, [...LEAF_ENCODING], [asHash(hash)], [...proof]);
  } catch {
    return false;
  }
}

export function dumpTree(built: EventMerkleTree): unknown {
  return built.tree.dump();
}

export function loadDumpedTree(dump: unknown): EventMerkleTree {
  const tree = StandardMerkleTree.load(dump as never) as StandardMerkleTree<[string]>;
  if (tree.root === "0x" || !tree.root) {
    throw new Error("Merkle dump is missing a root.");
  }
  const hashes: Hex[] = [];
  for (const [, value] of tree.entries()) {
    hashes.push(asHash(value[0] ?? ""));
  }
  return { format: TREE_FORMAT, root: tree.root as Hex, hashes, tree };
}
