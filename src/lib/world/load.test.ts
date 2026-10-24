import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treasuryReasonHash } from "@/lib/economy/treasury-policy";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string; message: string } | null };
let respond: (table: string) => Result = () => ({ data: [], error: null });
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

function builder(table: string): unknown {
  const target = {
    then(resolve: (value: Result) => unknown) {
      return Promise.resolve(respond(table)).then(resolve);
    },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then") {
        return obj.then;
      }
      return (...args: unknown[]) => {
        calls.push({ table, method: String(prop), args });
        if (prop === "maybeSingle") {
          return Promise.resolve(respond(`${table}:single`));
        }
        return builder(table);
      };
    },
  });
}

vi.mock("@/lib/db/client", () => ({
  createServiceRoleClient: () => ({ from: (table: string) => builder(table) }),
}));

const env = { ...process.env };

beforeEach(() => {
  calls.length = 0;
  process.env = { ...env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
});

afterEach(() => {
  process.env = env;
});

describe("world loader", () => {
  it("reports an unapplied migration instead of failing", async () => {
    respond = () => ({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.world_state' in the schema cache" } });
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("migration_pending");
  });

  it("reports an uninitialized world", async () => {
    respond = (table) => ({ data: table.endsWith(":single") ? null : [], error: null });
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("not_initialized");
  });

  it("reports missing configuration without touching the database", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { loadWorld } = await import("@/lib/world/load");
    expect((await loadWorld()).status).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("asks for one extra row to detect missed live events and pages strictly before a cursor", async () => {
    respond = () => ({ data: [], error: null });
    const { loadEventPage, LIVE_EVENT_LIMIT } = await import("@/lib/world/load");
    await loadEventPage({ tokenId: "7", category: "social" }, 120, 10);
    const history = calls.filter((c) => c.table === "civilization_events");
    expect(history).toContainEqual({ table: "civilization_events", method: "lt", args: ["seq", 120] });
    expect(history).toContainEqual({ table: "civilization_events", method: "limit", args: [11] });
    expect(history).toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "social"] });
    expect(history).toContainEqual({
      table: "civilization_events",
      method: "or",
      args: ["payload->>tokenId.eq.7,payload->>relatedTokenId.eq.7"],
    });
    expect(LIVE_EVENT_LIMIT).toBe(100);
  });

  it("queries source=ai when the category filter is the AI alias", async () => {
    respond = () => ({ data: [], error: null });
    const { loadEventPage } = await import("@/lib/world/load");
    await loadEventPage({ category: "ai" }, null, 10);
    const history = calls.filter((c) => c.table === "civilization_events");
    expect(history).toContainEqual({ table: "civilization_events", method: "eq", args: ["source", "ai"] });
    expect(history).not.toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "ai"] });
    calls.length = 0;
    await loadEventPage({ category: "construction", source: "ai" }, null, 1);
    const construction = calls.filter((c) => c.table === "civilization_events");
    expect(construction).toContainEqual({ table: "civilization_events", method: "eq", args: ["category", "construction"] });
    expect(construction).toContainEqual({ table: "civilization_events", method: "eq", args: ["source", "ai"] });
  });

  it("attaches the stored model reason to an AI event and leaves other rows untouched", async () => {
    const decisionId = "22222222-2222-4222-8222-222222222222";
    respond = (table) => {
      if (table === "civilization_events") {
        return {
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 9,
              kind: "construction.started",
              category: "construction",
              source: "ai",
              summary: "Farm construction started on a surveyed lot.",
              occurred_at: "2026-10-20T00:00:00.000Z",
              world_s: 10,
              tick_seq: 1,
              building_id: "farm-3",
              chain_status: "offchain",
              tx_hash: null,
              payload: {},
              decision_id: decisionId,
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              seq: 8,
              kind: "citizen.sleep",
              category: "citizen",
              source: "simulation",
              summary: "A citizen went to sleep.",
              occurred_at: "2026-10-20T00:00:00.000Z",
              world_s: 9,
              tick_seq: 1,
              building_id: "house-01",
              chain_status: "offchain",
              tx_hash: null,
              payload: {},
              decision_id: null,
            },
          ],
          error: null,
        };
      }
      if (table === "ai_decisions") {
        return {
          data: [
            {
              id: decisionId,
              rationale: "The open lots along the road are still empty, so the town should raise a farm.",
              output: { summary: "Raise a farm on open land." },
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    };
    const { loadEventPage } = await import("@/lib/world/load");
    const page = await loadEventPage({}, null, 10);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") {
      return;
    }
    expect(page.events[0]?.mind).toEqual({
      summary: "Raise a farm on open land.",
      rationale: "The open lots along the road are still empty, so the town should raise a farm.",
    });
    expect(page.events[1]?.mind).toBeUndefined();
    expect(calls).toContainEqual({ table: "ai_decisions", method: "in", args: ["id", [decisionId]] });
  });

  it("shows the verified payout sentence and keeps the policy sentence on the allocation row", async () => {
    const decisionId = "22222222-2222-4222-8222-222222222222";
    const tx = `0x${"ab".repeat(32)}`;
    const world = "Citizen aims to meet neighbours at the square and requires funds for social engagement.";
    const policy = "Production signing is disabled. This record is not a signature and not a payment.";
    respond = (table) => {
      if (table === "civilization_events") {
        return {
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 9,
              kind: "treasury.paid",
              category: "economy",
              source: "ai",
              summary: "The AI mind sent 0.01 MON to Chog #137.",
              occurred_at: "2026-10-24T11:54:57.000Z",
              world_s: 10,
              tick_seq: 1,
              building_id: null,
              chain_status: "confirmed",
              tx_hash: tx,
              chain_id: 143,
              payload: { tokenId: "137" },
              decision_id: decisionId,
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              seq: 8,
              kind: "treasury.allocation",
              category: "economy",
              source: "ai",
              summary: "The AI mind decided to send MON to Chog #137. No transaction was broadcast.",
              occurred_at: "2026-10-24T11:51:53.000Z",
              world_s: 9,
              tick_seq: 1,
              building_id: null,
              chain_status: "offchain",
              tx_hash: null,
              chain_id: null,
              payload: { tokenId: "137" },
              decision_id: decisionId,
            },
          ],
          error: null,
        };
      }
      if (table === "ai_decisions") {
        return {
          data: [
            {
              id: decisionId,
              rationale: policy,
              output: {
                summary: "Send fare for the square.",
                reason: world,
                verified: true,
                onchain: true,
                chainId: 143,
                txHash: tx,
                reasonHash: treasuryReasonHash(world),
              },
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    };
    const { loadEventPage } = await import("@/lib/world/load");
    const page = await loadEventPage({}, null, 10);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(page.events[0]?.kind).toBe("treasury.paid");
    expect(page.events[0]?.txHash).toBe(tx);
    expect(page.events[0]?.chainId).toBe(143);
    expect(page.events[0]?.mind).toEqual({ summary: null, rationale: world });
    expect(page.events[1]?.kind).toBe("treasury.allocation");
    expect(page.events[1]?.txHash).toBeNull();
    expect(page.events[1]?.mind?.rationale).toBe(policy);
  });

  it("does not invent a payout reason when the stored sentence does not match the receipt", async () => {
    const decisionId = "22222222-2222-4222-8222-222222222222";
    const tx = `0x${"cd".repeat(32)}`;
    respond = (table) => {
      if (table === "civilization_events") {
        return {
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 4,
              kind: "treasury.paid",
              category: "economy",
              source: "ai",
              summary: "The AI mind sent 0.01 MON to Chog #137.",
              occurred_at: "2026-10-24T11:54:57.000Z",
              world_s: 10,
              tick_seq: 1,
              building_id: null,
              chain_status: "confirmed",
              tx_hash: tx,
              chain_id: 143,
              payload: { tokenId: "137" },
              decision_id: decisionId,
            },
          ],
          error: null,
        };
      }
      if (table === "ai_decisions") {
        return {
          data: [
            {
              id: decisionId,
              rationale: "Production signing is disabled. This record is not a signature and not a payment.",
              output: {
                reason: "Citizen aims to meet neighbours at the square and requires funds for social engagement.",
                verified: true,
                onchain: true,
                chainId: 143,
                txHash: tx,
                reasonHash: `0x${"11".repeat(32)}`,
              },
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    };
    const { loadEventPage } = await import("@/lib/world/load");
    const page = await loadEventPage({}, null, 10);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(page.events[0]?.mind).toBeUndefined();
    expect(page.events[0]?.txHash).toBe(tx);
  });

  it("fills a join row from a nearby stored world second", async () => {
    let eventReads = 0;
    respond = (table) => {
      if (table === "world_state:single") {
        return {
          data: {
            speed: 60,
            max_lag_seconds: 150,
            anchor_real: "2026-10-20T14:00:42.000Z",
            anchor_world_s: 34_122_333,
          },
          error: null,
        };
      }
      if (table === "civilization_events") {
        eventReads += 1;
        if (eventReads === 1) {
          return {
            data: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                seq: 181228,
                kind: "genesis_joined",
                category: "membership",
                source: "system",
                summary: "Chog Genesis #996 verified in the ChogTreasury founding roster.",
                occurred_at: "2026-10-19T06:04:21.198Z",
                world_s: null,
                tick_seq: null,
                building_id: null,
                chain_status: "offchain",
                tx_hash: null,
                canonical: true,
                payload: { tokenId: "996" },
                decision_id: null,
              },
            ],
            error: null,
          };
        }
        return {
          data: [{ occurred_at: "2026-10-19T06:04:09.910Z", world_s: 28_475_760 }],
          error: null,
        };
      }
      return { data: [], error: null };
    };
    const { loadEventPage } = await import("@/lib/world/load");
    const page = await loadEventPage({ source: "system", category: "membership" }, null, 10);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") {
      return;
    }
    expect(page.events[0]?.worldS).toBe(28_476_437);
    expect(calls.filter((call) => call.table === "world_state" && call.method === "maybeSingle")).toHaveLength(1);
  });
});
