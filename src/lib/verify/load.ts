import "server-only";
import { readAppConfig } from "@/lib/config/env";
import { createServiceRoleClient } from "@/lib/db/client";
import { explorerAddressUrl, explorerBlockUrl, explorerTxUrl } from "@/lib/blockchain/explorer";
import { hashEvent, type CanonicalEventInput } from "@/lib/verify/canonical";
import { LEAF_ENCODING, TREE_FORMAT } from "@/lib/verify/merkle";
import { planAnchorRead, readAnchorObservation } from "@/lib/verify/anchor";
import { readTransferLog, unreadTransferLog } from "@/lib/verify/transfer-log";
import { artifactsWithCode } from "@/lib/verify/artifacts";
import type { AnchorRecord } from "@/lib/verify/chain";
import { REVIEWER_CHECKS, buildPublicProvenance } from "@/lib/verify/provenance";
import type { VerifyBundle } from "@/lib/verify/types";
import { onchainEvidenceFromRow } from "@/lib/world/onchain-links";
import { presentedAsMainnetGenesis, transferEvidenceFromRow } from "@/lib/world/transfer";

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
  canonical?: boolean | null;
};

const EVENT_SELECT =
  "id, seq, kind, category, source, summary, occurred_at, created_at, world_s, tick_seq, actor_citizen_id, related_citizen_id, building_id, chain_status, chain_id, tx_hash, dedupe_key, intent_id, decision_id, payload, state_transition, integrity_schema, integrity_class, event_hash, prev_event_hash, merkle_batch_id, canonical";

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

function textMind(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 400) : null;
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
        detail: "The verification columns are missing. Apply the Phase 3.75 verification migration and the permanent-citizenship migration before using this page.",
      };
    }
    return { status: "unconfigured", detail: error.message };
  }
  if (!data) {
    return { status: "missing" };
  }
  const row = data as unknown as VerifyEventRow;
  const event = toCanonical(row);
  let serverRecomputedHash: string | null = null;
  try {
    serverRecomputedHash = hashEvent(event);
  } catch {
    serverRecomputedHash = null;
  }
  const notes: string[] = [
    "This export is data. Recompute the hash and Merkle proof locally. A matching hash is not proof that the simulation was truthful.",
    "A privileged database operator can still rewrite history and recompute hashes. An onchain root only detects that after the root was published.",
    "serverRecomputedHash is a convenience. Compare your own SHA-256 of the canonical document with storedHash.",
    "Do not send this export to a third-party hashing site.",
    "The database batch id is a UUID. The onchain batch id is the bytes32 in BatchAnchored. This export does not treat the UUID as that bytes32.",
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
  let anchorObservation: VerifyBundle["anchorObservation"] = null;
  let anchorRead: VerifyBundle["anchorRead"] = { attempted: false, reason: "This event has no Merkle batch." };
  let anchorIssue: string | null = null;
  let explorerTransaction: string | null = null;
  let explorerContract: string | null = null;
  let explorerBlock: string | null = null;

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
        proof = { format: b.tree_format || TREE_FORMAT, leafEncoding: [...LEAF_ENCODING], root: b.merkle_root, proof: list };
      }
      const plan = planAnchorRead({
        rpcConfigured: Boolean(config.rpcUrl),
        anchorStatus: b.anchor_status,
        chainId: b.anchor_chain_id,
        contract: b.anchor_contract,
        txHash: b.anchor_tx_hash,
        root: b.merkle_root,
        blockNumber: b.anchor_block_number,
      });
      anchorRead = { attempted: false, reason: plan.reason };
      if (plan.action === "invalid") {
        anchorIssue = plan.reason;
        notes.push(plan.reason);
      } else if (plan.action === "ready") {
        anchor = {
          chainId: plan.chainId,
          contract: plan.contract,
          txHash: plan.txHash,
          blockNumber: plan.blockNumber,
          root: plan.root,
          batchId: b.id,
        };
        explorerTransaction = explorerTxUrl(plan.chainId, plan.txHash);
        explorerContract = explorerAddressUrl(plan.chainId, plan.contract);
        explorerBlock = explorerBlockUrl(plan.chainId, plan.blockNumber);
        notes.push("Explorer links open the recorded anchor objects. Opening a link does not verify the root.");
        if (plan.rpcConfigured && config.rpcUrl) {
          anchorRead = { attempted: true, reason: plan.reason };
          anchorObservation = await readAnchorObservation({
            rpcUrl: config.rpcUrl,
            chainId: plan.chainId,
            contract: plan.contract,
            txHash: plan.txHash,
            expectedRoot: plan.root,
          });
          notes.push("anchorObservation is a read-only eth_call from this server. Repeat getBatch before trusting it.");
        } else {
          notes.push("No read-only RPC is configured. The page cannot mark this batch onchain_anchor_verified.");
        }
      } else {
        notes.push(plan.reason);
      }
    }
  }

  const onchain = onchainEvidenceFromRow({
    kind: row.kind,
    chain_status: row.chain_status,
    chain_id: row.chain_id,
    tx_hash: row.tx_hash,
    payload: row.payload,
  });
  let mind: VerifyBundle["mind"] = null;
  if (row.decision_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.decision_id)) {
    const decision = await client.from("ai_decisions").select("rationale, output").eq("id", row.decision_id).maybeSingle();
    const stored = decision.data as { rationale?: unknown; output?: unknown } | null;
    if (stored) {
      const output =
        stored.output && typeof stored.output === "object" && !Array.isArray(stored.output)
          ? (stored.output as Record<string, unknown>)
          : null;
      const rationale =
        textMind(stored.rationale) ?? textMind(output?.rationale) ?? textMind(output?.reason);
      const summary = textMind(output?.summary);
      if (rationale || summary) mind = { rationale, summary };
    }
  }

  const transfer = transferEvidenceFromRow({
    kind: row.kind,
    chain_status: row.chain_status,
    chain_id: row.chain_id,
    tx_hash: row.tx_hash,
    canonical: row.canonical,
    payload: row.payload,
  });
  let transferLog = transfer ? unreadTransferLog() : null;
  if (transfer && presentedAsMainnetGenesis(transfer)) {
    if (config.rpcUrl) {
      transferLog = await readTransferLog({ rpcUrl: config.rpcUrl, evidence: transfer });
      notes.push(transferLog.summary);
    } else {
      notes.push("No read-only RPC is configured. This page did not read the transfer.");
    }
  } else if (transfer) {
    notes.push(...transfer.issues);
    notes.push("Explorer links are withheld. This is not presented as Chog Genesis mainnet activity.");
  }

  return {
    schema: "chogos-verify-export-v2",
    event,
    storedHash: row.event_hash,
    serverRecomputedHash,
    integrityClass: row.integrity_class,
    previous,
    next,
    proof,
    batch,
    anchor,
    anchorObservation,
    anchorRead,
    anchorIssue,
    explorerTxUrl: explorerTransaction,
    explorerContractUrl: explorerContract,
    explorerBlockUrl: explorerBlock,
    transfer,
    transferLog,
    onchain,
    mind,
    provenance: buildPublicProvenance(),
    artifacts: await artifactsWithCode(config.rpcUrl, 143),
    eventPath: `/verify/events/${row.id}`,
    reviewerChecks: [...REVIEWER_CHECKS],
    notes,
  };
}
