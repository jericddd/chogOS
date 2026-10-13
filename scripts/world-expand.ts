/**
 * Attaches genesis-v1.1 to an already-founded world: larger map, same town.
 * Does not move buildings, reset citizens, or rewrite history.
 *
 *   npm run world:expand
 */
import { initializationLayout } from "../src/lib/world/layout";
import { explainRpcError, openOperatorClient } from "./world-client";

async function main(): Promise<void> {
  const { client } = openOperatorClient();
  const layout = initializationLayout();
  const { data, error } = await client.rpc("world_expand_layout", { p_layout: layout });
  if (error) {
    console.error(explainRpcError(error));
    process.exit(1);
  }
  console.log(JSON.stringify({ layout: `${layout.version} ${layout.hash}`, result: data }, null, 2));
  const status = (data as { status?: string } | null)?.status;
  if (status === "layout_mismatch" || status === "building_mismatch" || status === "not_initialized") {
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
