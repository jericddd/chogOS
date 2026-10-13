/**
 * Founds the shared world once: inserts the genesis-v1 buildings and road
 * distances, gives every eligible existing citizen a home and a job, and
 * starts the clock. Safe to run again; a second run changes nothing.
 *
 *   npm run world:init
 *   WORLD_SPEED=calm npm run world:init
 */
import { initializationLayout } from "../src/lib/world/layout";
import { describeSpeed, parseWorldSpeed } from "../src/lib/world/speed";
import { explainRpcError, openOperatorClient } from "./world-client";

async function main(): Promise<void> {
  const { client, config } = openOperatorClient();
  const speed = parseWorldSpeed(process.env.WORLD_SPEED);
  const layout = initializationLayout();
  const { data, error } = await client.rpc("world_initialize", {
    p_layout: layout,
    p_chain_id: config.chainId,
    p_nft_contract: config.chogNftAddress,
    p_speed: speed,
  });
  if (error) {
    console.error(explainRpcError(error));
    process.exit(1);
  }
  console.log(JSON.stringify({ layout: `${layout.version} ${layout.hash}`, requestedSpeed: describeSpeed(speed), result: data }, null, 2));
  if ((data as { status?: string } | null)?.status === "layout_mismatch") {
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
