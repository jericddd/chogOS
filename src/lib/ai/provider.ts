import "server-only";
import { readAppConfig, type AppConfig } from "@/lib/config/env";
import { createProviderFromConfig } from "@/lib/ai/resolve";
import type { AiProvider } from "@/lib/ai/types";

export function getAiProvider(config: AppConfig = readAppConfig()): AiProvider {
  return createProviderFromConfig(config);
}
