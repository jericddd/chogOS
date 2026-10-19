export const REPOSITORY_URL = "https://github.com/jericddd/chogOS";

export const VERIFICATION_SOURCE_FILES = [
  "src/lib/verify/canonical.ts",
  "src/lib/verify/merkle.ts",
  "src/lib/verify/chain.ts",
  "src/lib/verify/anchor.ts",
  "src/lib/verify/transfer-log.ts",
  "src/lib/world/transfer.ts",
  "src/components/verify/event-verifier.tsx",
  "contracts/src/EventAnchor.sol",
] as const;

const SHA = /^[0-9a-f]{40}$/i;

export type BuildRevision = {
  sha: string | null;
  label: "Build revision unavailable" | "Vercel git commit" | "GitHub Actions commit";
};

/**
 * Public commit of the running build. Branch heads are not a substitute:
 * a missing variable stays unavailable.
 */
export function publicBuildRevision(env?: {
  VERCEL_GIT_COMMIT_SHA?: string;
  GITHUB_SHA?: string;
}): BuildRevision {
  const source = env ?? {
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    GITHUB_SHA: process.env.GITHUB_SHA,
  };
  const vercel = source.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercel && SHA.test(vercel)) {
    return { sha: vercel.toLowerCase(), label: "Vercel git commit" };
  }
  const github = source.GITHUB_SHA?.trim();
  if (github && SHA.test(github)) {
    return { sha: github.toLowerCase(), label: "GitHub Actions commit" };
  }
  return { sha: null, label: "Build revision unavailable" };
}

export function commitUrl(sha: string | null): string | null {
  if (!sha || !SHA.test(sha)) {
    return null;
  }
  return `${REPOSITORY_URL}/commit/${sha.toLowerCase()}`;
}

export function sourceFileUrl(sha: string | null, path: string): string | null {
  if (!sha || !SHA.test(sha) || path.startsWith("/") || path.includes("..")) {
    return null;
  }
  return `${REPOSITORY_URL}/blob/${sha.toLowerCase()}/${path}`;
}

export type PublicProvenance = {
  repository: string;
  revision: BuildRevision;
  commitUrl: string | null;
  sources: { path: string; url: string | null }[];
};

export function buildPublicProvenance(env?: {
  VERCEL_GIT_COMMIT_SHA?: string;
  GITHUB_SHA?: string;
}): PublicProvenance {
  const revision = publicBuildRevision(env);
  return {
    repository: REPOSITORY_URL,
    revision,
    commitUrl: commitUrl(revision.sha),
    sources: VERIFICATION_SOURCE_FILES.map((path) => ({ path, url: sourceFileUrl(revision.sha, path) })),
  };
}

export const REVIEWER_CHECKS = [
  "Recompute the SHA-256 of the chogos-event-v1 canonical document from event. Do not trust serverRecomputedHash or any status label.",
  "Compare that digest to storedHash.",
  "When previous and next are present, check that the live hash chain links match.",
  "Verify the OpenZeppelin standard Merkle proof: leaf encoding bytes32, sortLeaves false, against batch.merkleRoot.",
  "A valid inclusion proof means the leaf matches the supplied root. It does not prove the root was published onchain.",
  "When anchorObservation is present, repeat eth_chainId, eth_getCode, the transaction receipt, and EventAnchor.getBatch on the recorded chain. The embedded observation is one server read, not a proof by itself.",
  "EventAnchor stores roots only. It does not verify inclusion and it does not prove the event happened.",
  "For an nft.transferred row, compare chain 143, the Chog Genesis contract, transaction hash, block, block hash, log index, sender, receiver, and token id with the explorer log. chain_status confirmed is not that comparison. transferLog.matched is true only after a read-only receipt check matched.",
  "Do not send event data to a third-party hashing site.",
] as const;
