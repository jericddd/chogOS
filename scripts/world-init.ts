/**
 * Founds the shared world once, then attaches the current layout if the
 * stored town is an older compatible version (genesis-v1 → genesis-v1.1).
 * Does not move buildings or reset citizens.
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
  const initialized = data as { status?: string } | null;
  let expanded: unknown = null;
  if (initialized?.status === "layout_mismatch" || initialized?.status === "already_initialized" || initialized?.status === "initialized") {
    const expand = await client.rpc("world_expand_layout", { p_layout: layout });
    if (expand.error) {
      console.error(explainRpcError(expand.error));
      process.exit(1);
    }
    expanded = expand.data;
  }
  console.log(JSON.stringify({ layout: `${layout.version} ${layout.hash}`, requestedSpeed: describeSpeed(speed), initialize: data, expand: expanded }, null, 2));
  const expandStatus = (expanded as { status?: string } | null)?.status;
  if (initialized?.status === "layout_mismatch" && expandStatus !== "expanded" && expandStatus !== "already_expanded") {
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
