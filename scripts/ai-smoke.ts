/**
 * One real Gemini generateContent call. Does not submit intents or change the world.
 *
 * Exit 0: a genuine response was received.
 * Exit 2: credentials are missing (not a fake success).
 * Exit 1: the request failed.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { reserveModelAttempt } from "../src/lib/ai/model-quota";
import { createGeminiProvider } from "../src/lib/ai/providers/gemini";
import { DECISION_RESPONSE_SCHEMA } from "../src/lib/ai/schema";
import { readAppConfig } from "../src/lib/config/env";

async function main(): Promise<void> {
  const env = { ...process.env };
  if (!env.AI_API_KEY && env.GEMINI_API_KEY) {
    env.AI_API_KEY = env.GEMINI_API_KEY;
  }
  if (!env.AI_PROVIDER) {
    env.AI_PROVIDER = "gemini";
  }
  const config = readAppConfig(env as NodeJS.ProcessEnv);
  if (!config.aiApiKey) {
    console.log("SKIP: AI_API_KEY is not set. No request was sent.");
    process.exit(2);
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    console.log("SKIP: Supabase service role is not set. No request was sent.");
    process.exit(2);
  }
  const provider = createGeminiProvider({ ...config, aiProvider: "gemini", aiModel: config.aiModel ?? "gemini-3.5-flash-lite" });
  const ledger = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const completion = await provider.complete({
    purpose: "smoke",
    reserveAttempt: (model) => reserveModelAttempt(ledger, model),
    messages: [
      {
        role: "system",
        content: "Return JSON only. This is a connectivity check for chogOS. Do not mention secrets.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Choose socialize at commons-square.",
          feasible: [{ action: "socialize", buildingId: "commons-square" }],
        }),
      },
    ],
    responseSchema: DECISION_RESPONSE_SCHEMA,
    timeoutMs: 30_000,
    maxOutputTokens: 256,
  });
  const digest = createHash("sha256").update(completion.text).digest("hex").slice(0, 16);
  console.log(
    JSON.stringify({
      ok: true,
      live: true,
      provider: completion.provider,
      model: completion.model,
      outputChars: completion.text.length,
      outputSha256_16: digest,
      preview: completion.text.slice(0, 180),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
