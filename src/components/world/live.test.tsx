// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed, CivilizationActivity } from "@/components/world/activity-feed";
import { CivilizationStatus } from "@/components/world/civilization-status";
import { GrowthDecisions } from "@/components/world/growth-decisions";
import { WorldPanel, WorldStatus } from "@/components/world/world-panel";
import { createLiveStore, type RealtimeConnector, type RealtimeHandlers } from "@/components/world/live-store";
import type { BuildingView, CitizenView, ClockView, TownNeedView, TownProjectView, WorldEventView, WorldLive, WorldSnapshot } from "@/lib/world/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string; title?: string }) => (
    <a href={props.href} className={props.className} title={props.title}>
      {props.children}
    </a>
  ),
}));

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/activity" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
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

function event(seq: number, patch: Partial<WorldEventView> = {}): WorldEventView {
  return {
    id: `e${seq}`,
    seq,
    kind: "social.met",
    category: "social",
    source: "simulation",
    summary: `Event number ${seq} at Commons Square.`,
    occurredAt: "2026-10-13T00:00:20Z",
    worldS: 21000 + seq,
    tickSeq: 4,
    tokenId: null,
    relatedTokenId: null,
    buildingId: "commons-square",
    buildingName: "Commons Square",
    chainStatus: "offchain",
    txHash: null,
    ...patch,
  };
}

function snapshot(events: WorldEventView[]): WorldSnapshot {
  return {
    status: "ok",
    clock,
    buildings: [],
    citizens: [],
    events,
    latestSeq: events[0]?.seq ?? 0,
    townNeeds: [],
    townNeedsReady: false,
    roads: [],
    roadsReady: false,
    townProjects: [],
    townProjectsReady: false,
  };
}

function live(events: WorldEventView[], patch: Partial<WorldLive> = {}): WorldLive {
  return { ...snapshot(events), clock: { ...clock, tickSeq: 6 }, since: 0, gap: false, ...patch };
}

type Observed = { callback: IntersectionObserverCallback; element: Element };
let observers: Observed[] = [];

beforeEach(() => {
  observers = [];
  nav.replace.mockReset();
  nav.pathname = "/activity";
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        observers.push({ callback: this.callback, element });
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  window.location.hash = "";
  cleanup();
  vi.unstubAllGlobals();
});

