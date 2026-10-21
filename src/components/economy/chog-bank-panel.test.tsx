// @vitest-environment jsdom
import { getAddress } from "viem";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { addresses } from "@/lib/blockchain/addresses";
import { ChogBankPanel } from "@/components/economy/chog-bank-panel";
import { pendingInspection, presentOwnerlessTreasury, type OwnerlessInspection } from "@/lib/economy/treasury-public";

const BANK = getAddress("0x2222222222222222222222222222222222222222");

function live(): OwnerlessInspection {
  return {
    appChainId: 143,
    configuredAddress: BANK,
    blockedReason: null,
    codeBytes: 2400,
    observedChainId: 143,
    genesis: addresses.chogGenesis,
    chogToken: addresses.chogToken,
    authorizer: getAddress("0x1111111111111111111111111111111111111111"),
    implementationSlot: `0x${"00".repeat(32)}`,
    adminSlot: `0x${"00".repeat(32)}`,
    ownerCall: "reverted",
    adminCall: "reverted",
    implementationCall: "reverted",
    upgradeCall: "reverted",
    monRaw: 20_000_000_000_000_000n,
    chogRaw: 0n,
    chogDecimals: 18,
    chainCaps: {
      windowSeconds: 86_400,
      maxAuthorizationTtl: 3_600,
      maxPerTxMon: 10_000_000_000_000_000n,
      maxCitizenWindowMon: 50_000_000_000_000_000n,
      maxAggregateWindowMon: 50_000_000_000_000_000n,
      maxPerTxChog: 1n,
      maxCitizenWindowChog: 1n,
      maxAggregateWindowChog: 1n,
    },
    deploymentTx: null,
    deploymentTxVerified: false,
    readError: null,
  };
}

describe("ChogBank panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not invent a contract link or a balance before deployment", () => {
    const view = presentOwnerlessTreasury({ inspection: pendingInspection(143), decisions: [], decisionsLoaded: true });
    render(<ChogBankPanel view={view} />);
    expect(screen.getByRole("heading", { name: "ChogBank" })).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.getAllByText("Not read").length).toBeGreaterThan(0);
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText(/No contract explorer link/)).toBeTruthy();
    expect(screen.getByText(/No funding address is ready/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-ready")).toBe("no");
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-scan")).toBe("skipped");
    expect(screen.getByText(/not a verified treasury/)).toBeTruthy();
  });

  it("shows a finished empty scan and an unreadable scan as different sentences", () => {
    const empty = presentOwnerlessTreasury({ inspection: live(), decisions: [], decisionsLoaded: true, fundingScan: "empty" });
    const { unmount } = render(<ChogBankPanel view={empty} />);
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-scan")).toBe("empty");
    expect(screen.getByText(/No successful Funded or Distributed event was found/)).toBeTruthy();
    unmount();

    const unread = presentOwnerlessTreasury({ inspection: live(), decisions: [], decisionsLoaded: true, fundingScan: "unreadable" });
    render(<ChogBankPanel view={unread} />);
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-scan")).toBe("unreadable");
    expect(screen.getByText(/not a claim that no Funded or Distributed event exists/)).toBeTruthy();
    expect(screen.queryByText(/No successful Funded or Distributed event was found/)).toBeNull();
  });
});
