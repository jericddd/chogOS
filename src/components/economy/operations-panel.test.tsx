// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EconomicOperationsPanel } from "@/components/economy/operations-panel";
import { presentEconomy } from "@/lib/economy/present";
import { emptySnapshot } from "@/lib/economy/observe";
import { productionExecutionStatus } from "@/lib/economy/execution";

const TX = `0x${"ab".repeat(32)}`;

describe("economic operations panel", () => {
  it("shows an unconfigured treasury, disabled execution, and no invented zero", () => {
    const view = presentEconomy({
      snapshot: emptySnapshot("not_configured", "Economic treasury address is not configured."),
      execution: productionExecutionStatus({}),
      allowlistReason: "No protocol allowlist is configured.",
      ledgerLoaded: false,
    });
    render(<EconomicOperationsPanel view={view} />);
    expect(screen.getByRole("heading", { name: "ChogBank operations" })).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not loaded").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ChogTreasury NFT wallet/).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not invent a transaction/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a cached receipt as cached and links only a checked hash", () => {
    const view = presentEconomy({
      snapshot: emptySnapshot("not_configured", "Economic treasury address is not configured."),
      execution: productionExecutionStatus({}),
      allowlistReason: "No protocol allowlist is configured.",
      ledgerLoaded: false,
      receiptChecks: [
        {
          txHash: TX,
          status: "verified",
          fresh: false,
          cached: true,
          checkedAt: "2026-10-20T19:00:00.000Z",
          blockNumber: "10",
          blockHash: `0x${"cd".repeat(32)}`,
          receiptStatus: "success",
          headline: "Cached successful receipt from 2026-10-20T19:00:00.000Z. This is not a fresh verification.",
          reason: "The receipt status is success and the block hash matches the canonical mainnet block.",
          discrepancy: null,
          explorerHref: `https://monadscan.com/tx/${TX}`,
          transfers: [],
          transferNote: "The successful receipt has no supported $CHOG transfer. Receipt success is not a transfer.",
          settlement: "not_settled",
          settlementNote: "This is not an accounting settlement. The page did not change the proposal.",
        },
      ],
    });
    const viewRender = render(<EconomicOperationsPanel view={view} />);
    expect(screen.getByText(/not a fresh verification/)).toBeTruthy();
    expect(screen.getByText(/Receipt success is not a transfer/)).toBeTruthy();
    expect(screen.getByText(/not an accounting settlement/i)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://monadscan.com/tx/${TX}`);
    viewRender.unmount();
  });

  it("links a transfer only when the evidence is verified", () => {
    const hidden = presentEconomy({
      snapshot: emptySnapshot("unavailable", "The treasury balance could not be read."),
      execution: productionExecutionStatus({}),
      allowlistReason: "No protocol allowlist is configured.",
      ledgerLoaded: false,
      transfers: [
        {
          id: "hidden",
          direction: "in",
          asset: "MON",
          amountRaw: "1000000000000000000",
          decimals: 18,
          txHash: TX,
          chainVerified: false,
          status: "proposed",
        },
      ],
    });
    const { unmount } = render(<EconomicOperationsPanel view={hidden} />);
    expect(screen.queryByRole("link")).toBeNull();
    unmount();

    const shown = presentEconomy({
      snapshot: emptySnapshot("unavailable", "The treasury balance could not be read."),
      execution: productionExecutionStatus({}),
      allowlistReason: "No protocol allowlist is configured.",
      ledgerLoaded: false,
      transfers: [
        {
          id: "shown",
          direction: "in",
          asset: "MON",
          amountRaw: "1000000000000000000",
          decimals: 18,
          txHash: TX,
          chainVerified: true,
          status: "observed",
        },
      ],
    });
    render(<EconomicOperationsPanel view={shown} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`https://monadscan.com/tx/${TX}`);
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});
