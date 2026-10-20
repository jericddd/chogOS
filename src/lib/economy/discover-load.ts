import "server-only";

import { connection } from "next/server";
import { readAppConfig } from "@/lib/config/env";
import { discoverChogActivity, type DiscoveredActivityPage } from "@/lib/economy/discover-activity";
import { jsonRpcCaller } from "@/lib/economy/verify-receipt";

/** Read-only discovery for the public page. It does not open a database client. */
export async function loadDiscoveredActivity(cursor: string | null, displayLimit?: number): Promise<DiscoveredActivityPage> {
  await connection();
  const config = readAppConfig();
  return discoverChogActivity({
    call: jsonRpcCaller(config.rpcUrl, 8_000),
    treasury: config.chogBankAssetAddress ?? null,
    cursor,
    nowMs: Date.now(),
    limits: displayLimit ? { maxDisplay: displayLimit } : undefined,
  });
}
