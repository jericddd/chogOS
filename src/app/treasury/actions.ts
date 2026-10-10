"use server";

import { revalidatePath } from "next/cache";
import { clearWorldCache } from "@/lib/civilization/load-world";
import { runGenesisSync } from "@/lib/civilization/run-sync";
import type { SyncResult } from "@/lib/civilization/sync-genesis";
import { readAppConfig } from "@/lib/config/env";

export async function refreshGenesisRoster(): Promise<SyncResult> {
  if (readAppConfig().syncSecret) {
    return {
      status: "failed",
      error: "SYNC_SECRET is set. Use POST /api/sync/genesis with the server secret.",
    };
  }

  const result = await runGenesisSync();
  clearWorldCache();
  revalidatePath("/");
  revalidatePath("/treasury");
  revalidatePath("/citizens");
  revalidatePath("/activity");
  return result;
}
