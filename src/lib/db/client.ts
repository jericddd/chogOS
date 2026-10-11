import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { readAppConfig } from "@/lib/config/env";

function requireSupabaseUrl(): { url: string; anonKey?: string; serviceRoleKey?: string } {
  const config = readAppConfig();
  if (!config.supabaseUrl) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL.");
  }

  return {
    url: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    serviceRoleKey: config.supabaseServiceRoleKey,
  };
}

/**
 * Server-only client for trusted jobs. The service role bypasses row level
 * security, so browser code must never import this function.
 */
export function createServiceRoleClient(): SupabaseClient {
  const { url, serviceRoleKey } = requireSupabaseUrl();
  if (!serviceRoleKey) {
    throw new Error("Supabase service role is not configured. Set SUPABASE_SERVICE_ROLE_KEY.");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Cookie-backed anon client for a later authenticated enrollment flow.
 * Phase 0 pages do not call it. The anon role has no table grants.
 */
export async function createAnonServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = requireSupabaseUrl();
  if (!anonKey) {
    throw new Error("Supabase anon key is not configured. Set SUPABASE_ANON_KEY.");
  }

  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot always write cookies. A later proxy can.
        }
      },
    },
  });
}
