import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createProviderFromConfig } from "@/lib/ai/resolve";
import type { GenesisChainReader } from "@/lib/blockchain/genesis-reader";
import { selectVerifiedHoldings, type InventoryRead, type OwnerObservation } from "@/lib/blockchain/holdings";
import { resolveDiscoveryCandidates } from "@/lib/civilization/candidates";
import { createEnrollmentChallenge, submitEnrollment } from "@/lib/civilization/enrollment-flow";
import { canActAsCurrentOwner, planCommunityEnrollment } from "@/lib/civilization/plan";
import { mergeCitizensForDisplay } from "@/lib/civilization/roster";
import { foundingCountLabel } from "@/lib/civilization/labels";
import { MemoryCivilizationStore } from "@/lib/civilization/memory-store";
import { resolveTokenMetadata } from "@/lib/civilization/metadata-load";
import { presentMetadata } from "@/lib/civilization/metadata";
import { synchronizeGenesis } from "@/lib/civilization/sync-genesis";
import { parseTokenId } from "@/lib/civilization/token-id";
import { readAppConfig } from "@/lib/config/env";
import { verifyIndexerCandidates } from "@/lib/civilization/indexer";

const treasury = getAddress("0x84113421A8a564b594ee9Ae78c875310332d7023");
const nft = getAddress("0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763");
const other = getAddress("0x00000000000000000000000000000000000000aa");
const walletC = getAddress("0x00000000000000000000000000000000000000cc");
const zero = getAddress("0x0000000000000000000000000000000000000000");
const now = "2026-10-10T00:00:00.000Z";

function inventory(tokenIds: string[] | null, balanceOf: number | null = tokenIds?.length ?? null): InventoryRead {
  return {
    blockNumber: "112267577",
    balanceOf,
    balanceError: null,
    tokensOfOwner: tokenIds,
    tokensOfOwnerError: tokenIds ? null : "tokensOfOwner reverted.",
  };
}

function reader(options: {
  inventory?: InventoryRead;
  owners?: Record<string, Address | "fail">;
}): GenesisChainReader {
  const owners = options.owners ?? {};
  const readOwner = async (tokenId: string): Promise<OwnerObservation> => {
    const owner = owners[tokenId] ?? treasury;
    if (owner === "fail") {
      return { tokenId, status: "failed", reason: "ownerOf reverted." };
    }
    return { tokenId, status: "owner", owner };
  };
  return {
    async readOwnedInventory() {
      return options.inventory ?? inventory(["7"]);
    },
    async readOwners(tokenIds) {
      return Promise.all(tokenIds.map((tokenId) => readOwner(tokenId)));
    },
    readOwner,
    async readTokenUri() {
      return null;
    },
  };
}

describe("treasury discovery", () => {
  it("keeps only ids whose ownerOf matches the treasury", () => {
    const selected = selectVerifiedHoldings(
      [
        { tokenId: "7", status: "owner", owner: treasury },
        { tokenId: "8", status: "owner", owner: other },
        { tokenId: "9", status: "failed", reason: "ownerOf reverted." },
      ],
      treasury,
    );
    expect(selected.verified.map((holding) => holding.tokenId)).toEqual(["7"]);
    expect(selected.rejected).toHaveLength(2);
  });

  it("does not invent token ids when discovery is unavailable", () => {
    const resolution = resolveDiscoveryCandidates({
      tokensOfOwner: null,
      indexer: { status: "unconfigured" },
    });
    expect(resolution.source).toBe("unavailable");
    expect(resolution.tokenIds).toEqual([]);
  });

  it("drops stale indexer ids that fail ownerOf", () => {
    const checked = verifyIndexerCandidates({
      candidates: ["7", "999", "nope"],
      owners: { "7": treasury, "999": other },
      treasury,
    });
    expect(checked.verified).toEqual(["7"]);
    expect(checked.stale).toEqual(["999", "nope"]);
  });

  it("rejects invalid token ids", () => {
    expect(parseTokenId("nope").ok).toBe(false);
    expect(parseTokenId("-1").ok).toBe(false);
    expect(parseTokenId("1.5").ok).toBe(false);
    expect(parseTokenId("007")).toEqual({ ok: true, tokenId: "7" });
  });

  it("describes a count other than the expected 59", () => {
    const discrepancy = "Verified treasury NFTs: 58. The expected founding count was 59.";
    expect(foundingCountLabel(58, 59, discrepancy)).toContain("58 Chog NFTs");
    expect(foundingCountLabel(58, 59, discrepancy)).toContain(discrepancy);
    expect(foundingCountLabel(59, 59, null)).toBe("59 Chog NFTs verified in ChogTreasury.");
  });
});

