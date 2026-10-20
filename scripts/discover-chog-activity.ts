import { addresses } from "../src/lib/blockchain/addresses";
import { discoverChogActivity, resetDiscoveredActivityState } from "../src/lib/economy/discover-activity";
import { jsonRpcCaller } from "../src/lib/economy/verify-receipt";
import { publicRpcError } from "../src/lib/verify/anchor";

/**
 * Bounded read-only check against Monad mainnet.
 * Prints a summary only. It does not print the RPC URL, sign, or write.
 *
 *   npx tsx scripts/discover-chog-activity.ts
 *
 * Uses MONAD_RPC_URL when it is an https URL. Otherwise uses the recorded public endpoint.
 */
const envUrl = process.env.MONAD_RPC_URL?.trim();
const envHttps = Boolean(envUrl && /^https:\/\//i.test(envUrl));
const rpcUrl = envHttps ? envUrl! : "https://rpc.monad.xyz";

const limits = {
  maxBlocks: 100n,
  chunkBlocks: 100n,
  minChunkBlocks: 10n,
  maxCandidates: 4,
  maxVerified: 1,
  maxRpcCalls: 16,
  maxDisplay: 1,
} as const;

async function main(): Promise<number> {
  resetDiscoveredActivityState();
  const call = jsonRpcCaller(rpcUrl, 8_000);
  const windows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let verified: Record<string, unknown> | null = null;
  for (let page = 0; page < 8; page += 1) {
    const result = await discoverChogActivity({ call, treasury: null, cursor, limits });
    windows.push({
      state: result.state,
      scannedFrom: result.scannedFrom,
      scannedTo: result.scannedTo,
      tip: result.tip,
      logsReturned: result.logsReturned,
      items: result.items.length,
      rpcCalls: result.rpcCalls,
      detail: result.detail,
    });
    const item = result.items[0];
    if (item && item.status === "verified") {
      verified = {
        fresh: item.fresh,
        cached: item.cached,
        evidence: item.evidence,
        txHash: item.txHash,
        blockNumber: item.blockNumber,
        blockHash: item.blockHash,
        logIndex: item.logIndex,
        amountRaw: item.amountRaw,
        token: item.token,
      };
      break;
    }
    if (!result.nextCursor || result.state === "unavailable" || result.state === "unsupported" || result.state === "invalid_cursor") {
      break;
    }
    cursor = result.nextCursor;
  }
  console.log(
    JSON.stringify(
      {
        source: envHttps ? "MONAD_RPC_URL" : "recorded-public-mainnet",
        token: addresses.chogToken,
        chainId: 143,
        windows,
        verifiedTransfer: Boolean(verified && verified.fresh === true),
        verified,
      },
      null,
      2,
    ),
  );
  return verified && verified.fresh === true ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.log(JSON.stringify({ source: envHttps ? "MONAD_RPC_URL" : "recorded-public-mainnet", error: publicRpcError(error, "The read-only RPC failed.") }));
    process.exitCode = 1;
  });
