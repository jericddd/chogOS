// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventItem } from "@/components/world/event-item";
import type { WorldEventView } from "@/lib/world/types";

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
});
