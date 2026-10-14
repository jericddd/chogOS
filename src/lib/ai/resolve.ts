import type { AppConfig } from "@/lib/config/env";
import { AiProviderError, type AiCompletionRequest, type AiProvider } from "@/lib/ai/types";
import { createAnthropicProvider } from "@/lib/ai/providers/anthropic";
import { createGeminiProvider } from "@/lib/ai/providers/gemini";
import { createOpenAiProvider } from "@/lib/ai/providers/openai";

const unconfiguredProvider: AiProvider = {
  id: "none",
  complete(request: AiCompletionRequest): Promise<never> {
    return Promise.reject(
      new AiProviderError(
        `No AI provider is configured. Cannot complete "${request.purpose}". Set AI_PROVIDER before requesting a completion.`,
        "disabled",
        true,
      ),
    );
  },
};

/**
 * Ajax is a desired later provider. Its public site still describes it as
 * coming soon. This adapter refuses before any network call.
 */
const ajaxProvider: AiProvider = {
  id: "ajax",
  complete(request: AiCompletionRequest): Promise<never> {
    return Promise.reject(
      new AiProviderError(
        `Ajax is not available for "${request.purpose}". No verified Ajax endpoint or request format is configured, so no request was sent.`,
        "disabled",
        true,
      ),
    );
  },
};

export function createProviderFromConfig(config: AppConfig): AiProvider {
  switch (config.aiProvider) {
    case "none":
      return unconfiguredProvider;
    case "gemini":
      return createGeminiProvider(config);
    case "openai":
      return createOpenAiProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "ajax":
      return ajaxProvider;
  }
}
