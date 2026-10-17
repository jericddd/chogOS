"use client";

import { useSyncExternalStore } from "react";
import { mergeEvents } from "@/lib/world/sync";
import type { RealtimeConfig, WorldEventView, WorldLive, WorldLoad, WorldSnapshot, WorldUnavailable } from "@/lib/world/types";

export type LinkState = "connecting" | "live" | "polling" | "reconnecting" | "offline";
export type RealtimeState = "off" | "connecting" | "subscribed" | "error";

export type LiveState = {
  snapshot: WorldSnapshot | null;
  unavailable: WorldUnavailable | null;
  link: LinkState;
  realtime: RealtimeState;
  /** Server clock minus browser clock, in milliseconds. */
  skewMs: number;
  receivedAt: number;
  /** Newest first. Every event this tab has seen since load, capped. */
  recent: WorldEventView[];
  /** Increments when the client missed events and every feed must reload. */
  resetToken: number;
};

const RECENT_CAP = 300;
const POLL_MS = 4_000;
const POLL_WITH_REALTIME_MS = 20_000;
const BACKOFF_MS = [4_000, 8_000, 16_000, 30_000];
/**
 * After a channel error the socket keeps reconnecting on its own, without further status callbacks.
 * If it has not resubscribed within the grace period it is closed, and a fresh one is tried after a cool-down.
 */
const REALTIME_GRACE_MS = 30_000;
const REALTIME_COOLDOWN_MS = [60_000, 120_000, 240_000, 300_000];

type Listener = () => void;

export type RealtimeHandlers = {
  isCurrent: () => boolean;
  onTick: () => void;
  onStatus: (status: string) => void;
};

/** Opens the broadcast channel and returns a function that closes it, or null if `isCurrent()` turned false first. */
export type RealtimeConnector = (config: RealtimeConfig, handlers: RealtimeHandlers) => Promise<(() => void) | null>;

type BrowserClient = ReturnType<typeof import("@supabase/supabase-js").createClient>;
let realtimeClient: { key: string; client: BrowserClient } | null = null;

const supabaseConnector: RealtimeConnector = async (config, handlers) => {
  const { createClient } = await import("@supabase/supabase-js");
  if (!handlers.isCurrent()) {
    return null;
  }
  const key = `${config.url}|${config.anonKey}`;
  if (realtimeClient?.key !== key) {
    realtimeClient = {
      key,
      client: createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: "chogos-world-realtime" },
      }),
    };
  }
  const { client } = realtimeClient;
  const channel = client
    .channel(config.channel)
    .on("broadcast", { event: "tick" }, handlers.onTick)
    .subscribe((status) => handlers.onStatus(status));
  return () => {
    void client.removeChannel(channel).finally(() => client.realtime.disconnect());
  };
};

export type LiveStore = {
  getState: () => LiveState;
  subscribe: (listener: Listener) => () => void;
  refresh: () => Promise<void>;
  /** Visible for tests. */
  apply: (live: WorldLive) => void;
};

type Options = {
  fetcher?: typeof fetch;
  now?: () => number;
  realtime?: RealtimeConfig | null;
  connectRealtime?: RealtimeConnector;
};

function initialState(initial: WorldLoad, now: number): LiveState {
  if (initial.status !== "ok") {
    return {
      snapshot: null,
      unavailable: initial,
      link: "connecting",
      realtime: "off",
      skewMs: 0,
      receivedAt: now,
      recent: [],
      resetToken: 0,
    };
  }
  return {
    snapshot: initial,
    unavailable: null,
    link: "connecting",
    realtime: "off",
    skewMs: Date.parse(initial.clock.serverNow) - now,
    receivedAt: now,
    recent: initial.events,
    resetToken: 0,
  };
}

