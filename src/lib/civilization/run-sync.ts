import "server-only";
import { createGenesisReaderForConfig } from "@/lib/blockchain/genesis-reader";
import { loadIndexerCandidates } from "@/lib/civilization/indexer-fetch";
import { openCivilizationStore } from "@/lib/civilization/open-store";
import { synchronizeGenesis, type SyncResult } from "@/lib/civilization/sync-genesis";
import { readAppConfig } from "@/lib/config/env";
import { ensureCitizenWallets } from "@/lib/wallets/service";

const PERSISTENCE_HELP =
  "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then apply the SQL migrations in supabase/migrations. The treasury page can still show a live chain read, but founding citizen records are not persisted.";

export async function runGenesisSync(): Promise<SyncResult> {
  const config = readAppConfig();
  const store = openCivilizationStore();
  if (!store) {
    return { status: "failed", error: PERSISTENCE_HELP };
  }

  const indexer = await loadIndexerCandidates(config, config.chogTreasuryAddress, config.chogNftAddress);
  const result = await synchronizeGenesis({
    reader: createGenesisReaderForConfig(config),
    store,
    indexer,
    treasury: config.chogTreasuryAddress,
    nftContract: config.chogNftAddress,
    chainId: config.chainId,
    expectedCount: config.expectedFoundingCount,
  });
  if (result.status === "succeeded") {
    await ensureCitizenWallets();
  }
  return result;
}
