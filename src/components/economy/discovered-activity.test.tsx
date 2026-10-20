// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiscoveredActivityPanel } from "@/components/economy/discovered-activity";
import { addresses } from "@/lib/blockchain/addresses";
import { DISCOVERY_ACCOUNTING_NOTE, DISCOVERY_DECIMALS_NOTE, type DiscoveredActivityPage } from "@/lib/economy/discover-activity";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const TX = `0x${"11".repeat(32)}` as const;
const BLOCK = `0x${"cd".repeat(32)}` as const;

describe("discovered mainnet activity", () => {
  it("shows a cached unattributed transfer apart from treasury totals", () => {
    const view = render(<DiscoveredActivityPanel view={verified({ cached: true })} focusTx={TX} />);
    expect(screen.getByRole("heading", { name: "Discovered Mainnet Activity" })).toBeTruthy();
    expect(screen.getByText(DISCOVERY_ACCOUNTING_NOTE)).toBeTruthy();
    expect(screen.getByText(DISCOVERY_DECIMALS_NOTE)).toBeTruthy();
    expect(screen.getAllByText(/not a fresh verification/).length).toBeGreaterThan(0);
    expect(screen.getByText("Verified from cache")).toBeTruthy();
    expect(screen.getByText("1000000000000000001")).toBeTruthy();
    expect(screen.getByText("1.000000000000000001 $CHOG")).toBeTruthy();
    expect(screen.getByText(addresses.chogToken)).toBeTruthy();
    expect(screen.getByText(/Unattributed/)).toBeTruthy();
    expect(screen.getByText(/Not included in treasury totals/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View transaction" }).getAttribute("href")).toBe(`https://monadscan.com/tx/${TX}`);
    expect(screen.getByRole("link", { name: "Older activity" }).getAttribute("href")).toContain("activity=next-window");
    expect(screen.getByRole("link", { name: "Older activity" }).getAttribute("href")).toContain(`tx=${TX}`);
    view.unmount();
  });

  it("does not describe an RPC failure as an empty token history", () => {
    const view = render(
      <DiscoveredActivityPanel
        view={{
          ...verified({ cached: false }),
          state: "unavailable",
          headline: "Mainnet activity could not be read.",
          detail: "Monad mainnet RPC is not configured. No $CHOG logs were scanned. This is not a claim that the token has no transfers.",
          coverageNote: null,
          items: [],
          nextCursor: null,
        }}
      />,
    );
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/not a claim that the token has no transfers/)).toBeTruthy();
    expect(screen.queryByText(/No \$CHOG Transfer logs were found/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    view.unmount();
  });

  it("shows a bounded empty window and a treasury direction that is not income", () => {
    const empty = render(
      <DiscoveredActivityPanel
        view={{
          ...verified({ cached: false }),
          state: "empty_window",
          headline: "No $CHOG transfers were found in the scanned window.",
          detail: "No $CHOG Transfer logs were found in blocks 151–250. Older blocks were not scanned.",
          items: [],
          nextCursor: "older",
        }}
      />,
    );
    expect(screen.getByText(/No \$CHOG Transfer logs were found in blocks 151–250/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Older activity" })).toBeTruthy();
    empty.unmount();

    const incoming = render(
      <DiscoveredActivityPanel
        view={verified({
          cached: false,
          direction: "treasury_in",
          treasuryAttributed: true,
          directionNote: "Incoming to the configured economic treasury. This page did not post it to the ledger.",
        })}
      />,
    );
    expect(screen.getByText(/Not counted as income/)).toBeTruthy();
    expect(screen.getByText(/did not post it to the ledger/)).toBeTruthy();
    expect(screen.queryByText(/^Unattributed/)).toBeNull();
    incoming.unmount();
  });
});

function verified(input: {
  cached: boolean;
  direction?: DiscoveredActivityPage["items"][number]["direction"];
  treasuryAttributed?: boolean;
  directionNote?: string;
}): DiscoveredActivityPage {
  const cached = input.cached;
  return {
    state: "verified_page",
    headline: cached ? "Cached mainnet activity. This is not a fresh verification." : "Fresh verification: each listed transfer was found in its canonical Monad mainnet receipt.",
    detail: "Older blocks or logs were not included in this response.",
    coverageNote: "Scanned blocks 1–100 on Monad mainnet (chain 143).",
    decimalsNote: DISCOVERY_DECIMALS_NOTE,
    accountingNote: DISCOVERY_ACCOUNTING_NOTE,
    chainId: 143,
    token: addresses.chogToken,
    tip: "100",
    scannedFrom: "1",
    scannedTo: "100",
    nextCursor: "next-window",
    logsReturned: 1,
    rpcCalls: 6,
    dropped: { malformed: 0, foreign: 0, wrongTopic: 0, duplicate: 0, reverted: 0, unavailable: 0, inconsistent: 0, unmatched: 0 },
    items: [
      {
        evidence: cached ? "cached_canonical_receipt" : "fresh_canonical_receipt",
        status: "verified",
        fresh: !cached,
        cached,
        checkedAt: "2026-10-20T20:00:00.000Z",
        verificationLabel: cached
          ? "Cached verification from 2026-10-20T20:00:00.000Z. This is not a fresh verification."
          : "Fresh verification. This transfer was found in the canonical receipt.",
        txHash: TX,
        blockNumber: "40",
        blockHash: BLOCK,
        logIndex: 4,
        token: addresses.chogToken,
        from: "0x2222222222222222222222222222222222222222",
        to: "0x3333333333333333333333333333333333333333",
        amountRaw: "1000000000000000001",
        amountText: "1.000000000000000001 $CHOG",
        decimals: 18,
        direction: input.direction ?? "unattributed",
        directionNote:
          input.directionNote ??
          "The economic treasury address is not configured, so this transfer is not classified as treasury income or expenditure.",
        treasuryAttributed: input.treasuryAttributed ?? false,
        explorerHref: `https://monadscan.com/tx/${TX}`,
        countsInTreasury: false,
      },
    ],
  };
}
