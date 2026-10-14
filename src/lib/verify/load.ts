import "server-only";
import { getAddress } from "viem";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { getChain, type SupportedChainId } from "@/lib/blockchain/chains";
import { type CanonicalEventInput } from "@/lib/verify/canonical";
import { TREE_FORMAT } from "@/lib/verify/merkle";
import type { AnchorRecord } from "@/lib/verify/chain";
import type { VerifyBundle } from "@/lib/verify/types";

export type { VerifyBundle };

export type VerifyEventRow = {
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
  integrity_schema: string | null;
  integrity_class: "historical" | "live" | null;
  event_hash: string | null;
  prev_event_hash: string | null;
  merkle_batch_id: string | null;
};

const EVENT_SELECT =
  "id, seq, kind, category, source, summary, occurred_at, created_at, world_s, tick_seq, actor_citizen_id, related_citizen_id, building_id, chain_status, chain_id, tx_hash, dedupe_key, intent_id, decision_id, payload, state_transition, integrity_schema, integrity_class, event_hash, prev_event_hash, merkle_batch_id";

function toCanonical(row: VerifyEventRow): CanonicalEventInput {
  return {
    id: row.id,
    seq: row.seq,
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
    payload: row.payload ?? {},
    stateTransition: row.state_transition ?? {},
    prevEventHash: row.prev_event_hash,
  };
}

function neighbor(row: {
  seq: number | string;
  event_hash: string | null;
  prev_event_hash: string | null;
} | null): { seq: number; hash: string; prevEventHash: string | null } | null {
  if (!row?.event_hash) {
    return null;
  }
  return { seq: Number(row.seq), hash: row.event_hash, prevEventHash: row.prev_event_hash };
}

export async function loadVerifyBundle(id: string): Promise<VerifyBundle | { status: "missing" } | { status: "unconfigured"; detail: string }> {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return { status: "unconfigured", detail: "Supabase is not configured on this server." };
  }
  const client = createServiceRoleClient();
  const { data, error } = await client.from("civilization_events").select(EVENT_SELECT).eq("id", id).maybeSingle();
  if (error) {
    if (
      error.code === "42703" ||
      /column .* does not exist|event_hash|integrity_class|schema cache/i.test(error.message)
    ) {
      return {
        status: "unconfigured",
        detail: "The Phase 3.75 verification migration has not been applied to this database yet.",
      };
    }
    return { status: "unconfigured", detail: error.message };
  }
  if (!data) {
    return { status: "missing" };
  }
  const row = data as unknown as VerifyEventRow;
  const notes: string[] = [
    "This export is data. Recompute the hash and Merkle proof locally. A matching hash is not proof that the simulation was truthful.",
    "A privileged database operator can still rewrite history and recompute hashes. An onchain root only detects that after the root was published.",
  ];

  let previous = null;
  let next = null;
  if (row.integrity_class === "live") {
    const before = await client
      .from("civilization_events")
      .select("seq, event_hash, prev_event_hash")
      .eq("integrity_class", "live")
      .lt("seq", row.seq)
      .not("event_hash", "is", null)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    const after = await client
      .from("civilization_events")
      .select("seq, event_hash, prev_event_hash")
      .eq("integrity_class", "live")
      .gt("seq", row.seq)
      .not("event_hash", "is", null)
      .order("seq", { ascending: true })
      .limit(1)
      .maybeSingle();
    previous = neighbor(before.data as { seq: number; event_hash: string | null; prev_event_hash: string | null } | null);
    next = neighbor(after.data as { seq: number; event_hash: string | null; prev_event_hash: string | null } | null);
  }

  let proof: VerifyBundle["proof"] = null;
  let batch: VerifyBundle["batch"] = null;
  let anchor: AnchorRecord = null;
  let explorerTxUrl: string | null = null;
  let explorerContractUrl: string | null = null;
  if (row.merkle_batch_id) {
    const stored = await client.from("event_integrity_proofs").select("proof, batch_id").eq("event_id", row.id).maybeSingle();
    const meta = await client.from("event_integrity_batches").select("*").eq("id", row.merkle_batch_id).maybeSingle();
    if (meta.data) {
      const b = meta.data as {
        id: string;
        kind: string;
        tree_format: string;
        from_seq: number;
        to_seq: number;
        event_count: number;
        merkle_root: string;
        snapshot_committed_at: string | null;
        anchor_status: string;
        anchor_chain_id: number | null;
        anchor_contract: string | null;
        anchor_tx_hash: string | null;
        anchor_block_number: number | null;
      };
      batch = {
        id: b.id,
        kind: b.kind,
        treeFormat: b.tree_format,
        fromSeq: Number(b.from_seq),
        toSeq: Number(b.to_seq),
        eventCount: Number(b.event_count),
        merkleRoot: b.merkle_root,
        snapshotCommittedAt: b.snapshot_committed_at,
        anchorStatus: b.anchor_status,
      };
      if (b.kind === "historical_snapshot") {
        notes.push(
          "This event is in a historical snapshot. The snapshot was hashed at the batch creation time, not at the original occurredAt displayed on the event.",
        );
      }
      if (stored.data?.proof && b.merkle_root) {
        const raw = stored.data.proof;
        const list = Array.isArray(raw) ? raw.map(String) : [];
        proof = { format: b.tree_format || TREE_FORMAT, root: b.merkle_root, proof: list };
      }
      if (b.anchor_status === "confirmed" && b.anchor_chain_id && b.anchor_contract && b.anchor_tx_hash && b.anchor_block_number !== null) {
        try {
          const chainId = (b.anchor_chain_id === 143 ? 143 : 10143) as SupportedChainId;
          const chain = getChain(chainId);
          const explorer = chain.blockExplorers?.default.url;
          anchor = {
            chainId: b.anchor_chain_id,
            contract: getAddress(b.anchor_contract),
            txHash: b.anchor_tx_hash.toLowerCase(),
            blockNumber: String(b.anchor_block_number),
            root: b.merkle_root,
            batchId: b.id,
          };
          if (explorer) {
            explorerTxUrl = `${explorer}/tx/${anchor.txHash}`;
            explorerContractUrl = `${explorer}/address/${anchor.contract}`;
            notes.push(`Explorer: ${explorerTxUrl}`);
          }
        } catch {
          notes.push("The recorded anchor address is not a valid checksum address.");
        }
      } else if (b.anchor_status === "submitted") {
        notes.push("An anchor transaction is recorded as submitted, not confirmed. Missing or reverted receipts are not onchain verification.");
      } else {
        notes.push("No confirmed onchain anchor. The UI must not show onchain_anchor_verified.");
      }
    }
  }

  return {
    schema: "chogos-verify-export-v1",
    event: toCanonical(row),
    storedHash: row.event_hash,
    integrityClass: row.integrity_class,
    previous,
    next,
    proof,
    batch,
    anchor,
    explorerTxUrl,
    explorerContractUrl,
    notes,
  };
}
