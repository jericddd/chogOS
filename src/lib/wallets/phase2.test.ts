import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { treasuryAddressProblem, walletControlFollowsNftOwner } from "@/lib/wallets/authority";
import { combineFundingLegs, judgeFunding, presentBalance, rpcChainProblem, type TransferLog } from "@/lib/wallets/funding";
import {
  assessClientWalletClaim,
  assessTreasuryCode,
  planUnassignedWallets,
  statusAfterEvidence,
  walletStatusCopy,
} from "@/lib/wallets/lifecycle";
import { MemoryWalletStore } from "@/lib/wallets/memory-store";
import { citizenWalletWorldLine, presentCitizenWallet, presentCivilizationTreasury } from "@/lib/wallets/present";

const treasury = getAddress("0x1111111111111111111111111111111111111111");
const other = getAddress("0x2222222222222222222222222222222222222222");
const sender = getAddress("0x3333333333333333333333333333333333333333");
const migration = readFileSync("supabase/migrations/20261012220000_phase2_wallets.sql", "utf8");
const fundingGuards = readFileSync("supabase/migrations/20261012233000_phase2_funding_guards.sql", "utf8");

function transferLog(token: string, from: string, to: string, value: bigint): TransferLog {
  const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  return {
    address: token,
    topics: encodeEventTopics({
      abi: [event],
      eventName: "Transfer",
      args: { from: getAddress(from), to: getAddress(to) },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return walk(path);
    }
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("citizen wallet registry", () => {
  it("keeps one assignment per citizen and does not duplicate on a second sync", async () => {
    const store = new MemoryWalletStore();
    const citizens = [
      { id: "citizen-a", chainId: 143 as const },
      { id: "citizen-b", chainId: 143 as const },
    ];
    const first = await store.ensureUnassigned(citizens);
    const second = await store.ensureUnassigned([...citizens, citizens[0]]);
    const listed = await store.listAssignments();
    expect(first.ok && first.value.created).toBe(2);
    expect(second.ok && second.value.created).toBe(0);
    expect(listed.ok && listed.value).toHaveLength(2);
    expect(listed.ok && listed.value.every((row) => row.status === "not_configured")).toBe(true);
    expect(listed.ok && listed.value.every((row) => row.accountAddress === null && row.predictedAddress === null)).toBe(true);
  });

  it("does not merge two NFT identities or treat an owner as the identity", () => {
    const plan = planUnassignedWallets({
      citizens: [
        { id: "nft-7", chainId: 143 },
        { id: "nft-8", chainId: 143 },
      ],
      existing: [],
    });
    expect(plan.creates.map((row) => row.citizenId)).toEqual(["nft-7", "nft-8"]);
    expect(plan.creates.every((row) => !("owner" in row))).toBe(true);
  });

  it("keeps a predicted address distinct from a deployed account", () => {
    expect(statusAfterEvidence({ nftOwnershipVerified: true, evidence: "predicted" })).toBe("address_predicted");
    expect(statusAfterEvidence({ nftOwnershipVerified: true, evidence: "code_present" })).toBe("deployed");
    expect(walletStatusCopy("address_predicted")).toMatch(/not deployment/i);
    const view = presentCitizenWallet({
      citizenId: "nft-7",
      persistence: "ready",
      assignment: {
        citizenId: "nft-7",
        chainId: 143,
        scheme: "unassigned",
        status: "address_predicted",
        predictedAddress: treasury,
        accountAddress: null,
      },
    });
    expect(view.addressLabel).toBe("Predicted address");
    expect(view.note).toMatch(/not a deployed account/i);
  });

  it("refuses a verified wallet for an unverified NFT and refuses a browser claim", () => {
    expect(statusAfterEvidence({ nftOwnershipVerified: false, evidence: "code_matched" })).toBe("failed");
    expect(assessClientWalletClaim({ status: "verified" }).accepted).toBe(false);
    expect(assessClientWalletClaim({ status: "deployed" }).accepted).toBe(false);
    expect(assessClientWalletClaim({}).accepted).toBe(false);
  });

  it("does not claim that NFT ownership controls a smart wallet", () => {
    expect(walletControlFollowsNftOwner()).toBe(false);
  });

  it("describes a missing database without inventing wallets", () => {
    const line = citizenWalletWorldLine({ persistence: "not_persisted", assignments: null });
    expect(line).toMatch(/not stored/i);
    expect(line).toMatch(/not deployed|No smart account is deployed/i);
    const view = presentCitizenWallet({ citizenId: "nft-7", assignment: null, persistence: "migration_pending" });
    expect(view.address).toBeNull();
    expect(view.note).toMatch(/not in the database/i);
  });
});

describe("civilization treasury", () => {
  const reserved = {
    chogTreasury: addresses.chogTreasury,
    nft: addresses.chogGenesis,
    token: addresses.chogToken,
  };

  it("rejects the ChogTreasury NFT wallet and known infrastructure as the economic treasury", () => {
    expect(treasuryAddressProblem(addresses.chogTreasury, reserved)).toMatch(/ChogTreasury/);
    expect(treasuryAddressProblem(addresses.chogGenesis, reserved)).toMatch(/token contract/);
    expect(treasuryAddressProblem(addresses.safeSingleton, reserved)).toMatch(/infrastructure/);
    expect(treasuryAddressProblem("0x0000000000000000000000000000000000000000", reserved)).toMatch(/zero address/);
  });

  it("shows an unconfigured treasury instead of a configured one", () => {
    const view = presentCivilizationTreasury({
      chainId: 143,
      chogTreasury: addresses.chogTreasury,
      persistence: "ready",
      treasury: null,
      native: { state: "unconfigured" },
      chog: { state: "unconfigured" },
      funding: [],
    });
    expect(view.configured).toBe(false);
    expect(view.statusLabel).toBe("Treasury not configured");
    expect(view.address).toBeNull();
    expect(view.chogTreasuryAddress).toBe(addresses.chogTreasury);
    expect(view.balances.every((row) => row.text === "Not read")).toBe(true);
  });

  it("does not label an address with no code as a deployed Safe", () => {
    const assessed = assessTreasuryCode({ codeEmpty: true, masterCopy: null });
    expect(assessed.accountType).toBe("unknown");
    expect(assessed.verification).toBe("observed");
    expect(assessed.detail).toMatch(/not labeled an externally owned account/i);
    expect(assessed.safeVersion).toBeNull();
    const safe = assessTreasuryCode({ codeEmpty: false, masterCopy: addresses.safeSingleton141 });
    expect(safe.verification).toBe("safe_proxy");
    expect(safe.detail).toMatch(/did not deploy/i);
  });

  it("does not replace a treasury address or count one funding transaction twice", async () => {
    const store = new MemoryWalletStore();
    const saved = await store.saveTreasury({
      chainId: 143,
      address: treasury,
      status: "configured",
      accountType: "eoa",
      verification: "observed",
      safeVersion: null,
      codeHash: null,
      detail: null,
      configuredAt: "2026-10-12T00:00:00.000Z",
    });
    const replaced = await store.saveTreasury({
      chainId: 143,
      address: other,
      status: "configured",
      accountType: "eoa",
      verification: "observed",
      safeVersion: null,
      codeHash: null,
      detail: null,
      configuredAt: "2026-10-12T00:00:00.000Z",
    });
    expect(saved.ok).toBe(true);
    expect(replaced.ok).toBe(false);
    const funding = {
      treasuryId: "treasury-143",
      chainId: 143 as const,
      assetKind: "erc20" as const,
      tokenAddress: addresses.chogToken,
      symbol: "CHOG",
      decimals: 18,
      txHash: `0x${"ab".repeat(32)}`,
      sender,
      recipient: treasury,
      amountRaw: "1000",
      blockNumber: "10",
      status: "confirmed" as const,
      detail: "checked",
      verifiedAt: "2026-10-12T00:00:00.000Z",
    };
    const first = await store.saveFunding(funding);
    const second = await store.saveFunding({ ...funding, amountRaw: "999999" });
    const listed = await store.listFunding(143);
    expect(first.ok && second.ok && first.value.id).toBe(second.ok ? second.value.id : "");
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0]?.amountRaw).toBe("1000");
  });

  it("lets a later confirmation replace an unverified check without counting the hash twice", async () => {
    const store = new MemoryWalletStore();
    const hash = `0x${"cd".repeat(32)}`;
    const base = {
      treasuryId: "treasury-143",
      chainId: 143 as const,
      assetKind: "erc20" as const,
      tokenAddress: addresses.chogToken,
      symbol: "CHOG",
      decimals: 18,
      sender,
      recipient: treasury,
      detail: "checked",
      verifiedAt: null as string | null,
    };
    await store.saveFunding({
      ...base,
      txHash: hash,
      amountRaw: null,
      blockNumber: null,
      status: "unverified",
    });
    const confirmed = await store.saveFunding({
      ...base,
      txHash: hash.toUpperCase(),
      amountRaw: "8",
      blockNumber: "12",
      status: "confirmed",
      verifiedAt: "2026-10-12T00:00:00.000Z",
    });
    const repeat = await store.saveFunding({
      ...base,
      txHash: hash,
      amountRaw: "99",
      blockNumber: "13",
      status: "confirmed",
      verifiedAt: "2026-10-12T00:00:00.000Z",
    });
    const listed = await store.listFunding(143);
    expect(confirmed.ok && confirmed.value.amountRaw).toBe("8");
    expect(repeat.ok && repeat.value.amountRaw).toBe("8");
    expect(listed.ok && listed.value).toHaveLength(1);
  });
});

describe("funding verification", () => {
  it("does not confirm a missing, reverted, or unrelated transaction", () => {
    const missing = judgeFunding({
      treasury,
      chogToken: addresses.chogToken,
      receipt: null,
      transaction: null,
      chogDecimals: 18,
    });
    expect(missing[0]?.status).toBe("unverified");

    const reverted = judgeFunding({
      treasury,
      chogToken: addresses.chogToken,
      receipt: { status: "reverted", blockNumber: 4n, logs: [] },
      transaction: { from: sender, to: treasury, value: 1n },
      chogDecimals: 18,
    });
    expect(reverted[0]?.status).toBe("reverted");

    const unrelated = judgeFunding({
      treasury,
      chogToken: addresses.chogToken,
      receipt: { status: "success", blockNumber: 4n, logs: [] },
      transaction: { from: sender, to: other, value: 5n },
      chogDecimals: 18,
    });
    expect(unrelated[0]?.status).toBe("failed");
  });

  it("confirms native and $CHOG transfers only when they reach the configured treasury", () => {
    const native = judgeFunding({
      treasury,
      chogToken: addresses.chogToken,
      receipt: { status: "success", blockNumber: 8n, logs: [] },
      transaction: { from: sender, to: treasury, value: 7n },
      chogDecimals: 18,
    });
    expect(native.map((leg) => leg.status)).toEqual(["confirmed"]);
    expect(native[0]?.assetKind).toBe("native");

    const token = judgeFunding({
      treasury,
      chogToken: addresses.chogToken,
      receipt: {
        status: "success",
        blockNumber: 9n,
        logs: [
          transferLog(addresses.chogToken, sender, other, 4n),
          transferLog(other, sender, treasury, 4n),
          transferLog(addresses.chogToken, sender, treasury, 4n),
        ],
      },
      transaction: { from: sender, to: addresses.chogToken, value: 0n },
      chogDecimals: 18,
    });
    expect(token).toHaveLength(1);
    expect(token[0]?.status).toBe("confirmed");
    expect(token[0]?.amountRaw).toBe("4");
    expect(token[0]?.tokenAddress).toBe(addresses.chogToken);

    const doubled = combineFundingLegs(
      judgeFunding({
        treasury,
        chogToken: addresses.chogToken,
        receipt: {
          status: "success",
          blockNumber: 9n,
          logs: [
            transferLog(addresses.chogToken, sender, treasury, 4n),
            transferLog(addresses.chogToken, sender, treasury, 6n),
          ],
        },
        transaction: { from: sender, to: addresses.chogToken, value: 0n },
        chogDecimals: 18,
      }),
    );
    expect(doubled).toHaveLength(1);
    expect(doubled[0]?.amountRaw).toBe("10");
  });

  it("rejects a receipt from a different chain id", () => {
    expect(rpcChainProblem(10143, 143)).toMatch(/chain 10143/);
    expect(rpcChainProblem(143, 143)).toBeNull();
  });

  it("does not invent a balance when a read fails", () => {
    const shown = presentBalance({
      configured: true,
      live: null,
      error: "RPC failed",
      lastKnown: null,
    });
    expect(shown.state).toBe("unavailable");
    expect(JSON.stringify(shown)).not.toContain('"amountRaw":"0"');
    const unconfigured = presentBalance({ configured: false, live: null, error: null, lastKnown: null });
    expect(unconfigured.state).toBe("unconfigured");
  });
});

describe("phase 2 safety boundaries", () => {
  it("adds wallet tables without dropping citizens or seeding an address", () => {
    expect(migration).toContain("unique (citizen_id, chain_id, scheme)");
    expect(migration).toContain("treasury_funding_once");
    expect(fundingGuards).toContain("lower(tx_hash)");
    expect(fundingGuards).toContain("notify pgrst, 'reload schema'");
    expect(fundingGuards).not.toMatch(/\bdrop\s+table\b/i);
    expect(fundingGuards).not.toMatch(/\btruncate\b/i);
    expect(fundingGuards).not.toMatch(/insert\s+into\s+citizens/i);
    expect(migration).toContain("enable row level security");
    expect(migration).not.toMatch(/\bdrop\s+table\b/i);
    expect(migration).not.toMatch(/\btruncate\b/i);
    expect(migration).not.toMatch(/insert\s+into\s+citizens/i);
    expect(migration).not.toMatch(/insert\s+into\s+civilization_treasuries/i);
    expect(migration.toLowerCase()).toContain(addresses.chogTreasury.toLowerCase());
  });

  it("keeps signing and the service role out of client code, and keeps execution disabled", () => {
    const clientModules = walk("src").filter((path) => readFileSync(path, "utf8").startsWith('"use client"'));
    const clientText = clientModules.map((path) => readFileSync(path, "utf8")).join("\n");
    const bundled = walk("src")
      .filter((path) => path.includes(`${join("src", "components")}`))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(clientText).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(bundled).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(clientText + bundled).not.toContain("sb_secret_");
    expect(clientText + bundled).not.toContain("privateKey");
    expect(readFileSync("src/app/api/transactions/route.ts", "utf8")).toContain("assertExecutionDisabled");
    const service = readFileSync("src/lib/wallets/service.ts", "utf8");
    expect(service).not.toContain("sendTransaction");
    expect(service).not.toContain("privateKey");
    const configure = readFileSync("src/app/api/treasury/configure/route.ts", "utf8");
    expect(configure).toContain("treasuryAdminSecret");
    expect(configure).not.toContain("chainId: body");
  });
});
