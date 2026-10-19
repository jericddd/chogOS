import { describe, expect, it } from "vitest";
import { canonicalEventDocument, hashEvent } from "@/lib/verify/canonical";
import { deploymentArtifacts } from "@/lib/verify/artifacts";
import {
  buildPublicProvenance,
  commitUrl,
  publicBuildRevision,
  sourceFileUrl,
} from "@/lib/verify/provenance";

const sample = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  seq: 12,
  kind: "citizen.acted",
  category: "ai",
  source: "ai",
  summary: "An AI citizen planned a workshop.",
  occurredAt: "2026-10-13T01:02:03.040Z",
  createdAt: "2026-10-13T01:02:03.041Z",
  chainStatus: "offchain",
  payload: { note: "world event" },
  stateTransition: {},
  prevEventHash: null,
};

describe("public build revision", () => {
  it("stays unavailable when no full commit is configured", () => {
    expect(publicBuildRevision({}).label).toBe("Build revision unavailable");
    expect(publicBuildRevision({ VERCEL_GIT_COMMIT_SHA: "abc" }).sha).toBeNull();
    expect(publicBuildRevision({ GITHUB_SHA: "main" }).label).toBe("Build revision unavailable");
    expect(commitUrl(null)).toBeNull();
    expect(sourceFileUrl(null, "src/lib/verify/canonical.ts")).toBeNull();
    expect(sourceFileUrl("a".repeat(40), "../secrets")).toBeNull();
  });

  it("uses a Vercel or GitHub commit and links that exact revision", () => {
    const sha = "a".repeat(40);
    expect(publicBuildRevision({ VERCEL_GIT_COMMIT_SHA: sha.toUpperCase() })).toEqual({
      sha,
      label: "Vercel git commit",
    });
    expect(publicBuildRevision({ GITHUB_SHA: `b`.repeat(40) }).label).toBe("GitHub Actions commit");
    const provenance = buildPublicProvenance({ VERCEL_GIT_COMMIT_SHA: sha });
    expect(provenance.commitUrl).toBe(`https://github.com/jericddd/chogOS/commit/${sha}`);
    expect(provenance.sources.find((source) => source.path === "src/lib/verify/canonical.ts")?.url).toBe(
      `https://github.com/jericddd/chogOS/blob/${sha}/src/lib/verify/canonical.ts`,
    );
    expect(JSON.stringify(provenance)).not.toMatch(/SERVICE_ROLE|MONAD_RPC|PRIVATE_KEY|rpcUrl/i);
  });
});

describe("independent event digest", () => {
  it("recomputes the same SHA-256 from a JSON round trip", () => {
    const exported = JSON.parse(JSON.stringify(sample)) as typeof sample;
    expect(canonicalEventDocument(exported)).toBe(canonicalEventDocument(sample));
    expect(hashEvent(exported)).toBe(hashEvent(sample));
    expect(hashEvent(exported)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("publishes predicted artifact hashes without secrets or a deployed-wallet claim", () => {
    const body = JSON.stringify(deploymentArtifacts());
    expect(body).toContain("0x19c106f6993aad95c63cf742ec0eec9323f889a6feefd7ee8897768d216f1251");
    expect(body).toContain("predicted_not_deployed");
    expect(body).not.toMatch(/SERVICE_ROLE|MONAD_RPC|PRIVATE_KEY|onchain_anchor_verified/);
  });
});