export function createLiveStore(initial: WorldLoad, options: Options = {}): LiveStore {
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  let state = initialState(initial, now());
  const listeners = new Set<Listener>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let inFlight: Promise<void> | null = null;
  let stopRealtime: (() => void) | null = null;
  let nudge: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let connection = 0;
  let realtimeGiveUps = 0;
  let realtimeGrace: ReturnType<typeof setTimeout> | null = null;
  let realtimeRetry: ReturnType<typeof setTimeout> | null = null;
  const connectRealtime = options.connectRealtime ?? supabaseConnector;

  const set = (patch: Partial<LiveState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener();
    }
  };

  const apply = (live: WorldLive) => {
    const current = state.snapshot;
    if (current && live.clock.tickSeq < current.clock.tickSeq && live.clock.layoutHash === current.clock.layoutHash) {
      return;
    }
    const recent = live.gap ? live.events : mergeEvents(state.recent, live.events, RECENT_CAP);
    const latest = Math.max(live.latestSeq, recent[0]?.seq ?? 0, current?.latestSeq ?? 0);
    set({
      snapshot: {
        status: "ok",
        clock: live.clock,
        buildings: live.buildings,
        citizens: live.citizens,
        events: recent,
        latestSeq: latest,
        townNeeds: live.townNeeds ?? current?.townNeeds ?? [],
        townNeedsReady: live.townNeedsReady ?? current?.townNeedsReady ?? false,
        roads: live.roads ?? current?.roads ?? [],
        roadsReady: live.roadsReady ?? current?.roadsReady ?? false,
        townProjects: live.townProjects ?? current?.townProjects ?? [],
        townProjectsReady: live.townProjectsReady ?? current?.townProjectsReady ?? false,
      },
      unavailable: null,
      skewMs: Date.parse(live.clock.serverNow) - now(),
      receivedAt: now(),
      recent,
      resetToken: live.gap && current ? state.resetToken + 1 : state.resetToken,
    });
  };

  const interval = () => (state.realtime === "subscribed" ? POLL_WITH_REALTIME_MS : POLL_MS);

  const schedule = (delay: number) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    if (listeners.size === 0) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    timer = setTimeout(() => void refresh(), delay);
  };

  const run = async () => {
    const since = state.snapshot ? state.snapshot.latestSeq : null;
    const url = since === null ? "/api/world/live" : `/api/world/live?since=${since}`;
    try {
      const response = await fetcher(url, { cache: "no-store", headers: { accept: "application/json" } });
      const body = (await response.json()) as WorldLive | WorldUnavailable;
      if (body.status === "ok") {
        apply(body);
        failures = 0;
        set({ link: state.realtime === "subscribed" ? "live" : "polling" });
      } else if (body.status === "error") {
        throw new Error(body.detail);
      } else {
        failures = 0;
        set({ unavailable: body, link: "polling" });
      }
    } catch {
      failures += 1;
      set({ link: failures >= BACKOFF_MS.length ? "offline" : "reconnecting" });
    }
  };

  const refresh = () => {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null;
        schedule(failures > 0 ? BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]! : interval());
      });
    }
    return inFlight;
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void refresh();
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onOnline = () => void refresh();

  const clearRealtimeTimers = () => {
    if (realtimeGrace) {
      clearTimeout(realtimeGrace);
      realtimeGrace = null;
    }
    if (realtimeRetry) {
      clearTimeout(realtimeRetry);
      realtimeRetry = null;
    }
  };

  const closeRealtime = () => {
    connection += 1;
    stopRealtime?.();
    stopRealtime = null;
  };

  const startRealtime = async (config: RealtimeConfig, run: number) => {
    const id = ++connection;
    const isCurrent = () => run === generation && id === connection;
    set({ realtime: "connecting" });
    try {
      const close = await connectRealtime(config, {
        isCurrent,
        onTick: () => {
          if (!isCurrent() || nudge) {
            return;
          }
          nudge = setTimeout(() => {
            nudge = null;
            void refresh();
          }, 300);
        },
        onStatus: (status) => {
          if (!isCurrent()) {
            return;
          }
          if (status === "SUBSCRIBED") {
            realtimeGiveUps = 0;
            clearRealtimeTimers();
            set({ realtime: "subscribed", link: failures === 0 ? "live" : state.link });
            void refresh();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            set({ realtime: "error", link: failures === 0 ? "polling" : state.link });
            schedule(POLL_MS);
            if (realtimeGrace || realtimeRetry) {
              return;
            }
            realtimeGrace = setTimeout(() => {
              realtimeGrace = null;
              if (!isCurrent()) {
                return;
              }
              closeRealtime();
              const delay = REALTIME_COOLDOWN_MS[Math.min(realtimeGiveUps, REALTIME_COOLDOWN_MS.length - 1)]!;
              realtimeGiveUps += 1;
              realtimeRetry = setTimeout(() => {
                realtimeRetry = null;
                if (run === generation) {
                  void startRealtime(config, run);
                }
              }, delay);
            }, REALTIME_GRACE_MS);
          }
        },
      });
      if (!close) {
        return;
      }
      if (!isCurrent()) {
        close();
        return;
      }
      stopRealtime = close;
    } catch {
      if (isCurrent()) {
        set({ realtime: "error" });
      }
    }
  };

  const start = () => {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("online", onOnline);
    }
    generation += 1;
    if (options.realtime) {
      void startRealtime(options.realtime, generation);
    }
    void refresh();
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    }
    generation += 1;
    clearRealtimeTimers();
    realtimeGiveUps = 0;
    closeRealtime();
    if (state.realtime !== "off") {
      state = { ...state, realtime: "off" };
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        start();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
    refresh,
    apply,
  };
}

let shared: { store: LiveStore; key: string } | null = null;

/**
 * One store per tab, shared by the world view and the history feed.
 * A newer server render replaces an older store so navigation never goes back in time.
 */
export function sharedLiveStore(initial: WorldLoad, realtime: RealtimeConfig | null): LiveStore {
  const key = realtime ? `${realtime.url}|${realtime.channel}` : "poll";
  if (shared && shared.key === key) {
    const current = shared.store.getState().snapshot;
    if (initial.status === "ok" && (!current || initial.clock.tickSeq > current.clock.tickSeq)) {
      shared.store.apply({ ...initial, since: current?.latestSeq ?? 0, gap: !current });
    }
    return shared.store;
  }
  shared = { store: createLiveStore(initial, { realtime }), key };
  return shared.store;
}

export function useLive(store: LiveStore): LiveState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
