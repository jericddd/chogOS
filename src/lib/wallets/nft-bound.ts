import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import { NFT_BOUND_SCHEME } from "@/lib/wallets/authority";

export const NFT_BOUND_ACCOUNT_TYPE = "nft_bound" as const;

export type NftIdentity = {
  chainId: 143 | 10143 | number;
  nftContract: Address;
  tokenId: bigint;
};

export type DelegationPolicy = {
  executor: Address;
  target: Address;
  selector: Hex;
  allowValue: boolean;
  expiresAt: number;
  ownerAtGrant: Address;
  revoked: boolean;
  nonce: bigint;
};

export type DelegatedCallRequest = {
  chainId: number;
  nftContract: Address;
  tokenId: bigint;
  currentOwner: Address;
  executor: Address;
  target: Address;
  selector: Hex;
  value: bigint;
  expectedNonce: bigint;
  now: number;
};

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

/** CREATE2 salt. Matches CitizenAccountFactory.accountSalt. */
export function nftBoundSalt(identity: NftIdentity): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [BigInt(identity.chainId), getAddress(identity.nftContract), identity.tokenId],
    ),
  );
}

export function nftIdentityKey(identity: NftIdentity): string {
  return `${identity.chainId}:${getAddress(identity.nftContract).toLowerCase()}:${identity.tokenId.toString()}:${NFT_BOUND_SCHEME}`;
}

export function selectorFromCalldata(data: Hex): Hex | null {
  if (!data.startsWith("0x") || data.length < 10) {
    return null;
  }
  return data.slice(0, 10).toLowerCase() as Hex;
}

/**
 * Off-chain check the authorized executor runs before submitting.
 * The language model never holds this key. The contract is the last check.
 */
export function evaluateDelegatedCall(
  bound: NftIdentity,
  policy: DelegationPolicy,
  request: DelegatedCallRequest,
): PolicyDecision {
  if (request.chainId !== bound.chainId) {
    return { ok: false, reason: "wrong chain" };
  }
  if (getAddress(request.nftContract) !== getAddress(bound.nftContract)) {
    return { ok: false, reason: "wrong nft contract" };
  }
  if (request.tokenId !== bound.tokenId) {
    return { ok: false, reason: "wrong token id" };
  }
  if (policy.revoked) {
    return { ok: false, reason: "revoked" };
  }
  if (request.now >= policy.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (getAddress(request.executor) !== getAddress(policy.executor)) {
    return { ok: false, reason: "unauthorized executor" };
  }
  if (getAddress(request.currentOwner) !== getAddress(policy.ownerAtGrant)) {
    return { ok: false, reason: "nft owner changed" };
  }
  if (request.expectedNonce !== policy.nonce) {
    return { ok: false, reason: "replay" };
  }
  if (getAddress(request.target) !== getAddress(policy.target)) {
    return { ok: false, reason: "target not allowed" };
  }
  if (request.selector.toLowerCase() !== policy.selector.toLowerCase()) {
    return { ok: false, reason: "selector not allowed" };
  }
  if (request.value !== 0n && !policy.allowValue) {
    return { ok: false, reason: "value not allowed" };
  }
  return { ok: true };
}

export function predictedIsNotDeployed(status: string): boolean {
  return status === "address_predicted" || status === "not_configured" || status === "pending" || status === "deployment_pending";
}
