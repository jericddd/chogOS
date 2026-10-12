"use server";

import { revalidatePath } from "next/cache";
import { clearWorldCache } from "@/lib/civilization/load-world";
import { runGenesisSync } from "@/lib/civilization/run-sync";
import type { SyncResult } from "@/lib/civilization/sync-genesis";
import { readAppConfig } from "@/lib/config/env";
import { ensureCitizenWallets } from "@/lib/wallets/service";

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
  revalidatePath("/economy");
  return result;
}

export async function recordCitizenWallets(): Promise<
  { ok: true; created: number; unchanged: number } | { ok: false; error: string }
> {
  if (readAppConfig().syncSecret) {
    return {
      ok: false,
      error: "SYNC_SECRET is set. Use POST /api/sync/genesis with the server secret. That route also records wallet assignments.",
    };
  }

  const result = await ensureCitizenWallets();
  revalidatePath("/");
  revalidatePath("/treasury");
  revalidatePath("/citizens");
  revalidatePath("/economy");
  if (!result.ok) {
    return { ok: false, error: result.detail };
  }
  return { ok: true, created: result.value.created, unchanged: result.value.unchanged };
}
