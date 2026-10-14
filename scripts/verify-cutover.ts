/**
 * Records the verification cutover. Existing rows stay unhashed until
 * npm run verify:snapshot. New inserts continue on the live hash chain.
 *
 *   npm run verify:cutover
 */
import { explainRpcError, openOperatorClient } from "./world-client";

async function main(): Promise<void> {
  const { client } = openOperatorClient();
  const { data, error } = await client.rpc("verify_cutover");
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
