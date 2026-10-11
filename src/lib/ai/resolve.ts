import type { AppConfig } from "@/lib/config/env";
import type { AiCompletionRequest, AiProvider } from "@/lib/ai/types";
import { createAnthropicProvider } from "@/lib/ai/providers/anthropic";
import { createOpenAiProvider } from "@/lib/ai/providers/openai";

const unconfiguredProvider: AiProvider = {
  id: "none",
  complete(request: AiCompletionRequest): Promise<never> {
    return Promise.reject(
      new Error(
        `No AI provider is configured. Cannot complete "${request.purpose}". Set AI_PROVIDER before requesting a completion.`,
      ),
    );
  },
};

/**
 * Ajax is the intended later provider. Phase 1 has no verified endpoint or
 * request format, so this adapter refuses before any network call.
 */
const ajaxProvider: AiProvider = {
  id: "ajax",
  complete(request: AiCompletionRequest): Promise<never> {
    return Promise.reject(
      new Error(
        `Ajax is not available for "${request.purpose}". No verified Ajax endpoint or request format is configured, so no request was sent.`,
      ),
    );
  },
};

export function createProviderFromConfig(config: AppConfig): AiProvider {
  switch (config.aiProvider) {
    case "none":
      return unconfiguredProvider;
    case "openai":
      return createOpenAiProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "ajax":
      return ajaxProvider;
  }
}
