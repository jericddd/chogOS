/**
 * Builds an OpenZeppelin standard Merkle batch of sealed event hashes.
 * Does not broadcast a transaction.
 *
 *   npm run verify:batch              # live unbatched events
 *   npm run verify:snapshot           # historical snapshot after cutover
 */
import { buildEventTree, proofForHash, TREE_FORMAT } from "../src/lib/verify/merkle";
import { explainRpcError, openOperatorClient } from "./world-client";

const snapshot = process.argv.includes("--snapshot") || process.env.npm_lifecycle_event === "verify:snapshot";

async function main(): Promise<void> {
  const { client } = openOperatorClient();
  if (snapshot) {
    for (;;) {
      const hashed = await client.rpc("verify_hash_historical");
      if (hashed.error) {
        console.error(explainRpcError(hashed.error));
        process.exit(1);
      }
      const row = (hashed.data ?? {}) as { status?: string; count?: number; remaining?: number };
      console.log("historical", JSON.stringify(row));
      if (row.status === "cutover_required") {
        process.exit(1);
      }
      if (!row.remaining || row.remaining <= 0 || !row.count) {
        break;
      }
    }
  }

  const kind = snapshot ? "historical" : "live";
  for (;;) {
    const { data, error } = await client
      .from("civilization_events")
      .select("id, seq, event_hash")
      .eq("integrity_class", kind)
      .is("merkle_batch_id", null)
      .not("event_hash", "is", null)
      .order("seq", { ascending: true })
      .limit(128);
    if (error) {
      console.error(error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as { id: string; seq: number; event_hash: string }[];
    if (rows.length === 0) {
      console.log(JSON.stringify({ status: "no_unbatched_events", kind }, null, 2));
      return;
    }
    const tree = buildEventTree(rows.map((row) => row.event_hash));
    const proofs = rows.map((row) => ({
      eventId: row.id,
      proof: proofForHash(tree, row.event_hash).proof,
    }));
    const payload = {
      kind: snapshot ? "historical_snapshot" : "live",
      fromSeq: Number(rows[0]!.seq),
      toSeq: Number(rows[rows.length - 1]!.seq),
      eventCount: rows.length,
      root: tree.root,
      treeFormat: TREE_FORMAT,
      dump: {},
      proofs,
    };
    let committed = await client.rpc("verify_commit_batch", { p_batch: payload });
    if (committed.error && /statement timeout|57014/i.test(committed.error.message)) {
      console.error("timeout, retrying once", explainRpcError(committed.error));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      committed = await client.rpc("verify_commit_batch", { p_batch: payload });
    }
    if (committed.error) {
      console.error(explainRpcError(committed.error));
      process.exit(1);
    }
    const result = committed.data as { status?: string } | null;
    if (result?.status === "duplicate_root" || result?.status === "duplicate_range") {
      console.log(JSON.stringify({ result, skipped: true, count: rows.length }, null, 2));
      continue;
    }
    console.log(JSON.stringify({ result: committed.data, root: tree.root, count: rows.length }, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
