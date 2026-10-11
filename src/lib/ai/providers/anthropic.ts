import type { AppConfig } from "@/lib/config/env";
import type { AiCompletion, AiCompletionRequest, AiProvider } from "@/lib/ai/types";

const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const ADAPTER_OUTPUT_LIMIT = 1024;

export function createAnthropicProvider(config: AppConfig): AiProvider {
  return {
    id: "anthropic",
    async complete(request: AiCompletionRequest): Promise<AiCompletion> {
      if (!config.aiApiKey || !config.aiModel) {
        throw new Error("Anthropic is selected, but AI_API_KEY and AI_MODEL must both be set.");
      }

      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages = request.messages
        .filter((message) => message.role === "user")
        .map((message) => ({ role: "user" as const, content: message.content }));

      if (messages.length === 0) {
        throw new Error("Anthropic completions require at least one user message.");
      }

      const response = await fetch(config.aiBaseUrl ?? DEFAULT_URL, {
        method: "POST",
        headers: {
          "x-api-key": config.aiApiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.aiModel,
          max_tokens: ADAPTER_OUTPUT_LIMIT,
          system: system || undefined,
          messages,
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic request failed with HTTP ${response.status}.`);
      }

      const body: unknown = await response.json();
      const text = readAnthropicText(body);
      if (!text) {
        throw new Error("Anthropic returned an empty completion.");
      }

      return { provider: "anthropic", model: config.aiModel, text };
    },
  };
}

function readAnthropicText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("content" in body) || !Array.isArray(body.content)) {
    return undefined;
  }

  const parts = body.content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("text" in part)) {
      return [];
    }
    return typeof part.text === "string" ? [part.text] : [];
  });

  const text = parts.join("");
  return text.length > 0 ? text : undefined;
}
