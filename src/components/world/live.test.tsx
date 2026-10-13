// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "@/components/world/activity-feed";
import { createLiveStore, type RealtimeConnector, type RealtimeHandlers } from "@/components/world/live-store";
import type { ClockView, WorldEventView, WorldLive, WorldSnapshot } from "@/lib/world/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
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
  return { status: "ok", clock, buildings: [], citizens: [], events, latestSeq: events[0]?.seq ?? 0 };
}

function live(events: WorldEventView[], patch: Partial<WorldLive> = {}): WorldLive {
  return { ...snapshot(events), clock: { ...clock, tickSeq: 6 }, since: 0, gap: false, ...patch };
}

type Observed = { callback: IntersectionObserverCallback; element: Element };
let observers: Observed[] = [];

beforeEach(() => {
  observers = [];
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

describe("activity feed", () => {
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
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "ai" } });
    await screen.findByText(/The AI mind is not running/);
    expect(String(fetcher.mock.calls[0]![0])).toContain("source=ai");
  });
});
