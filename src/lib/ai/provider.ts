import "server-only";
import { readAppConfig, type AppConfig } from "@/lib/config/env";
import type { AiCompletionRequest, AiProvider } from "@/lib/ai/types";
import { createAnthropicProvider } from "@/lib/ai/providers/anthropic";
import { createOpenAiProvider } from "@/lib/ai/providers/openai";

const unconfiguredProvider: AiProvider = {
  id: "none",
  complete(request: AiCompletionRequest): Promise<never> {
    throw new Error(
      `No AI provider is configured. Cannot complete "${request.purpose}". Set AI_PROVIDER before requesting a completion.`,
    );
  },
};

export function getAiProvider(config: AppConfig = readAppConfig()): AiProvider {
  switch (config.aiProvider) {
    case "none":
      return unconfiguredProvider;
    case "openai":
      return createOpenAiProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
  }
}
