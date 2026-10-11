const DECIMAL = /^[0-9]+$/;

/** Canonical decimal token id. Rejects blanks, signs, hex, and decimals. */
export function parseTokenId(input: string): { ok: true; tokenId: string } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (!DECIMAL.test(trimmed)) {
    return { ok: false, reason: "Token id must be a non-negative integer." };
  }
  if (trimmed.length > 78) {
    return { ok: false, reason: "Token id is too large." };
  }
  const tokenId = trimmed.replace(/^0+/, "") || "0";
  return { ok: true, tokenId };
}

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
