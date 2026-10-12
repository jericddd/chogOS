import { getAddress, type Address } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import { infrastructureName } from "@/lib/wallets/infrastructure";
import { sameAddress } from "@/lib/civilization/token-id";

export const CITIZEN_WALLET_SCHEME = "unassigned" as const;

/**
 * No enabled wallet scheme reads ownerOf. A Safe owner set at initialization
 * stays with the previous NFT owner after a transfer. ERC-6551 would follow
 * the token, but no hash-matched account implementation is selected.
 */
export function walletControlFollowsNftOwner(scheme: string = CITIZEN_WALLET_SCHEME): boolean {
  void scheme;
  return false;
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