describe("genesis synchronization", () => {
  it("persists a verified holding once and ignores a repeated sync", async () => {
    const store = new MemoryCivilizationStore();
    const chain = reader({ inventory: inventory(["7", "52"]), owners: { "7": treasury, "52": treasury } });
    const first = await synchronizeGenesis({
      reader: chain,
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    const second = await synchronizeGenesis({
      reader: chain,
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (second.status === "succeeded") {
      expect(second.created).toBe(0);
    }
    expect(store.citizens).toHaveLength(2);
    expect(store.events).toHaveLength(2);
    expect(store.citizens.every((citizen) => citizen.origin === "founding_treasury")).toBe(true);
    expect(
      store.citizens.every((citizen) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(citizen.id),
      ),
    ).toBe(true);
  });

  it("does not store a stale indexer id", async () => {
    const store = new MemoryCivilizationStore();
    const result = await synchronizeGenesis({
      reader: reader({
        inventory: inventory(["7"]),
        owners: { "7": treasury, "999": other },
      }),
      store,
      indexer: { status: "ok", tokenIds: ["7", "999"] },
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(store.citizens.map((citizen) => citizen.tokenId)).toEqual(["7"]);
    if (result.status === "succeeded") {
      expect(result.warnings.some((warning) => warning.includes("999"))).toBe(true);
    }
  });

  it("leaves founding membership unchanged when a recheck fails", async () => {
    const store = new MemoryCivilizationStore();
    await synchronizeGenesis({
      reader: reader({ inventory: inventory(["7"]), owners: { "7": treasury } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    const result = await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "7": "fail" } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:01:00.000Z",
      minIntervalMs: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(store.citizens[0]?.foundingMembershipActive).toBe(true);
    expect(store.citizens[0]?.rosterVerification).toBe("stale");
  });

  it("updates the owner when a founding NFT leaves the treasury and keeps the citizen", async () => {
    const store = new MemoryCivilizationStore();
    await synchronizeGenesis({
      reader: reader({ inventory: inventory(["7"]), owners: { "7": treasury } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    const citizenId = store.citizens[0]?.id;
    store.citizens[0]!.metadataName = "Mossy";
    const joined = store.events.length;
    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "7": other } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:02:00.000Z",
      minIntervalMs: 0,
    });
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.id).toBe(citizenId);
    expect(store.citizens[0]?.metadataName).toBe("Mossy");
    expect(store.citizens[0]?.origin).toBe("founding_treasury");
    expect(store.citizens[0]?.foundingMembershipActive).toBe(true);
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.observedOwner).toBe(other);
    expect(store.events.length).toBe(joined);
    expect(store.events.some((event) => event.kind === "genesis_left")).toBe(false);

    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "7": other } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:03:00.000Z",
      minIntervalMs: 0,
    });
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.id).toBe(citizenId);
    expect(store.citizens[0]?.metadataName).toBe("Mossy");
    expect(store.events.length).toBe(joined);
  });

  it("keeps every enrolled citizen when one of 59 founding NFTs leaves the treasury", async () => {
    const ids = Array.from({ length: 59 }, (_, index) => String(index + 1));
    const store = new MemoryCivilizationStore();
    await synchronizeGenesis({
      reader: reader({
        inventory: inventory(ids),
        owners: Object.fromEntries(ids.map((id) => [id, treasury])),
      }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    const moved = store.citizens.find((citizen) => citizen.tokenId === "1");
    expect(moved).toBeTruthy();
    moved!.metadataName = "Kept";
    await synchronizeGenesis({
      reader: reader({
        inventory: inventory(ids.filter((id) => id !== "1")),
        owners: { "1": other },
      }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:04:00.000Z",
      minIntervalMs: 0,
    });
    expect(store.citizens).toHaveLength(59);
    expect(store.citizens.filter((citizen) => citizen.enrollmentStatus === "active")).toHaveLength(59);
    const after = store.citizens.find((citizen) => citizen.tokenId === "1");
    expect(after?.id).toBe(moved!.id);
    expect(after?.metadataName).toBe("Kept");
    expect(after?.foundingMembershipActive).toBe(true);
    expect(after?.observedOwner).toBe(other);
    const display = mergeCitizensForDisplay({
      liveTokenIds: ids.filter((id) => id !== "1"),
      treasury,
      citizens: store.citizens,
      chainId: 143,
      nftContract: nft,
    });
    expect(display.find((citizen) => citizen.tokenId === "1")).toMatchObject({
      verification: "enrolled",
      designation: "Founding citizen",
      owner: other,
      citizenId: moved!.id,
    });
  });

  it("follows A to B to C and A to B to A without duplicating the citizen", async () => {
    const store = new MemoryCivilizationStore();
    const syncAt = async (owner: Address, at: string) => {
      await synchronizeGenesis({
        reader: reader({
          inventory: owner === treasury ? inventory(["7"]) : inventory([]),
          owners: { "7": owner },
        }),
        store,
        treasury,
        nftContract: nft,
        chainId: 143,
        expectedCount: 59,
        now: at,
        minIntervalMs: 0,
      });
    };
    await syncAt(treasury, now);
    const citizenId = store.citizens[0]?.id;
    store.citizens[0]!.metadataDescription = "same citizen";
    await syncAt(other, "2026-10-10T00:05:00.000Z");
    await syncAt(walletC, "2026-10-10T00:06:00.000Z");
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.id).toBe(citizenId);
    expect(store.citizens[0]?.observedOwner).toBe(walletC);
    expect(store.citizens[0]?.metadataDescription).toBe("same citizen");
    await syncAt(other, "2026-10-10T00:07:00.000Z");
    await syncAt(treasury, "2026-10-10T00:08:00.000Z");
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.id).toBe(citizenId);
    expect(store.citizens[0]?.observedOwner).toBe(treasury);
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.foundingMembershipActive).toBe(true);
    expect(canActAsCurrentOwner(other, treasury)).toBe(false);
    expect(canActAsCurrentOwner(treasury, treasury)).toBe(true);
  });

  it("keeps the citizen when ownerOf fails or the token is burned", async () => {
    const store = new MemoryCivilizationStore();
    await synchronizeGenesis({
      reader: reader({ inventory: inventory(["7"]), owners: { "7": treasury } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    const failed = await synchronizeGenesis({
      reader: reader({ inventory: inventory(null), owners: { "7": "fail" } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:09:00.000Z",
      minIntervalMs: 0,
    });
    expect(failed.status).toBe("failed");
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.observedOwner).toBe(treasury);

    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "7": zero } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:10:00.000Z",
      minIntervalMs: 0,
    });
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.foundingMembershipActive).toBe(true);
    expect(store.citizens[0]?.observedOwner).toBe(zero);
    expect(canActAsCurrentOwner(zero, zero)).toBe(false);
  });

  it("reports a database failure and does not claim the roster was saved", async () => {
    const store = new MemoryCivilizationStore();
    store.armFailure("persist");
    const result = await synchronizeGenesis({
      reader: reader({ inventory: inventory(["7"]) }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    expect(result.status).toBe("failed");
    expect(store.citizens).toHaveLength(0);
    expect((await store.latestSync())?.status).toBe("failed");
  });

  it("reports a database failure while starting a sync", async () => {
    const store = new MemoryCivilizationStore();
    store.armFailure("begin");
    const result = await synchronizeGenesis({
      reader: reader({}),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Database");
    }
  });
});

describe("community enrollment", () => {
  it("rejects a signer who is not the current owner", () => {
    const decision = planCommunityEnrollment({
      existing: null,
      signer: other,
      onChainOwner: treasury,
      treasury,
      nftContract: nft,
      chainId: 143,
      tokenId: "7",
      blockNumber: "1",
      now,
      nextId: () => "c1",
    });
    expect(decision.action).toBe("reject");
  });

  it("enrolls an owned NFT and refuses a duplicate citizen", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const store = new MemoryCivilizationStore();
    const chain = reader({
      inventory: inventory(["15"], 1),
      owners: { "15": account.address },
    });
    const challenge = await createEnrollmentChallenge({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      tokenIds: ["015"],
      now: new Date(now),
    });
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) {
      return;
    }
    const signature = await account.signMessage({ message: challenge.message });
    const first = await submitEnrollment({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      nonce: challenge.nonce,
      signature,
      now: new Date(now),
    });
    expect(first.ok).toBe(true);
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.origin).toBe("community");

    const again = await createEnrollmentChallenge({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      tokenIds: ["15"],
      now: new Date("2026-10-10T00:05:00.000Z"),
    });
    if (!again.ok) {
      throw new Error(again.error);
    }
    const second = await submitEnrollment({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      nonce: again.nonce,
      signature: await account.signMessage({ message: again.message }),
      now: new Date("2026-10-10T00:05:00.000Z"),
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.unchanged).toHaveLength(1);
    }
    expect(store.citizens).toHaveLength(1);
  });

  it("lets the new owner claim a founding NFT that left the treasury", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const former = privateKeyToAccount(generatePrivateKey());
    const store = new MemoryCivilizationStore();
    await synchronizeGenesis({
      reader: reader({ inventory: inventory(["7"]), owners: { "7": treasury } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now,
      minIntervalMs: 0,
    });
    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "7": account.address } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:03:00.000Z",
      minIntervalMs: 0,
    });

    const chain = reader({
      inventory: inventory(["7"], 1),
      owners: { "7": account.address },
    });
    const challenge = await createEnrollmentChallenge({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      tokenIds: ["7"],
      now: new Date("2026-10-10T00:04:00.000Z"),
    });
    if (!challenge.ok) {
      throw new Error(challenge.error);
    }
    const claimed = await submitEnrollment({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      nonce: challenge.nonce,
      signature: await account.signMessage({ message: challenge.message }),
      now: new Date("2026-10-10T00:04:00.000Z"),
    });
    expect(claimed.ok).toBe(true);
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.origin).toBe("founding_treasury");
    expect(store.citizens[0]?.foundingMembershipActive).toBe(true);
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.observedOwner).toBe(account.address);
    expect(canActAsCurrentOwner(account.address, account.address)).toBe(true);
    expect(canActAsCurrentOwner(former.address, account.address)).toBe(false);

    const stolen = await createEnrollmentChallenge({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: former.address,
      tokenIds: ["7"],
      now: new Date("2026-10-10T00:06:00.000Z"),
    });
    expect(stolen.ok).toBe(false);
  });

  it("enrolls a new NFT once and keeps that citizen after a later transfer", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const buyer = privateKeyToAccount(generatePrivateKey());
    const store = new MemoryCivilizationStore();
    const chain = reader({
      inventory: inventory(["21"], 1),
      owners: { "21": account.address },
    });
    const challenge = await createEnrollmentChallenge({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      tokenIds: ["21"],
      now: new Date(now),
    });
    if (!challenge.ok) {
      throw new Error(challenge.error);
    }
    const enrolled = await submitEnrollment({
      store,
      reader: chain,
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      nonce: challenge.nonce,
      signature: await account.signMessage({ message: challenge.message }),
      now: new Date(now),
    });
    expect(enrolled.ok).toBe(true);
    const citizenId = store.citizens[0]?.id;
    expect(store.citizens[0]?.origin).toBe("community");
    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "21": buyer.address } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:11:00.000Z",
      minIntervalMs: 0,
    });
    await synchronizeGenesis({
      reader: reader({ inventory: inventory([]), owners: { "21": buyer.address } }),
      store,
      treasury,
      nftContract: nft,
      chainId: 143,
      expectedCount: 59,
      now: "2026-10-10T00:12:00.000Z",
      minIntervalMs: 0,
    });
    expect(store.citizens).toHaveLength(1);
    expect(store.citizens[0]?.id).toBe(citizenId);
    expect(store.citizens[0]?.origin).toBe("community");
    expect(store.citizens[0]?.enrollmentStatus).toBe("active");
    expect(store.citizens[0]?.observedOwner).toBe(buyer.address);
    expect(canActAsCurrentOwner(account.address, buyer.address)).toBe(false);
    expect(canActAsCurrentOwner(buyer.address, buyer.address)).toBe(true);
  });

  it("does not enroll an invalid token id", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const result = await createEnrollmentChallenge({
      store: new MemoryCivilizationStore(),
      reader: reader({}),
      chainId: 143,
      nftContract: nft,
      treasury,
      wallet: account.address,
      tokenIds: ["nope"],
    });
    expect(result.ok).toBe(false);
  });
});