function setTopVisible(visible: boolean) {
  for (const observer of observers) {
    if (observer.element.getAttribute("aria-hidden") === "true") {
      observer.callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  }
}

describe("live store", () => {
  it("requests only events after the latest seen seq and merges them newest first", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(live([event(12), event(11)], { since: 10 }))));
    const store = createLiveStore(snapshot([event(10), event(9)]), { fetcher: fetcher as unknown as typeof fetch });
    await store.refresh();
    expect(fetcher).toHaveBeenCalledWith("/api/world/live?since=10", expect.anything());
    expect(store.getState().recent.map((e) => e.seq)).toEqual([12, 11, 10, 9]);
    expect(store.getState().snapshot?.latestSeq).toBe(12);
    expect(store.getState().snapshot?.clock.tickSeq).toBe(6);
  });

  it("asks every feed to reload after a gap and ignores responses older than what it has", async () => {
    let body: WorldLive = live([event(300)], { gap: true });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    const store = createLiveStore(snapshot([event(10)]), { fetcher: fetcher as unknown as typeof fetch });
    await store.refresh();
    expect(store.getState().resetToken).toBe(1);
    expect(store.getState().recent.map((e) => e.seq)).toEqual([300]);
    body = { ...live([]), clock: { ...clock, tickSeq: 2 } };
    await store.refresh();
    expect(store.getState().snapshot?.clock.tickSeq).toBe(6);
  });

  it("marks itself reconnecting on failure and recovers on the next good read", async () => {
    let fail = true;
    const fetcher = vi.fn(async () => {
      if (fail) {
        throw new Error("offline");
      }
      return new Response(JSON.stringify(live([event(11)])));
    });
    const store = createLiveStore(snapshot([event(10)]), { fetcher: fetcher as unknown as typeof fetch });
    await store.refresh();
    expect(store.getState().link).toBe("reconnecting");
    expect(store.getState().snapshot?.latestSeq).toBe(10);
    fail = false;
    await store.refresh();
    expect(store.getState().link).toBe("polling");
    expect(store.getState().recent[0]!.seq).toBe(11);
  });

  it("closes a realtime socket that does not recover, keeps polling, and retries after a cool-down", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(live([]))));
      const connections: { handlers: RealtimeHandlers; close: ReturnType<typeof vi.fn> }[] = [];
      const connectRealtime: RealtimeConnector = async (_config, handlers) => {
        const close = vi.fn();
        connections.push({ handlers, close });
        return close;
      };
      const store = createLiveStore(snapshot([event(10)]), {
        fetcher: fetcher as unknown as typeof fetch,
        realtime: { url: "https://example.supabase.co", anonKey: "public-anon", channel: "chogos-world" },
        connectRealtime,
      });
      const unsubscribe = store.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(connections).toHaveLength(1);

      connections[0]!.handlers.onStatus("SUBSCRIBED");
      expect(store.getState().realtime).toBe("subscribed");

      connections[0]!.handlers.onStatus("CHANNEL_ERROR");
      expect(store.getState().realtime).toBe("error");
      await vi.advanceTimersByTimeAsync(10_000);
      connections[0]!.handlers.onStatus("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(connections[0]!.close).not.toHaveBeenCalled();

      connections[0]!.handlers.onStatus("CHANNEL_ERROR");
      const before = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(connections[0]!.close).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.length).toBeGreaterThan(before);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connections[0]!.close).toHaveBeenCalledTimes(1);
      expect(connections[0]!.handlers.isCurrent()).toBe(false);
      expect(store.getState().realtime).toBe("error");

      await vi.advanceTimersByTimeAsync(59_000);
      expect(connections).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connections).toHaveLength(2);
      connections[1]!.handlers.onStatus("SUBSCRIBED");
      expect(store.getState().realtime).toBe("subscribed");

      unsubscribe();
      expect(connections[1]!.close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connections).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("civilization status", () => {
  it("shows stored counts and bars only where progress was recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            view: { deploymentState: "live", summary: "Deployed code passed the public checks. A person starts one stored payout." },
          }),
        ),
      ),
    );
    const world = {
      ...snapshot([]),
      citizens: [
        {
          tokenId: "7",
          name: "Pip",
          origin: "founding" as const,
          role: "farmer" as const,
          homeId: null,
          workId: null,
          activity: "idle" as const,
          locationId: null,
          originId: null,
          destinationId: null,
          purpose: null,
          startedAt: "2026-10-13T00:00:00Z",
          endsAt: null,
          worldStartedS: 20000,
          worldEndsS: null,
          shiftsToday: 0,
          dayIndex: 0,
          decisionSource: "simulation" as const,
          updatedTick: 1,
        },
      ],
      buildings: [
        {
          id: "hall",
          kind: "hall" as const,
          name: "Commons Hall",
          x: 1,
          y: 1,
          w: 4,
          h: 4,
          doorX: 2,
          doorY: 4,
          capacity: 4,
          jobSlots: null,
          role: null,
          openAir: false,
          status: "under_construction" as const,
          constructionProgress: null,
          batchShifts: null,
          productionProgress: 0,
          batchesCompleted: 0,
          stock: {},
          completedAt: null,
          updatedTick: 1,
        },
        {
          id: "farm",
          kind: "farm" as const,
          name: "North Farm",
          x: 8,
          y: 8,
          w: 4,
          h: 4,
          doorX: 9,
          doorY: 11,
          capacity: null,
          jobSlots: 2,
          role: "farmer" as const,
          openAir: false,
          status: "under_construction" as const,
          constructionProgress: 36,
          batchShifts: null,
          productionProgress: 0,
          batchesCompleted: 0,
          stock: {},
          completedAt: null,
          updatedTick: 1,
        },
      ],
    };
    render(
      <CivilizationStatus
        snapshot={world}
        aiRun={{
          state: "interrupted",
          title: "The run was interrupted.",
          detail: "The invocation stopped before it finished.",
          lastRunAt: null,
          lastSuccessAt: null,
          latestDecisionAt: null,
          decision: null,
        }}
        skewMs={0}
        link="live"
        realtime="subscribed"
        onPick={() => undefined}
      />,
    );
    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.getByText(/North Farm · 36%/)).toBeTruthy();
    expect(screen.queryByText(/Commons Hall ·/)).toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("36");
    expect(screen.getByText("1 registered")).toBeTruthy();
    expect(screen.getAllByText("Not tracked").length).toBeGreaterThan(0);
    const mind = screen.getByRole("link", { name: /AI mind/ });
    expect(mind.textContent).toContain("Interrupted");
    expect(mind.getAttribute("title")).toContain("stopped before it finished");
    expect(screen.queryByText("Running")).toBeNull();
    const bank = await screen.findByRole("link", { name: /ChogBank/ });
    expect(bank.textContent).toContain("Verified");
    expect(bank.textContent?.toLowerCase()).not.toMatch(/operat|paying/);
  });
});

