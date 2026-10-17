import { readFileSync } from "node:fs";
import { getAddress, keccak256, toFunctionSelector, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { NFT_BOUND_SCHEME, treasuryAddressProblem, walletControlFollowsNftOwner } from "@/lib/wallets/authority";
import { codeHashes } from "@/lib/wallets/infrastructure";
import { statusAfterEvidence } from "@/lib/wallets/lifecycle";
import {
  evaluateDelegatedCall,
  nftBoundSalt,
  nftIdentityKey,
  predictedIsNotDeployed,
  selectorFromCalldata,
  type DelegationPolicy,
  type NftIdentity,
} from "@/lib/wallets/nft-bound";

const nft = getAddress("0x1111111111111111111111111111111111111111");
const ownerA = getAddress("0x2222222222222222222222222222222222222222");
const ownerB = getAddress("0x3333333333333333333333333333333333333333");
const executor = getAddress("0x4444444444444444444444444444444444444444");
const sink = getAddress("0x5555555555555555555555555555555555555555");
const other = getAddress("0x6666666666666666666666666666666666666666");
const ping = toFunctionSelector("ping(uint256)");

const identity: NftIdentity = { chainId: 10143, nftContract: nft, tokenId: 7n };

function policy(patch: Partial<DelegationPolicy> = {}): DelegationPolicy {
  return {
    executor,
    target: sink,
    selector: ping,
    allowValue: false,
    expiresAt: 2_000,
    ownerAtGrant: ownerA,
    revoked: false,
    nonce: 0n,
    ...patch,
  };
}

describe("nft-bound identity", () => {
  it("keeps one salt per NFT identity and does not collapse two token ids", () => {
    const seven = nftBoundSalt(identity);
    const eight = nftBoundSalt({ ...identity, tokenId: 8n });
    expect(seven).not.toBe(eight);
    expect(nftIdentityKey(identity)).not.toBe(nftIdentityKey({ ...identity, tokenId: 8n }));
    expect(nftIdentityKey(identity)).toContain(NFT_BOUND_SCHEME);
    expect(nftBoundSalt({ ...identity, chainId: 143 })).not.toBe(seven);
    expect(nftBoundSalt({ ...identity, nftContract: other })).not.toBe(seven);
    expect(seven).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keccak256(toHex("not-the-salt"))).not.toBe(seven);
  });

  it("follows NFT ownership only for nft_bound_v1, not the production unassigned scheme", () => {
    expect(walletControlFollowsNftOwner()).toBe(false);
    expect(walletControlFollowsNftOwner("unassigned")).toBe(false);
    expect(walletControlFollowsNftOwner(NFT_BOUND_SCHEME)).toBe(true);
  });

  it("does not treat a predicted address as deployed", () => {
    expect(statusAfterEvidence({ nftOwnershipVerified: true, evidence: "predicted" })).toBe("address_predicted");
    expect(predictedIsNotDeployed("address_predicted")).toBe(true);
    expect(predictedIsNotDeployed("deployed")).toBe(false);
  });
});

describe("delegated policy (off-chain executor, not the model)", () => {
  const request = {
    chainId: 10143,
    nftContract: nft,
    tokenId: 7n,
    currentOwner: ownerA,
    executor,
    target: sink,
    selector: ping,
    value: 0n,
    expectedNonce: 0n,
    now: 1_000,
  };

  it("accepts a matching call and rejects transfer, replay, target, selector, expiry, and revocation", () => {
    expect(evaluateDelegatedCall(identity, policy(), request)).toEqual({ ok: true });
    const denied = (
      patch: Partial<typeof request>,
      policyPatch: Partial<DelegationPolicy> = {},
    ) => {
      const result = evaluateDelegatedCall(identity, policy(policyPatch), { ...request, ...patch });
      return result.ok ? "ok" : result.reason;
    };
    expect(denied({ currentOwner: ownerB })).toBe("nft owner changed");
    expect(denied({ expectedNonce: 1n })).toBe("replay");
    expect(denied({ target: other })).toBe("target not allowed");
    expect(denied({ selector: toFunctionSelector("fail()") })).toBe("selector not allowed");
    expect(denied({ value: 1n })).toBe("value not allowed");
    expect(denied({ now: 2_000 })).toBe("expired");
    expect(denied({}, { revoked: true })).toBe("revoked");
    expect(denied({ chainId: 143 })).toBe("wrong chain");
    expect(denied({ nftContract: other })).toBe("wrong nft contract");
    expect(denied({ tokenId: 8n })).toBe("wrong token id");
    expect(selectorFromCalldata("0x")).toBeNull();
  });
});

describe("phase 6a safety", () => {
  it("keeps Tokenbound and the ERC-6551 registry out of the civilization treasury", () => {
    const reserved = {
      chogTreasury: addresses.chogTreasury,
      nft: addresses.chogGenesis,
      token: addresses.chogToken,
    };
    expect(treasuryAddressProblem(addresses.erc6551Registry, reserved)).toMatch(/infrastructure/);
    expect(treasuryAddressProblem(addresses.tokenboundAccountV3, reserved)).toMatch(/infrastructure/);
    expect(treasuryAddressProblem(addresses.tokenboundAccountProxy, reserved)).toMatch(/infrastructure/);
    expect(codeHashes.erc6551Registry).toBe("0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735");
    expect(codeHashes.tokenboundAccountV3).toBe(
      "0xdf5eeb80b53e48dfd667fff5264976de4004fdd27eef4f6b954d182109f0f85b",
    );
  });

  it("adds an additive scheme migration without dropping tables or applying hosted writes", () => {
    const sql = readFileSync("supabase/migrations/20261017200000_phase6a_wallet_scheme.sql", "utf8");
    expect(sql).toContain("nft_bound_v1");
    expect(sql).toContain("nft_bound");
    expect(sql).toContain("unassigned");
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/insert\s+into/i);
    expect(sql).toMatch(/not applied to hosted supabase/i);
  });

  it("does not add signing to public routes or store keys", () => {
    const transactions = readFileSync("src/app/api/transactions/route.ts", "utf8");
    const ai = readFileSync("src/app/api/ai/run/route.ts", "utf8");
    const bound = readFileSync("src/lib/wallets/nft-bound.ts", "utf8");
    expect(transactions).toContain("assertExecutionDisabled");
    expect(ai).not.toContain("privateKey");
    expect(ai).not.toContain("executeDelegated");
    expect(bound).not.toContain("privateKey");
    expect(bound).not.toContain("mnemonic");
  });
});