describe("metadata and access", () => {
  it("does not present a broken image when metadata is missing or unsafe", async () => {
    expect(presentMetadata(null)).toEqual({ status: "unavailable" });
    expect(presentMetadata({ name: "CHOG", image: "https://evil.example/x.png" }).status).toBe("fetched");
    const missing = await resolveTokenMetadata({ tokenUri: null, gateway: "https://gateway.pinata.cloud/ipfs" });
    expect(missing.status).toBe("unavailable");
    expect(missing.imageUrl).toBeNull();
    const blocked = await resolveTokenMetadata({
      tokenUri: "https://evil.example/1.json",
      gateway: "https://gateway.pinata.cloud/ipfs",
      fetchImpl: vi.fn(),
    });
    expect(blocked.status).toBe("unavailable");
    expect(blocked.imageUrl).toBeNull();
  });

  it("keeps anon access revoked in the SQL migrations", () => {
    const initial = readFileSync("supabase/migrations/20261010180000_initial_schema.sql", "utf8");
    const phase1 = readFileSync("supabase/migrations/20261010200000_phase1_genesis.sql", "utf8");
    expect(initial).toContain("unique (chain_id, nft_contract, token_id)");
    expect(initial).toContain("enable row level security");
    expect(initial).toContain("revoke all on table");
    expect(phase1).toContain("enable row level security");
    expect(phase1).toContain("revoke all on table");
    expect(phase1).toContain("sync_runs_one_running_genesis");
    expect(phase1).not.toContain("insert into citizens");
  });
});

