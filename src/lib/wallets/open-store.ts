import "server-only";
import { createServiceRoleClient } from "@/lib/db/client";
import { readAppConfig } from "@/lib/config/env";
import type { WalletRegistryStore } from "@/lib/wallets/store";
import { SupabaseWalletStore } from "@/lib/wallets/supabase-store";

export function openWalletStore(): WalletRegistryStore | null {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return null;
  }
  return new SupabaseWalletStore(createServiceRoleClient());
}
