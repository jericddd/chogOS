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
    expect(screen.getByText(/There is no funding address and no live balance/)).toBeTruthy();
    expect(screen.getByText(/CHOG_BANK_CONTRACT_ADDRESS is unset/)).toBeTruthy();
    expect(screen.queryByText("Not read")).toBeNull();
    expect(screen.queryByText("Not recorded")).toBeNull();
    expect(screen.queryByText(/No contract explorer link/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-ready")).toBe("no");
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-funding-scan")).toBe("skipped");
    expect(screen.queryByRole("heading", { name: "Funding" })).toBeNull();
    expect(screen.queryByTestId("other-holdings")).toBeNull();
    expect(screen.queryByTestId("highlighted-holding")).toBeNull();
    expect(screen.getByTestId("ownerless-chogbank").getAttribute("data-other-tokens")).toBe("skipped");
  });

  it("highlights MON and $CHOG and lists another token without that treatment", () => {
    const widget = getAddress("0x4444444444444444444444444444444444444444");
    const view = presentOwnerlessTreasury({
      inspection: live(),
      decisions: [],
      decisionsLoaded: true,
      fundingScan: "empty",
      heldTokens: {
        status: "complete",
        rows: [{ address: widget, symbol: "WIDGET", decimals: 18, raw: "2500000000000000000" }],
      },
    });
    render(<ChogBankPanel view={view} />);
    const highlighted = screen.getAllByTestId("highlighted-holding");
    expect(highlighted).toHaveLength(2);
    expect(highlighted.map((node) => node.textContent).join(" ")).toContain("MON");
    expect(highlighted.map((node) => node.textContent).join(" ")).toContain("$CHOG");
    expect(highlighted.some((node) => node.textContent?.includes("WIDGET"))).toBe(false);
    const other = screen.getByTestId("other-holdings");
    expect(other.textContent).toContain("WIDGET");
    expect(other.textContent).toContain("2.5");
    expect(other.textContent).toContain(widget);
    expect(other.getAttribute("data-highlighted")).toBe("no");
    expect(other.className).not.toMatch(/font-serif|text-2xl|rounded-xl/);
    expect(other.querySelector("[data-testid='highlighted-holding']")).toBeNull();
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
