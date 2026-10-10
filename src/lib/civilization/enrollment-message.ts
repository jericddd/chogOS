import { verifyMessage, type Address, type Hex } from "viem";

export function buildEnrollmentMessage(input: {
  chainId: number;
  wallet: Address;
  tokenIds: string[];
  nonce: string;
  expires: string;
}): string {
  return [
    "chogOS citizen enrollment",
    `Chain ID: ${input.chainId}`,
    `Wallet: ${input.wallet}`,
    `Token IDs: ${input.tokenIds.join(",")}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expires}`,
  ].join("\n");
}

export async function signatureMatches(message: string, signature: string, wallet: Address): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return false;
  }
  try {
    return await verifyMessage({ address: wallet, message, signature: signature as Hex });
  } catch {
    return false;
  }
}
