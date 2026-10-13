import { existsSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readAppConfig, type AppConfig } from "../src/lib/config/env";

/** Service-role client for trusted operator scripts. Never ship this to a browser. */
export function openOperatorClient(): { client: SupabaseClient; config: AppConfig } {
  if (existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
  const config = readAppConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local.");
    process.exit(1);
  }
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, config };
}

export function explainRpcError(error: { code?: string; message: string }): string {
  if (error.code === "PGRST202" || /could not find the function/i.test(error.message)) {
    return "The world functions are missing. Apply supabase/migrations/20261013040000_phase3_world.sql first.";
  }
  return error.message;
}
