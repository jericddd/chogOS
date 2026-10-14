/**
 * Records an already-confirmed EventAnchor transaction. Does not send one.
 *
 * Broadcasting a submitBatch transaction stays disabled unless
 * VERIFY_BROADCAST=yes AND EVENT_ANCHOR_ADDRESS is set. This script still
 * refuses to create a wallet client or send a transaction.
 *
 *   npm run verify:anchor
 */
import { explainRpcError, openOperatorClient } from "./world-client";

async function main(): Promise<void> {
  if (process.env.VERIFY_BROADCAST === "yes") {
    console.error(
      "Transaction broadcast is not implemented in this script. Deploy and submitBatch with a reviewed Foundry workflow, then record the receipt here.",
    );
    process.exit(2);
  }
  const batchId = process.env.VERIFY_BATCH_ID;
  const status = process.env.VERIFY_ANCHOR_STATUS;
  const chainId = process.env.EVENT_ANCHOR_CHAIN_ID;
  const contract = process.env.EVENT_ANCHOR_ADDRESS;
  const tx = process.env.VERIFY_ANCHOR_TX;
  const block = process.env.VERIFY_ANCHOR_BLOCK;
  if (!batchId || !status) {
    console.error("Set VERIFY_BATCH_ID and VERIFY_ANCHOR_STATUS (unanchored|submitted|confirmed|failed).");
    console.error("Optional: EVENT_ANCHOR_CHAIN_ID, EVENT_ANCHOR_ADDRESS, VERIFY_ANCHOR_TX, VERIFY_ANCHOR_BLOCK.");
    process.exit(1);
  }
  const { client } = openOperatorClient();
  const { data, error } = await client.rpc("verify_record_anchor", {
    p_batch: batchId,
    p_status: status,
    p_chain_id: chainId ? Number(chainId) : null,
    p_contract: contract ?? null,
    p_tx: tx ?? null,
    p_block: block ? Number(block) : null,
  });
  if (error) {
    console.error(explainRpcError(error));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
