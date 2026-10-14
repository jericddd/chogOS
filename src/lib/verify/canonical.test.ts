import { describe, expect, it } from "vitest";
import {
  CANONICAL_FIELDS,
  canonicalEventDocument,
  canonicalJson,
  EVENT_INTEGRITY_SCHEMA,
  hashEvent,
  utcMsZ,
} from "@/lib/verify/canonical";
import { initialize, openWorldDb, rows, seedCitizens, START } from "@/lib/world/test-db";

const sample = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  seq: 12,
  kind: "work.shift_started",
  category: "work",
  source: "simulation",
  summary: "CHOG #7 began a shift at Workshop A.",
  occurredAt: "2026-10-13T01:02:03.040Z",
  createdAt: "2026-10-13T01:02:03.041Z",
  worldS: 3723,
  tickSeq: 9,
  actorCitizenId: "11111111-1111-4111-8111-111111111111",
  relatedCitizenId: null,
  buildingId: "workshop-a",
  chainStatus: "offchain",
  chainId: null,
  txHash: null,
  dedupeKey: "work:start:7:9",
  intentId: null,
  decisionId: null,
  payload: { tokenId: "7", buildingName: "Workshop A" },
  stateTransition: { after: { activity: "working", locationId: "workshop-a" } },
  prevEventHash: "0x" + "ab".repeat(32),
};

describe("canonical event encoding", () => {
  it("keeps field order, schema, and stable JSON", () => {
    expect(CANONICAL_FIELDS[0]).toBe("schema");
    const doc = canonicalEventDocument(sample);
    expect(doc.startsWith(`${EVENT_INTEGRITY_SCHEMA}\n`)).toBe(true);
    expect(doc.endsWith("\n")).toBe(true);
    expect(doc).toContain("payload:{\"buildingName\":\"Workshop A\",\"tokenId\":\"7\"}");
    expect(utcMsZ("2026-10-13T01:02:03.040478+00:00")).toBe("2026-10-13T01:02:03.040Z");
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    const a = hashEvent(sample);
    const b = hashEvent({ ...sample, payload: { buildingName: "Workshop A", tokenId: "7" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes the hash when content, time, source, or seq changes", () => {
    const base = hashEvent(sample);
    expect(hashEvent({ ...sample, summary: sample.summary + "." })).not.toBe(base);
    expect(hashEvent({ ...sample, occurredAt: "2026-10-13T01:02:03.041Z" })).not.toBe(base);
    expect(hashEvent({ ...sample, source: "system" })).not.toBe(base);
    expect(hashEvent({ ...sample, seq: 13 })).not.toBe(base);
    expect(hashEvent({ ...sample, prevEventHash: "0x" + "cd".repeat(32) })).not.toBe(base);
  });
});

describe("SQL and TypeScript hashes match", () => {
  it("seals a live insert and matches the TypeScript hash", async () => {
    const db = await openWorldDb({
      before: async (pre) => {
        await seedCitizens(pre, 3);
      },
    });
    await initialize(db, 60, START);
    await db.query("select verify_cutover()");
    await db.query(
      `insert into civilization_events (kind, category, source, summary, dedupe_key, payload, occurred_at)
       values ('probe.hash', 'world', 'system', 'Hash probe.', 'probe:hash:1', '{"n":1}'::jsonb, $1)`,
      [new Date("2026-10-13T02:00:00.000Z").toISOString()],
    );
    const inserted = await rows<{
      id: string;
      seq: number;
      kind: string;
      category: string;
      source: string;
      summary: string;
      occurred_at: string;
      created_at: string;
      world_s: number | null;
      tick_seq: number | null;
      actor_citizen_id: string | null;
      related_citizen_id: string | null;
      building_id: string | null;
      chain_status: string;
      chain_id: number | null;
      tx_hash: string | null;
      dedupe_key: string | null;
      intent_id: string | null;
      decision_id: string | null;
      payload: unknown;
      state_transition: unknown;
      event_hash: string;
      prev_event_hash: string | null;
      integrity_class: string;
    }>(db, "select * from civilization_events where dedupe_key = 'probe:hash:1'");
    const row = inserted[0]!;
    expect(row.integrity_class).toBe("live");
    expect(row.event_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const computed = hashEvent({
      id: row.id,
      seq: Number(row.seq),
      kind: row.kind,
      category: row.category,
      source: row.source,
      summary: row.summary,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      worldS: row.world_s,
      tickSeq: row.tick_seq,
      actorCitizenId: row.actor_citizen_id,
      relatedCitizenId: row.related_citizen_id,
      buildingId: row.building_id,
      chainStatus: row.chain_status,
      chainId: row.chain_id,
      txHash: row.tx_hash,
      dedupeKey: row.dedupe_key,
      intentId: row.intent_id,
      decisionId: row.decision_id,
      payload: row.payload,
      stateTransition: row.state_transition,
      prevEventHash: row.prev_event_hash,
    });
    expect(computed).toBe(row.event_hash);
    await db.close();
  }, 60_000);
});