describe("activity feed", () => {
  it("shows a confirmed NFT transfer under Onchain with a transaction link", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const store = createLiveStore(
      snapshot([
        event(8, {
          kind: "nft.transferred",
          category: "onchain",
          source: "onchain",
          summary:
            "Chog #7 transferred from 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222 in block 11.",
          tokenId: "7",
          buildingId: null,
          buildingName: null,
          worldS: null,
          chainStatus: "confirmed",
          txHash: hash,
          txUrl: `https://monadscan.com/tx/${hash}`,
        }),
      ]),
      { fetcher: vi.fn() as unknown as typeof fetch },
    );
    render(<ActivityFeed store={store} />);
    expect(screen.getAllByText("Onchain").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Chog #7" }).getAttribute("href")).toBe("/?citizen=7");
    const tx = screen.getByRole("link", { name: /0xabababab/ });
    expect(tx.getAttribute("href")).toBe(`https://monadscan.com/tx/${hash}`);
    expect(tx.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/0x1111111111111111111111111111111111111111/)).toBeTruthy();
    expect(screen.getByText(/0x2222222222222222222222222222222222222222/)).toBeTruthy();
  });

  it("adds block and token links for canonical transfer evidence and keeps AI events off that path", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const contract = "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763";
    const store = createLiveStore(
      snapshot([
        event(8, {
          kind: "nft.transferred",
          category: "onchain",
          source: "onchain",
          summary: "Chog #7 transferred.",
          tokenId: "7",
          chainStatus: "confirmed",
          txHash: hash,
          txUrl: `https://monadscan.com/tx/${hash}`,
          transfer: {
            kind: "nft.transferred",
            canonical: true,
            consistent: true,
            chainId: 143,
            txHash: hash,
            payloadTxHash: null,
            canonicalState: "canonical",
            chainStatus: "confirmed",
            issues: [],
            blockNumber: "11",
            blockHash: `0x${"cd".repeat(32)}`,
            txIndex: null,
            logIndex: "4",
            contract,
            tokenId: "7",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            links: {
              transaction: `https://monadscan.com/tx/${hash}`,
              block: "https://monadscan.com/block/11",
              contract: `https://monadscan.com/address/${contract}`,
              from: "https://monadscan.com/address/0x1111111111111111111111111111111111111111",
              to: "https://monadscan.com/address/0x2222222222222222222222222222222222222222",
              token: `https://monadscan.com/nft/${contract}/7`,
            },
          },
        }),
        event(7, { source: "ai", category: "ai", summary: "The AI mind chose to rest." }),
      ]),
      { fetcher: vi.fn() as unknown as typeof fetch },
    );
    render(<ActivityFeed store={store} />);
    expect(screen.getByRole("link", { name: "Block 11" }).getAttribute("href")).toBe("https://monadscan.com/block/11");
    expect(screen.getByRole("link", { name: "Token 7" }).getAttribute("href")).toBe(`https://monadscan.com/nft/${contract}/7`);
    expect(screen.getByText("The AI mind chose to rest.")).toBeTruthy();
    expect(screen.queryByText("Real chain activity")).toBeNull();
  });

  it("withholds explorer links for a testnet or wrong-contract transfer even when the row says confirmed", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const wrong = "0x3333333333333333333333333333333333333333";
    const store = createLiveStore(
      snapshot([
        event(9, {
          kind: "nft.transferred",
          category: "onchain",
          source: "onchain",
          summary: "Chog #7 transferred.",
          tokenId: "7",
          chainStatus: "confirmed",
          txHash: hash,
          txUrl: `https://testnet.monadscan.com/tx/${hash}`,
          transfer: {
            kind: "nft.transferred",
            canonical: true,
            consistent: true,
            canonicalState: "canonical",
            chainStatus: "confirmed",
            issues: [],
            chainId: 10143,
            txHash: hash,
            payloadTxHash: null,
            blockNumber: "11",
            blockHash: `0x${"cd".repeat(32)}`,
            txIndex: null,
            logIndex: "4",
            contract: wrong,
            tokenId: "7",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            links: {
              transaction: `https://testnet.monadscan.com/tx/${hash}`,
              block: "https://testnet.monadscan.com/block/11",
              contract: `https://testnet.monadscan.com/address/${wrong}`,
              from: "https://testnet.monadscan.com/address/0x1111111111111111111111111111111111111111",
              to: "https://testnet.monadscan.com/address/0x2222222222222222222222222222222222222222",
              token: `https://testnet.monadscan.com/nft/${wrong}/7`,
            },
          },
        }),
      ]),
      { fetcher: vi.fn() as unknown as typeof fetch },
    );
    render(<ActivityFeed store={store} />);
    expect(screen.getByText(/Chain id is not Monad mainnet/)).toBeTruthy();
    expect(screen.getByText(/Explorer links are withheld/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /0xabababab/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Block 11" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Contract" })).toBeNull();
  });

  it("shows recorded events newest first with source labels and entity links", () => {
    const store = createLiveStore(snapshot([event(3, { tokenId: "7", summary: "Chog #7 came to Commons Square to socialize." }), event(2)]), {
      fetcher: vi.fn() as unknown as typeof fetch,
    });
    render(<ActivityFeed store={store} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.getAttribute("data-seq")).toBe("3");
    expect(items[1]!.getAttribute("data-seq")).toBe("2");
    expect(screen.getAllByText("Simulation", { selector: "span" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Chog #7" }).getAttribute("href")).toBe("/?citizen=7");
    expect(screen.getAllByRole("link", { name: "Commons Square" })[0]!.getAttribute("href")).toBe("/?building=commons-square");
  });

  it("holds live events behind New activity while the reader is further down", async () => {
    let ready = false;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(live(ready ? [event(5), event(4)] : []))));
    const store = createLiveStore(snapshot([event(3)]), { fetcher: fetcher as unknown as typeof fetch });
    render(<ActivityFeed store={store} />);
    await act(async () => {
      await store.refresh();
    });
    act(() => setTopVisible(false));
    ready = true;
    await act(async () => {
      await store.refresh();
    });
    const pill = await screen.findByRole("button", { name: /New activity · 2/ });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(pill);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(screen.getAllByRole("listitem")[0]!.getAttribute("data-seq")).toBe("5");
    expect(screen.queryByRole("button", { name: /New activity/ })).toBeNull();
  });

  it("refetches from the server when a filter changes and says honestly when nothing exists", async () => {
    const fetcher = vi.fn(async (url: string) => url && new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null })));
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([event(3)]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} />);
    expect(screen.getByRole("link", { name: "AI decisions" }).getAttribute("href")).toBe("/activity?source=ai");
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "ai" } });
    await screen.findByText(/Only genuine model-backed decisions are labeled AI/);
    expect(fetcher.mock.calls.map((call) => String(call[0])).some((url) => url.includes("source=ai"))).toBe(true);
  });

  it("asks for the Onchain category, where confirmed AI wallet creations are included", async () => {
    const fetcher = vi.fn(async (url: string) => url && new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null })));
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([event(3)]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} />);
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "onchain" } });
    await screen.findByText(/confirmed AI wallet creations appear here/);
    const onchain = fetcher.mock.calls.map((call) => String(call[0])).find((url) => url.includes("category=onchain"));
    expect(onchain).toBeTruthy();
    expect(onchain).not.toContain("source=");
  });

  it("maps the Category AI filter to genuine source=ai events", async () => {
    const fetcher = vi.fn(async (url: string) => url && new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null })));
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([event(3)]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} />);
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "ai" } });
    await screen.findByText(/Only genuine model-backed decisions are labeled AI/);
    const ai = fetcher.mock.calls.map((call) => String(call[0])).find((url) => url.includes("source=ai") && !url.includes("category="));
    expect(ai).toBeTruthy();
    expect(ai).not.toContain("category=ai");
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "construction" } });
    await waitFor(() =>
      expect(
        fetcher.mock.calls
          .map((call) => String(call[0]))
          .some((url) => url.includes("category=construction") && !url.includes("source=ai")),
      ).toBe(true),
    );
  });

  it("opens History from source=ai and writes later filter changes to the URL", async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        url &&
        new Response(
          JSON.stringify({
            status: "ok",
            events: [event(9, { source: "ai", category: "construction", kind: "road.placed", summary: "An AI road was placed." })],
            nextBefore: null,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} initialFilter={{ source: "ai" }} mode="page" />);
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("ai");
    await screen.findByText("An AI road was placed.");
    expect(fetcher.mock.calls.map((call) => String(call[0])).some((url) => url.includes("source=ai"))).toBe(true);
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "construction" } });
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(String(nav.replace.mock.calls.at(-1)?.[0])).toBe("/activity?category=construction&source=ai");
  });

  it("lists Chogs that joined in system activity, with Verify and the Genesis token", async () => {
    const genesis = "https://monadscan.com/nft/0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763/1547";
    const fetcher = vi.fn(async (url: string) => {
      if (!String(url).includes("category=membership")) {
        return new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null }));
      }
      return new Response(
        JSON.stringify({
          status: "ok",
          nextBefore: null,
          events: [
            event(2, {
              kind: "genesis_joined",
              category: "membership",
              source: "system",
              tokenId: "7",
              summary: "Chog Genesis #7 verified in the ChogTreasury founding roster.",
            }),
            event(9, {
              id: "enrolled-1547",
              kind: "citizen_enrolled",
              category: "membership",
              source: "system",
              tokenId: "1547",
              summary: "Chog Genesis #1547 enrolled by its verified owner.",
              onchain: {
                title: "Chog joined the civilization",
                note: "ownerOf",
                links: [{ label: "Genesis token", href: genesis, value: "1547" }],
              },
            }),
            event(12, { kind: "town.need_detected", category: "world", source: "system", tokenId: null, summary: "Food is scarce." }),
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([event(3)]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} initialFilter={{ source: "system" }} mode="page" />);
    expect(await screen.findByRole("heading", { name: "Joined the civilization" })).toBeTruthy();
    expect(screen.getByText("Chog Genesis #1547 enrolled by its verified owner.")).toBeTruthy();
    expect(screen.getByText("Chog Genesis #7 verified in the ChogTreasury founding roster.")).toBeTruthy();
    expect(screen.queryByText("Food is scarce.")).toBeNull();
    const enrolled = screen.getByText("Chog Genesis #1547 enrolled by its verified owner.").closest("li");
    expect(enrolled?.querySelector('a[href="/verify/events/enrolled-1547"]')?.textContent).toBe("Verify");
    expect(enrolled?.querySelector(`a[href="${genesis}"]`)?.textContent).toBe("Genesis token");
    expect(screen.queryByRole("link", { name: "All joined" })).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps newest world activity above a collapsed Joined section in the world panel", async () => {
    const genesis = "https://monadscan.com/nft/0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763/1547";
    const enrolled = event(9, {
      id: "enrolled-1547",
      kind: "citizen_enrolled",
      category: "membership",
      source: "system",
      tokenId: "1547",
      summary: "Chog Genesis #1547 enrolled by its verified owner.",
      onchain: {
        title: "Chog joined the civilization",
        note: "ownerOf",
        links: [{ label: "Genesis token", href: genesis, value: "1547" }],
      },
    });
    const olderRoster = event(4, {
      id: "roster-52",
      kind: "genesis_joined",
      category: "membership",
      source: "system",
      tokenId: "52",
      summary: "Chog Genesis #52 verified in the ChogTreasury founding roster.",
    });
    const latest = event(30, { summary: "A citizen gathered food." });
    const fetcher = vi.fn(async (url: string) => {
      if (!String(url).includes("category=membership")) {
        return new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null }));
      }
      return new Response(JSON.stringify({ status: "ok", nextBefore: null, events: [enrolled] }));
    });
    vi.stubGlobal("fetch", fetcher);
    window.location.hash = "#joined-civilization";
    const store = createLiveStore(snapshot([latest, enrolled, olderRoster]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<ActivityFeed store={store} dock />);

    const activity = await screen.findByText("A citizen gathered food.");
    const summary = await screen.findByText("Joined the civilization · 1 Chog");
    expect(activity.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    expect(screen.getAllByText("Chog Genesis #1547 enrolled by its verified owner.")).toHaveLength(1);
    expect(screen.getByText("Chog Genesis #1547 enrolled by its verified owner.").closest("details")).toBe(details);
    expect(screen.getByText("Chog Genesis #52 verified in the ChogTreasury founding roster.").closest("details")).toBeNull();
    expect(screen.getByText("Chog Genesis #52 verified in the ChogTreasury founding roster.").compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    const row = screen.getByText("Chog Genesis #1547 enrolled by its verified owner.").closest("li");
    expect(row?.querySelector('a[href="/verify/events/enrolled-1547"]')?.textContent).toBe("Verify");
    expect(row?.querySelector(`a[href="${genesis}"]`)?.textContent).toBe("Genesis token");
    expect(screen.getByRole("link", { name: "All joined" }).getAttribute("href")).toBe("/activity#joined-civilization");
  });

  it("scrolls to Joined only when the history page opens on that link", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (!String(url).includes("category=membership")) {
        return new Response(JSON.stringify({ status: "ok", events: [event(30, { summary: "A citizen gathered food." })], nextBefore: null }));
      }
      return new Response(
        JSON.stringify({
          status: "ok",
          nextBefore: null,
          events: [
            event(2, {
              kind: "genesis_joined",
              category: "membership",
              source: "system",
              tokenId: "7",
              summary: "Chog Genesis #7 verified in the ChogTreasury founding roster.",
            }),
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const store = createLiveStore(snapshot([]), { fetcher: vi.fn() as unknown as typeof fetch });
    const view = render(<ActivityFeed store={store} mode="page" />);
    const activity = await screen.findByText("A citizen gathered food.");
    const heading = await screen.findByRole("heading", { name: "Joined the civilization" });
    expect(activity.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    view.unmount();
    window.location.hash = "#joined-civilization";
    render(<ActivityFeed store={store} mode="page" />);
    await screen.findByRole("heading", { name: "Joined the civilization" });
    await waitFor(() => expect(document.getElementById("joined-civilization")?.scrollIntoView).toHaveBeenCalled());
  });

  it("keeps a 20-row world preview, labels simulation apart from chain rows, and preserves scroll", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => {
      const seq = 21 - index;
      return event(seq, { id: `sim-${seq}`, summary: `Sim event ${seq}` });
    });
    const store = createLiveStore(snapshot(rows), { fetcher: vi.fn() as unknown as typeof fetch });
    render(
      <ActivityFeed
        store={store}
        dock
        preview
        aiRun={{
          state: "interrupted",
          title: "The run was interrupted.",
          detail: "The invocation stopped before it finished.",
          lastRunAt: null,
          lastSuccessAt: null,
          latestDecisionAt: null,
          decision: null,
        }}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("Sim event 21")).toBeTruthy();
    expect(screen.queryByText("Sim event 1")).toBeNull();
    expect(screen.getAllByText("Simulation", { selector: "span" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /0x/ })).toBeNull();
    expect(screen.getByText("AI mind · Interrupted").getAttribute("title")).toBe("The invocation stopped before it finished.");
    expect(screen.queryByText("The run was interrupted.")).toBeNull();
    expect(screen.getByRole("link", { name: "View all in History →" }).getAttribute("href")).toBe("/activity#civilization-activity");
    expect(document.querySelector(".world-category-scroll")).toBeTruthy();
  });

  it("gives civilization joins their own window and a history link", async () => {
    const enrolled = event(9, {
      id: "enrolled-8",
      kind: "citizen_enrolled",
      category: "membership",
      source: "system",
      tokenId: "8",
      summary: "Chog Genesis #8 enrolled by its verified owner.",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("category=membership")) {
          return new Response(JSON.stringify({ status: "ok", events: [], nextBefore: null }));
        }
        return new Response(JSON.stringify({ status: "ok", events: [enrolled], nextBefore: null }));
      }),
    );
    const store = createLiveStore(snapshot([]), { fetcher: vi.fn() as unknown as typeof fetch });
    render(<CivilizationActivity store={store} />);
    expect(await screen.findByRole("heading", { name: "Civilization activity" })).toBeTruthy();
    expect(screen.getByText("Chog Genesis #8 enrolled by its verified owner.")).toBeTruthy();
    expect(screen.getByText("System", { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /0x/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View all in History →" }).getAttribute("href")).toBe(
      "/activity?source=system#joined-civilization",
    );
  });
});

describe("town growth", () => {
  it("shows a confirmed AI wallet decision with its reason and Verify link", async () => {
    const hash = `0x${"cd".repeat(32)}`;
    const created = event(12, {
      id: "wallet-91",
      kind: "wallet.created",
      category: "ai",
      source: "ai",
      summary: "The AI mind created the permanent wallet for Chog #91 on Monad.",
      tokenId: "91",
      buildingId: null,
      buildingName: null,
      chainStatus: "confirmed",
      txHash: hash,
      txUrl: `https://monadscan.com/tx/${hash}`,
      mind: { summary: null, rationale: "Chog #91 needs a permanent wallet before any payout." },
    });
    const decided = event(11, {
      kind: "wallet.decided",
      category: "ai",
      source: "ai",
      summary: "The AI mind decided to create a permanent wallet for Chog #91.",
      tokenId: "91",
      mind: { summary: null, rationale: "Earlier decision for the same citizen." },
    });
    const pending = event(10, {
      kind: "wallet.decided",
      category: "ai",
      source: "ai",
      summary: "The AI mind decided to create a permanent wallet for Chog #115.",
      tokenId: "115",
      mind: { summary: null, rationale: "Chog #115 is enrolled and has no wallet." },
    });
    const road = event(4, {
      kind: "road.placed",
      category: "construction",
      source: "ai",
      summary: "An AI road was placed.",
      tokenId: null,
      mind: { summary: null, rationale: "The north path was missing." },
    });
    const fetcher = vi.fn(async (url: string) => {
      const events = String(url).includes("category=construction") ? [road] : [created, decided, pending];
      return new Response(JSON.stringify({ status: "ok", events, nextBefore: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<GrowthDecisions />);
    expect(await screen.findByText("Chog #91 needs a permanent wallet before any payout.")).toBeTruthy();
    expect(document.body.textContent).toContain("The AI mind created the permanent wallet for Chog #91 on Monad.");
    const verify = screen.getAllByRole("link", { name: "Verify" }).find((link) => link.getAttribute("href") === "/verify/events/wallet-91");
    expect(verify).toBeTruthy();
    expect(screen.getByRole("link", { name: /0xcdcdcdcd/ }).getAttribute("href")).toBe(`https://monadscan.com/tx/${hash}`);
    expect(screen.queryByText("Earlier decision for the same citizen.")).toBeNull();
    expect(screen.getByText("Chog #115 is enrolled and has no wallet.")).toBeTruthy();
    expect(screen.getByText("An AI road was placed.")).toBeTruthy();
    expect(screen.getAllByText("AI", { selector: "span" }).length).toBeGreaterThan(0);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("category=construction");
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("source=ai") && !String(call[0]).includes("category="))).toBe(true);
  });

  it("shows the 20 newest town decisions in the world window and links to history", async () => {
    const rows = Array.from({ length: 24 }, (_, index) => {
      const seq = 24 - index;
      return event(seq, {
        id: `road-${seq}`,
        kind: "road.placed",
        category: "construction",
        source: "ai",
        summary: `Road decision ${seq}`,
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok", events: rows, nextBefore: null }))),
    );
    render(<GrowthDecisions dock />);
    expect(await screen.findByText("Road decision 24")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByText("Road decision 4")).toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(Number(items[0]!.getAttribute("data-seq"))).toBeGreaterThan(Number(items[1]!.getAttribute("data-seq")));
    expect(screen.getByRole("link", { name: "View all in History →" }).getAttribute("href")).toBe("/activity#town-growth");
  });
});

describe("town needs inspector", () => {
  const foodNeed: TownNeedView = {
    needType: "food_shortage",
    status: "active",
    priority: 100,
    firstDetectedAt: "2026-10-15T20:00:00Z",
    lastEvaluatedAt: "2026-10-15T20:00:00Z",
    lastStatusChangedAt: "2026-10-15T20:00:00Z",
    resolvedAt: null,
    evidence: {
      food: 12,
      wood: 60,
      stone: 40,
      tools: 20,
      vacantServedLots: 20,
      reservedLots: 6,
      farms: 2,
      workshops: 2,
      houses: 15,
      underConstruction: [],
    },
    blocker: null,
    recommendedAction: "work",
    recommendedKind: "none",
    lastEventId: null,
    lastDecisionId: null,
  };

  it("shows a persisted food shortage and does not invent one when needs are unavailable", () => {
    render(
      <WorldStatus
        snapshot={{ ...snapshot([]), townNeeds: [foodNeed], townNeedsReady: true }}
        skewMs={0}
        link="live"
        realtime="subscribed"
      />,
    );
    expect(screen.getByText(/Food supply is running low/)).toBeTruthy();
    cleanup();
    render(
      <WorldStatus snapshot={snapshot([])} skewMs={0} link="live" realtime="subscribed" />,
    );
    expect(screen.getByText(/Town needs are not in this database yet/)).toBeTruthy();
    expect(screen.queryByText(/Food supply is running low/)).toBeNull();
  });

  it("shows whether the road overlay has been applied", () => {
    render(<WorldStatus snapshot={snapshot([])} skewMs={0} link="live" realtime="subscribed" />);
    expect(screen.getByText(/Road overlay is not in this database yet/)).toBeTruthy();
    cleanup();
    render(
      <WorldStatus snapshot={{ ...snapshot([]), roadsReady: true }} skewMs={0} link="live" realtime="subscribed" />,
    );
    expect(screen.getByText(/No constructed road spurs yet/)).toBeTruthy();
  });

  it("shows whether town projects have been applied", () => {
    render(<WorldStatus snapshot={snapshot([])} skewMs={0} link="live" realtime="subscribed" />);
    expect(screen.getByText(/Town projects are not in this database yet/)).toBeTruthy();
    cleanup();
    render(
      <WorldStatus snapshot={{ ...snapshot([]), townProjectsReady: true }} skewMs={0} link="live" realtime="subscribed" />,
    );
    expect(screen.getByText(/No active development project/)).toBeTruthy();
    expect(screen.queryByText(/Town projects are not in this database yet/)).toBeNull();
  });

  it("shows a persisted territorial project as planned, not complete", () => {
    const project: TownProjectView = {
      id: "11111111-1111-4111-8111-111111111111",
      projectType: "territorial",
      objectiveKey: "territorial:east-y2-64",
      name: "Open plot-64-2",
      description: "Place a catalog road stub so a reserved surveyed lot can be served.",
      status: "active",
      priority: 30,
      needType: null,
      justification: "6 reserved lots remain. Catalog stub east-y2-64 is the next unused spur.",
      steps: [
        {
          id: "place_road",
          title: "Place catalog road east-y2-64",
          status: "eligible",
          action: "build",
          buildKind: "road",
          roadStubId: "east-y2-64",
          plotId: "plot-64-2",
          buildingId: null,
          blocker: null,
          skipped: false,
          completedAt: null,
          eventId: null,
        },
      ],
      currentStepId: "place_road",
      currentStepIndex: 0,
      blocker: null,
      recommendedAction: "build",
      recommendedKind: "road",
      recommendedStubId: "east-y2-64",
      relatedBuildingId: null,
      relatedPlotId: "plot-64-2",
      relatedRoadId: "east-y2-64",
      relatedCitizenId: null,
      evidence: {
        food: 400,
        wood: 400,
        stone: 400,
        tools: 400,
        vacantServedLots: 20,
        reservedLots: 6,
        farms: 2,
        workshops: 2,
        houses: 15,
        underConstruction: [],
        houseBeds: 48,
        pendingHouseBeds: 12,
        assignedResidents: 48,
        unassignedCitizens: 11,
        farmBatches: 0,
        workshopBatches: 0,
        placedStubIds: [],
      },
      createdAt: "2026-10-16T20:00:00Z",
      updatedAt: "2026-10-16T20:00:00Z",
      completedAt: null,
      lastEvaluatedAt: "2026-10-16T20:00:00Z",
      lastEventId: null,
      lastDecisionId: null,
    };
    render(
      <WorldStatus
        snapshot={{ ...snapshot([]), townProjects: [project], townProjectsReady: true }}
        skewMs={0}
        link="live"
        realtime="subscribed"
      />,
    );
    expect(screen.getByText(/Open plot-64-2 · active/)).toBeTruthy();
    expect(screen.queryByText(/reached its completion condition/)).toBeNull();
  });

  it("shows the project inspector as planned work, not a completed road", () => {
    const project: TownProjectView = {
      id: "11111111-1111-4111-8111-111111111111",
      projectType: "territorial",
      objectiveKey: "territorial:east-y2-64",
      name: "Open plot-64-2",
      description: "Place a catalog road stub so a reserved surveyed lot can be served.",
      status: "active",
      priority: 30,
      needType: null,
      justification: "6 reserved lots remain. Catalog stub east-y2-64 is the next unused spur.",
      steps: [
        {
          id: "place_road",
          title: "Place catalog road east-y2-64",
          status: "eligible",
          action: "build",
          buildKind: "road",
          roadStubId: "east-y2-64",
          plotId: "plot-64-2",
          buildingId: null,
          blocker: null,
          skipped: false,
          completedAt: null,
          eventId: null,
        },
        {
          id: "unlock_plot",
          title: "Wait until plot-64-2 is road-served",
          status: "pending",
          action: "none",
          buildKind: "none",
          roadStubId: "east-y2-64",
          plotId: "plot-64-2",
          buildingId: null,
          blocker: null,
          skipped: false,
          completedAt: null,
          eventId: null,
        },
      ],
      currentStepId: "place_road",
      currentStepIndex: 0,
      blocker: null,
      recommendedAction: "build",
      recommendedKind: "road",
      recommendedStubId: "east-y2-64",
      relatedBuildingId: null,
      relatedPlotId: "plot-64-2",
      relatedRoadId: "east-y2-64",
      relatedCitizenId: null,
      evidence: {
        food: 400,
        wood: 400,
        stone: 400,
        tools: 400,
        vacantServedLots: 20,
        reservedLots: 6,
        farms: 2,
        workshops: 2,
        houses: 15,
        underConstruction: [],
        houseBeds: 48,
        pendingHouseBeds: 12,
        assignedResidents: 48,
        unassignedCitizens: 11,
        farmBatches: 0,
        workshopBatches: 0,
        placedStubIds: [],
      },
      createdAt: "2026-10-16T20:00:00Z",
      updatedAt: "2026-10-16T20:00:00Z",
      completedAt: null,
      lastEvaluatedAt: "2026-10-16T20:00:00Z",
      lastEventId: null,
      lastDecisionId: null,
    };
    render(
      <WorldPanel
        snapshot={{ ...snapshot([]), townProjects: [project], townProjectsReady: true }}
        skewMs={0}
        selection={{ type: "project", id: project.id }}
        recent={[]}
        follow={false}
        onToggleFollow={() => undefined}
        onPick={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Project Open plot-64-2")).toBeTruthy();
    expect(screen.getByText("territorial · active")).toBeTruthy();
    expect(screen.getByText(/Place catalog road east-y2-64 \(eligible\)/)).toBeTruthy();
    expect(screen.getByText(/Wait until plot-64-2 is road-served \(not started\)/)).toBeTruthy();
    expect(screen.getByText(/Visitors cannot create or edit projects/)).toBeTruthy();
    expect(screen.getByText("No project event yet")).toBeTruthy();
    expect(screen.queryByText(/functioning farm/)).toBeNull();
    expect(screen.queryByText(/reached its completion condition/)).toBeNull();
  });

  it("shows no critical shortage when persisted needs are healthy", () => {
    render(
      <WorldStatus
        snapshot={{ ...snapshot([]), townNeedsReady: true }}
        skewMs={0}
        link="live"
        realtime="subscribed"
      />,
    );
    expect(screen.getByText(/No critical shortage is currently detected/)).toBeTruthy();
    expect(screen.queryByText(/Food supply is running low/)).toBeNull();
    expect(screen.queryByText(/Town needs are not in this database yet/)).toBeNull();
  });
});

describe("in-world profiles", () => {
  const farm: BuildingView = {
    id: "north-farm",
    kind: "farm",
    name: "North Farm",
    x: 4,
    y: 8,
    w: 6,
    h: 4,
    doorX: 6,
    doorY: 11,
    capacity: null,
    jobSlots: 2,
    role: "farmer",
    openAir: false,
    status: "under_construction",
    constructionProgress: 36,
    batchShifts: 4,
    productionProgress: 1,
    batchesCompleted: 2,
    stock: { food: 12 },
    completedAt: null,
    updatedTick: 4,
  };
  const citizen: CitizenView = {
    tokenId: "7",
    name: "Pip",
    origin: "founding",
    role: "farmer",
    homeId: null,
    workId: farm.id,
    activity: "working",
    locationId: farm.id,
    originId: null,
    destinationId: null,
    purpose: "work",
    startedAt: "2026-10-13T00:00:00Z",
    endsAt: null,
    worldStartedS: 20000,
    worldEndsS: null,
    shiftsToday: 1,
    dayIndex: 0,
    decisionSource: "ai",
    updatedTick: 4,
  };

  it("keeps recorded citizen and building fields and closes inside the world", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "unavailable", detail: "Mind records are not available yet." }))),
    );
    const world = { ...snapshot([]), citizens: [citizen], buildings: [farm] };
    const picks: Array<unknown> = [];
    const onPick = (selection: unknown) => {
      picks.push(selection);
    };
    const citizenView = render(
      <WorldPanel
        snapshot={world}
        skewMs={0}
        selection={{ type: "citizen", tokenId: "7" }}
        recent={[]}
        follow
        onToggleFollow={() => undefined}
        onPick={onPick}
      />,
    );
    expect(screen.getByText("Founding citizen")).toBeTruthy();
    expect(screen.getByText("Pip")).toBeTruthy();
    expect(screen.getByText("Token 7")).toBeTruthy();
    expect(screen.getByText(/Working at North Farm/)).toBeTruthy();
    expect(screen.getByText("Farmer")).toBeTruthy();
    expect(screen.getAllByText("North Farm").length).toBeGreaterThan(0);
    expect(screen.getByText("Shelters at Commons Hall")).toBeTruthy();
    expect(screen.getByText(/of 2/)).toBeTruthy();
    expect(screen.getByText("AI mind")).toBeTruthy();
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open profile" }).getAttribute("href")).toBe("/citizens/7");
    expect(await screen.findByText("Mind records are not available yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(picks).toEqual([null]);
    citizenView.unmount();

    picks.length = 0;
    render(
      <WorldPanel
        snapshot={world}
        skewMs={0}
        selection={{ type: "building", id: farm.id }}
        recent={[]}
        follow={false}
        onToggleFollow={() => undefined}
        onPick={onPick}
      />,
    );
    expect(screen.getByText("Farm")).toBeTruthy();
    expect(screen.getByText("North Farm")).toBeTruthy();
    expect(screen.getByText(/north-farm · 4,8/)).toBeTruthy();
    expect(screen.getByText("Under construction · 36%")).toBeTruthy();
    expect(screen.getByText(/Each builder shift adds 4%/)).toBeTruthy();
    expect(screen.getByText(/1 of 4 shifts · 2 batches/)).toBeTruthy();
    expect(screen.getByText("Food")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(/Not token balances/)).toBeTruthy();
    expect(screen.getByText("Here now")).toBeTruthy();
    expect(screen.getByText("On the way")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(picks).toEqual([null]);
  });
});
