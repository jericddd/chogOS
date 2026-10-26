// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "@/components/world/activity-feed";
import { AiRunPanel } from "@/components/world/ai-run-panel";
import { createLiveStore } from "@/components/world/live-store";
import { describeAiRun } from "@/lib/ai/run-record";
import type { ClockView, WorldEventView, WorldSnapshot } from "@/lib/world/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));

const clock: ClockView = {
  status: "running",
  speed: 60,
  anchorReal: "2026-10-13T00:00:00Z",
  anchorWorldS: 20000,
  tickSeq: 5,
  lastTickAt: "2026-10-13T00:00:25Z",
  lastTickWorldS: 21500,
  lastTickGapS: 5,
  lastTickFailed: 0,
  lastErrorAt: null,
  maxLagSeconds: 150,
  walkWorldSPerTile: 30,
  layoutVersion: "genesis-v1",
  layoutHash: "7e8db240",
  serverNow: "2026-10-13T00:00:26Z",
};

function snapshot(): WorldSnapshot {
  const event: WorldEventView = {
    id: "sim-1",
    seq: 8,
    kind: "movement.arrived_home",
    category: "movement",
    source: "simulation",
    summary: "Chog #105 arrived home.",
    occurredAt: "2026-10-26T14:45:00Z",
    worldS: 21000,
    tickSeq: 4,
    tokenId: "105",
    relatedTokenId: null,
    buildingId: null,
    buildingName: null,
    chainStatus: "offchain",
    txHash: null,
  };
  return {
    status: "ok",
    clock,
    buildings: [],
    citizens: [],
    events: [event],
    latestSeq: 8,
    townNeeds: [],
    townNeedsReady: false,
    roads: [],
    roadsReady: false,
    townProjects: [],
    townProjectsReady: false,
  };
}

afterEach(() => {
  cleanup();
});

