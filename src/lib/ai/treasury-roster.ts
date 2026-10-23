export type RosterWallet = {
  tokenId: string;
  citizenId: string;
  name: string;
  goal: string | null;
  accountAddress: string;
};

export type WalletCode = {
  codeBytes: number;
  identityMatches: boolean;
};

export function compareTokenIds(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  } catch {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}

/** Walk the deployed-wallet list. A cursor of 0 is only the start; later reviews move the window. */
export function selectRotatedRoster<T extends { tokenId: string }>(entries: readonly T[], cursor: number, limit = 12): T[] {
  const sorted = [...entries].sort((left, right) => compareTokenIds(left.tokenId, right.tokenId));
  if (sorted.length === 0 || limit <= 0) return [];
  if (sorted.length <= limit) return sorted;
  const start = ((cursor % sorted.length) + sorted.length) % sorted.length;
  return Array.from({ length: limit }, (_, index) => sorted[(start + index) % sorted.length]!);
}

export type RosterSelection =
  | { status: "ready"; roster: RosterWallet[]; unread: string[] }
  | { status: "unreadable"; unread: string[] }
  | { status: "none"; unread: string[] };

/**
 * Keep citizens whose wallet contract was read and matches that token.
 * One unread wallet is left out of this review. A set where every read failed
 * stays closed. A read that finds no code is an empty roster.
 */
export function rosterFromDeployedWallets(input: {
  wallets: readonly RosterWallet[];
  code: ReadonlyMap<string, WalletCode | "unread">;
  cursor: number;
  limit?: number;
}): RosterSelection {
  if (input.wallets.length === 0) return { status: "none", unread: [] };
  const deployed: RosterWallet[] = [];
  const unread: string[] = [];
  let read = 0;
  for (const wallet of input.wallets) {
    const code = input.code.get(wallet.tokenId);
    if (code == null || code === "unread") {
      unread.push(wallet.tokenId);
      continue;
    }
    read += 1;
    if (code.codeBytes > 0 && code.identityMatches) deployed.push(wallet);
  }
  if (read === 0) return { status: "unreadable", unread };
  if (deployed.length === 0) return { status: "none", unread };
  return { status: "ready", roster: selectRotatedRoster(deployed, input.cursor, input.limit ?? 12), unread };
}