describe("AI provider", () => {
  it("does not call Ajax or a missing provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = readAppConfig({
      AI_PROVIDER: "ajax",
      AI_BASE_URL: "https://example.com/ajax",
      AI_MODEL: "guess",
    } as unknown as NodeJS.ProcessEnv);
    await expect(createProviderFromConfig(config).complete({ purpose: "tick", messages: [] })).rejects.toThrow(
      /no request was sent/i,
    );
    await expect(
      createProviderFromConfig(readAppConfig({ AI_PROVIDER: "none" } as unknown as NodeJS.ProcessEnv)).complete({
        purpose: "tick",
        messages: [],
      }),
    ).rejects.toThrow(/No AI provider/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reads the treasury comparison count without treating it as a token list", () => {
    const config = readAppConfig({} as NodeJS.ProcessEnv);
    expect(config.expectedFoundingCount).toBe(59);
    expect(config.chogTreasuryAddress).toBe(treasury);
    expect(config.nftIndexer).toBe("none");
  });

  it("accepts a loopback http Supabase URL and rejects other plaintext URLs", () => {
    const config = readAppConfig({
      SUPABASE_URL: "http://127.0.0.1:54321/",
      SUPABASE_SERVICE_ROLE_KEY: "local-test",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.supabaseUrl).toBe("http://127.0.0.1:54321");
    expect(() =>
      readAppConfig({ SUPABASE_URL: "http://example.com" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/https URL/);
    expect(() =>
      readAppConfig({ MONAD_RPC_URL: "http://127.0.0.1:8545" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/https URL/);
  });
});
