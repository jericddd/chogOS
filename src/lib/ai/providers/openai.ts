import type { AppConfig } from "@/lib/config/env";
import type { AiCompletion, AiCompletionRequest, AiProvider } from "@/lib/ai/types";

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

export function createOpenAiProvider(config: AppConfig): AiProvider {
  return {
    id: "openai",
    async complete(request: AiCompletionRequest): Promise<AiCompletion> {
      if (!config.aiApiKey || !config.aiModel) {
        throw new Error("OpenAI is selected, but AI_API_KEY and AI_MODEL must both be set.");
      }

      const response = await fetch(config.aiBaseUrl ?? DEFAULT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.aiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages: request.messages,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with HTTP ${response.status}.`);
      }

      const body: unknown = await response.json();
      const text = readOpenAiText(body);
      if (!text) {
        throw new Error("OpenAI returned an empty completion.");
      }

      return { provider: "openai", model: config.aiModel, text };
    },
  };
}

function readOpenAiText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("choices" in body)) {
    return undefined;
  }

  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }

  const first = choices[0];
  if (!first || typeof first !== "object" || !("message" in first)) {
    return undefined;
  }

  const message = first.message;
  if (!message || typeof message !== "object" || !("content" in message)) {
    return undefined;
  }

  return typeof message.content === "string" ? message.content : undefined;
}
