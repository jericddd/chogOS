/**
 * Chog Genesis transfer watcher. Does not tick the world and does not broadcast.
 *
 *   CHOG_WATCHER_ENABLED=true npm run watcher:run
 *
 * Leave CHOG_WATCHER_ENABLED unset or false and the process exits without reading
 * the chain. CHOG_WATCHER_LOOP=true repeats until a scan fails. Cron should use
 * the default one-shot. Interval is CHOG_WATCHER_SECONDS (default 60).
 */
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";
import { getChain } from "../src/lib/blockchain/chains";
import { readAppConfig } from "../src/lib/config/env";
import { supabaseRpcSql } from "../src/lib/watcher/durable";
import { executeWatcher, startWatcher } from "../src/lib/watcher/run";
import { createTransferSource } from "../src/lib/watcher/source";

async function main(): Promise<void> {
  const config = readAppConfig();
  const result = await startWatcher({
    config,
    loop: process.env.CHOG_WATCHER_LOOP === "true",
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: () =>
      executeWatcher({
        config,
        open: async () => {
          if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.rpcUrl) {
            throw new Error("watcher database or RPC is not configured");
          }
          const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const chain = createPublicClient({
            chain: getChain(143),
            transport: http(config.rpcUrl),
          });
          return {
            sql: supabaseRpcSql({
              rpc: async (fn, args) => client.rpc(fn, args),
            }),
            source: createTransferSource(
              {
                getChainId: () => chain.getChainId(),
                getBlock: async (args) => {
                  const block =
                    args.blockNumber === undefined
                      ? await chain.getBlock({ blockTag: args.blockTag ?? "latest" })
                      : await chain.getBlock({ blockNumber: args.blockNumber });
                  if (block.number === null) {
                    throw new Error("block number is missing");
                  }
                  return { number: block.number, hash: block.hash, parentHash: block.parentHash };
                },
                getLogs: (args) =>
                  chain.getLogs({
                    address: args.address,
                    fromBlock: args.fromBlock,
                    toBlock: args.toBlock,
                  }),
              },
              config.chogNftAddress,
            ),
          };
        },
      }),
  });
  process.exit(result.exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
