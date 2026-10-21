import { getAddress, type Address } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { infrastructureName } from "@/lib/wallets/infrastructure";
import { sameAddress } from "@/lib/civilization/token-id";

export const CITIZEN_WALLET_SCHEME = "unassigned" as const;
export const NFT_BOUND_SCHEME = "nft_bound_v1" as const;
/** Permanent AI-issued wallet. The NFT holder is not an owner of this scheme. */
export const AI_ISSUED_SCHEME = "ai_issued_v3" as const;

export type CitizenWalletScheme = typeof CITIZEN_WALLET_SCHEME | typeof NFT_BOUND_SCHEME | typeof AI_ISSUED_SCHEME;

/**
 * Production registry rows remain `unassigned` and do not follow NFT ownership.
 * `ai_issued_v3` is the permanent wallet. Its signer is the agent key, not ownerOf.
 * The Phase 6a `nft_bound_v1` account reads ownerOf at execution time.
 * V1 grantDelegation remains disabled (ownerAtGrant revival).
 * V1.1 adds one owner-opened executor session that latches dead after an
 * observed owner change. A→B→A with no account call still needs invalidateSession.
 */
export function walletControlFollowsNftOwner(scheme: string = CITIZEN_WALLET_SCHEME): boolean {
  return scheme === NFT_BOUND_SCHEME;
}

export function treasuryAddressProblem(
  candidate: string,
  reserved: { chogTreasury: Address; nft: Address; token: Address },
): string | null {
  let address: Address;
  try {
    address = getAddress(candidate);
  } catch {
    return "Enter a 20-byte hexadecimal address.";
  }

  if (sameAddress(address, "0x0000000000000000000000000000000000000000")) {
    return "The zero address cannot be the civilization treasury.";
  }
  if (sameAddress(address, reserved.chogTreasury)) {
    return "That address is the ChogTreasury NFT wallet. It cannot be the civilization treasury.";
  }
  if (sameAddress(address, reserved.nft) || sameAddress(address, reserved.token)) {
    return "That address is a Chog token contract, not a treasury wallet.";
  }
  const known = infrastructureName(address);
  if (known) {
    return `That address is ${known} infrastructure. It is not a treasury wallet that can hold civilization funds.`;
  }
  if (sameAddress(address, addresses.wrappedMon)) {
    return "That address is Wrapped MON, not a treasury wallet.";
  }
  return null;
}
