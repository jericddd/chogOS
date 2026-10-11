import "server-only";
import { createServiceRoleClient } from "@/lib/db/client";
import { readAppConfig } from "@/lib/config/env";
import type { CivilizationStore } from "@/lib/civilization/store";
import { SupabaseCivilizationStore } from "@/lib/civilization/supabase-store";

export function openCivilizationStore(): CivilizationStore | null {
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return null;
  }
  return new SupabaseCivilizationStore(createServiceRoleClient());
}