describe("AI activity panel", () => {
  it("keeps an interrupted run and its stored decision above simulation activity", () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    });
    const run = describeAiRun({
      configured: true,
      readable: true,
      scheduler: {
        lastRunAt: "2026-10-26T14:20:55Z",
        lastSuccessAt: "2026-10-24T15:26:41Z",
        lastError: "AI run interrupted. Work was still unfinished at the host deadline. This is not a completed decision cycle.",
        haltUntil: null,
        haltReason: null,
      },
      decision: {
        id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        status: "proposed",
        purpose: "citizen_turn",
        rationale: "Rest before the work shift.",
        output: { action: "rest", tokenId: "105" },
        createdAt: "2026-10-24T11:00:00Z",
      },
      nowMs: Date.parse("2026-10-26T16:00:00Z"),
    });
    const world = snapshot();
    const store = createLiveStore(world, {
      now: () => Date.parse(clock.serverNow),
      fetcher: async () => Response.json({ ...world, since: 0, gap: false }),
    });
    const view = render(<ActivityFeed store={store} dock aiRun={run} />);
    expect(screen.getByRole("region", { name: "AI run status" }).getAttribute("data-ai-run")).toBe("interrupted");
    expect(screen.getByText("AI run interrupted")).toBeTruthy();
    expect(screen.getByText("Proposal persisted")).toBeTruthy();
    expect(screen.getByText("Rest before the work shift.")).toBeTruthy();
    expect(screen.getByText(/Latest successful run: 2026-10-24 15:26:41 UTC/)).toBeTruthy();
    expect(screen.getByText(/Most recent decision: 2026-10-24 11:00:00 UTC/)).toBeTruthy();
    expect(screen.getByText(/arrived home/)).toBeTruthy();
    expect(screen.getByTitle("A rule-based world transition. Not an AI decision.")).toBeTruthy();
    expect(screen.getByText(/Simulation rows are rule-based world transitions, not AI decisions/)).toBeTruthy();
    const html = view.container.innerHTML;
    expect(html.indexOf("AI run interrupted")).toBeLessThan(html.indexOf("arrived home"));
    expect(screen.queryByRole("link", { name: "Verified transaction" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("shows the submitted visit and work when a later interrupted run's newest row is a wallet", () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    });
    const run = describeAiRun({
      configured: true,
      readable: true,
      scheduler: {
        lastRunAt: "2026-10-26T16:54:24Z",
        lastSuccessAt: "2026-10-26T16:40:51Z",
        lastError: "AI run interrupted. Work was still unfinished at the host deadline. This is not a completed decision cycle.",
        haltUntil: null,
        haltReason: null,
      },
      decision: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "proposed",
        purpose: "wallet_issuance",
        rationale:
          "Every enrolled citizen gets one permanent wallet. Token 946 is next. No address was assigned by this decision. The issuer broadcasts it.",
        output: { tokenId: "946" },
        createdAt: "2026-10-26T16:54:25Z",
      },
      citizenDecisions: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          status: "draft",
          purpose: "citizen_turn",
          rationale: "This draft was not a finished decision.",
          output: { action: "rest", tokenId: "1" },
          createdAt: "2026-10-26T16:55:00Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          status: "queued",
          purpose: "citizen_turn",
          rationale: "The merchant is at the market and chooses to visit the bank to review public records.",
          output: { action: "visit", tokenId: "167" },
          createdAt: "2026-10-26T16:39:18Z",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          status: "accepted",
          purpose: "citizen_turn",
          rationale: "Storehouse supplies are maintained by active farmers working the fields during the workday.",
          output: { action: "work", tokenId: "547" },
          createdAt: "2026-10-26T16:39:55Z",
        },
      ],
      nowMs: Date.parse("2026-10-26T17:50:00Z"),
    });
    const world = snapshot();
    const store = createLiveStore(world, {
      now: () => Date.parse(clock.serverNow),
      fetcher: async () => Response.json({ ...world, since: 0, gap: false }),
    });
    const view = render(<ActivityFeed store={store} dock aiRun={run} />);
    expect(screen.getByRole("region", { name: "AI run status" }).getAttribute("data-ai-run")).toBe("interrupted");
    expect(screen.getByText("AI run interrupted")).toBeTruthy();
    expect(screen.getByText(/Work was still unfinished at the host deadline/)).toBeTruthy();
    expect(screen.getByText(/Token 946/)).toBeTruthy();
    const citizens = screen.getByRole("list", { name: "Recent citizen decisions" });
    expect(citizens.textContent).toContain("Chog #167 · visit");
    expect(citizens.textContent).toContain("Proposal submitted to the simulation");
    expect(citizens.textContent).toContain("The merchant is at the market and chooses to visit the bank to review public records.");
    expect(citizens.textContent).toContain("Chog #547 · work");
    expect(citizens.textContent).toContain("Proposal persisted");
    expect(citizens.textContent).toContain("Storehouse supplies are maintained by active farmers working the fields during the workday.");
    expect(citizens.textContent).not.toContain("This draft was not a finished decision.");
    expect(citizens.textContent).not.toMatch(/Confirmed on-chain|executed/i);
    expect(screen.getByText(/arrived home/)).toBeTruthy();
    expect(screen.getByTitle("A rule-based world transition. Not an AI decision.")).toBeTruthy();
    const html = view.container.innerHTML;
    expect(html.indexOf("Chog #167")).toBeLessThan(html.indexOf("arrived home"));
    expect(html.indexOf("Chog #547")).toBeLessThan(html.indexOf("arrived home"));
    expect(screen.queryByRole("link", { name: "Verified transaction" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("says when no run and no decision are stored", () => {
    render(
      <AiRunPanel
        run={describeAiRun({ configured: true, readable: true, scheduler: null, decision: null })}
      />,
    );
    expect(screen.getByText("No AI run recorded")).toBeTruthy();
    expect(screen.getByText("No AI decision is stored.")).toBeTruthy();
    expect(screen.getByText(/Latest successful run: Not recorded/)).toBeTruthy();
    expect(screen.getByText(/Most recent decision: Not recorded/)).toBeTruthy();
  });
});
