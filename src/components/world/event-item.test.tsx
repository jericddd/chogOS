// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventItem } from "@/components/world/event-item";
import type { ClockView, WorldEventView } from "@/lib/world/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode }) => <a href={props.href}>{props.children}</a>,
}));

afterEach(() => {
  cleanup();
});

function event(patch: Partial<WorldEventView> = {}): WorldEventView {
  return {
    id: "evt-91",
    seq: 91,
    kind: "wallet.created",
    category: "ai",
    source: "ai",
    summary: "Chog #91 received a permanent wallet.",
    occurredAt: "2026-10-22T18:09:09Z",
    worldS: null,
    tickSeq: null,
    tokenId: "91",
    relatedTokenId: null,
    buildingId: null,
    buildingName: null,
    chainStatus: "confirmed",
    txHash: null,
    mind: { summary: null, rationale: "Token 91 is next." },
    ...patch,
  };
}

describe("EventItem", () => {
  it("renders history without a citizen-name function", () => {
    render(<EventItem event={event()} now={0} />);
    expect(screen.getByRole("link", { name: "Chog #91" }).getAttribute("href")).toBe("/?citizen=91");
    expect(document.body.textContent).toContain("received a permanent wallet.");
    expect(screen.getByText("Token 91 is next.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Verify" }).getAttribute("href")).toBe("/verify/events/evt-91");
  });

  it("uses a provided name when the caller is already a client component", () => {
    render(
      <EventItem
        event={event({ summary: "Maple received a permanent wallet." })}
        now={0}
        citizenName={() => "Maple"}
      />,
    );
    expect(screen.getByRole("link", { name: "Maple" }).getAttribute("href")).toBe("/?citizen=91");
  });

  it("shows the world day and time for a join that is several real days old", () => {
    const occurredAt = "2026-10-16T00:15:00.000Z";
    const worldS = (445 - 1) * 86_400 + 8 * 3600 + 15 * 60;
    const now = Date.parse(occurredAt) + 7 * 24 * 60 * 60 * 1000;
    const { container } = render(
      <EventItem
        event={event({
          kind: "citizen_enrolled",
          category: "membership",
          source: "system",
          summary: "Chog Genesis #7 enrolled by its verified owner.",
          occurredAt,
          worldS,
        })}
        now={now}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Day 445 · 08:15");
    expect(text.match(/Day 445 · 08:15/g)).toHaveLength(1);
    expect(text).not.toMatch(/\d+d ago/);
    cleanup();

    const fourDays = Date.parse(occurredAt) + 4 * 24 * 60 * 60 * 1000;
    const again = render(
      <EventItem event={event({ occurredAt, worldS, summary: "Chog Genesis #7 enrolled by its verified owner." })} now={fourDays} />,
    );
    expect(again.container.textContent ?? "").not.toMatch(/\d+d ago/);
    expect(again.container.textContent).toContain("Day 445 · 08:15");
  });

  it("keeps a recent age beside the world time and projects a join that has no stored second", () => {
    const occurredAt = "2026-10-22T22:36:47.000Z";
    const worldS = (537 - 1) * 86_400 + 10 * 3600 + 30 * 60;
    const recent = Date.parse(occurredAt) + 5 * 60 * 1000;
    const { container } = render(<EventItem event={event({ occurredAt, worldS })} now={recent} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Day 537 · 10:30");
    expect(text).toContain("5m ago");
    cleanup();

    const clock: ClockView = {
      status: "running",
      speed: 60,
      anchorReal: "2026-10-20T14:00:42.000Z",
      anchorWorldS: 34_122_333,
      tickSeq: 1,
      lastTickAt: "2026-10-23T05:54:24.000Z",
      lastTickWorldS: 47_923_710,
      lastTickGapS: 5,
      lastTickFailed: 0,
      lastErrorAt: null,
      maxLagSeconds: 150,
      walkWorldSPerTile: 30,
      layoutVersion: "genesis-v1",
      layoutHash: "7e8db240",
      serverNow: "2026-10-23T05:54:27.000Z",
    };
    const old = Date.parse(occurredAt) + 3 * 24 * 60 * 60 * 1000;
    const projected = render(
      <EventItem event={event({ occurredAt, worldS: null, summary: "Chog Genesis #1547 enrolled by its verified owner." })} now={old} clock={clock} />,
    );
    const joined = projected.container.textContent ?? "";
    expect(joined).toContain("Day 537 · 10:30");
    expect(joined).not.toMatch(/\d+d ago/);
  });

  it("shows a confirmed ChogBank receipt with the stored reason and transaction", () => {
    const tx = `0x${"ab".repeat(32)}`;
    const { container } = render(
      <EventItem
        event={event({
          id: "paid-137",
          kind: "treasury.paid",
          summary: "The AI mind sent 0.01 MON to Chog #137. Monad confirmed the ChogBank distribution.",
          tokenId: "137",
          chainStatus: "confirmed",
          chainId: 143,
          txHash: tx,
          txUrl: `https://monadscan.com/tx/${tx}`,
          mind: {
            summary: null,
            rationale: "Citizen aims to meet neighbours at the square and requires funds for social engagement.",
          },
        })}
        now={0}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("0.01 MON");
    expect(text).toContain("requires funds for social engagement");
    expect(text).not.toContain("Production signing is disabled");
    const link = container.querySelector(`a[href="https://monadscan.com/tx/${tx}"]`);
    expect(link).toBeTruthy();
  });
});
