import { describe, expect, it } from "vitest";

import { rosterFromDeployedWallets, selectRotatedRoster, type RosterWallet } from "@/lib/ai/treasury-roster";

function wallet(tokenId: string): RosterWallet {
  return {
    tokenId,
    citizenId: `citizen-${tokenId}`,
    name: `Chog #${tokenId}`,
    goal: "Keep the commons open.",
    accountAddress: `0x${tokenId.padStart(40, "0")}`,
  };
}

describe("treasury roster", () => {
  it("rotates past the first token ids", () => {
    const entries = Array.from({ length: 13 }, (_, index) => ({ tokenId: String(index + 1) }));
    const first = selectRotatedRoster(entries, 0).map((row) => row.tokenId);
    expect(first).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
    const later = selectRotatedRoster(entries, 12).map((row) => row.tokenId);
    expect(later[0]).toBe("13");
    expect(later).toContain("1");
    expect(later).not.toContain("12");
  });

  it("keeps only citizens whose wallet contract is deployed", () => {
    const result = rosterFromDeployedWallets({
      wallets: [wallet("7"), wallet("9")],
      code: new Map([
        ["7", { codeBytes: 100, identityMatches: true }],
        ["9", { codeBytes: 0, identityMatches: false }],
      ]),
      cursor: 0,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.roster.map((row) => row.tokenId)).toEqual(["7"]);
  });

  it("fails closed when any wallet code cannot be read", () => {
    const missing = rosterFromDeployedWallets({
      wallets: [wallet("7")],
      code: new Map(),
      cursor: 0,
    });
    expect(missing.status).toBe("unreadable");
    const partial = rosterFromDeployedWallets({
      wallets: [wallet("7"), wallet("9")],
      code: new Map([["7", { codeBytes: 100, identityMatches: true }]]),
      cursor: 0,
    });
    expect(partial.status).toBe("unreadable");
  });

  it("returns an empty roster when every wallet was read and none is deployed", () => {
    const result = rosterFromDeployedWallets({
      wallets: [wallet("7"), wallet("9")],
      code: new Map([
        ["7", { codeBytes: 0, identityMatches: false }],
        ["9", { codeBytes: 100, identityMatches: false }],
      ]),
      cursor: 0,
    });
    expect(result).toEqual({ status: "none" });
  });
});
