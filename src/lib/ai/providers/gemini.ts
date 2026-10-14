import type { AppConfig } from "@/lib/config/env";
import { AiProviderError, type AiCompletion, type AiCompletionRequest, type AiProvider } from "@/lib/ai/types";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com/v1beta";

export function geminiEndpoint(model: string, baseUrl?: string): string {
  if (baseUrl) {
    return baseUrl;
  }
  return `${DEFAULT_HOST}/models/${encodeURIComponent(model)}:generateContent`;
}

function classifyGeminiFailure(status: number, bodyText: string): AiProviderError {
  const lower = bodyText.toLowerCase();
  const billing =
    /billing|payment|enable billing|upgrade to (a )?paid|paid tier|credit card/.test(lower);
  if (billing) {
    return new AiProviderError(
      "Gemini refused the request for a billing-related reason. chogOS will not enable paid inference.",
      "billing",
      true,
    );
  }
  if (status === 429 || /resource_exhausted|quota|rate.?limit/.test(lower)) {
    const quota = /quota|daily|per day|rpd/.test(lower);
    return new AiProviderError(
      quota
        ? "Gemini free-tier quota is exhausted. New inference is halted."
        : "Gemini rate-limited the request. New inference is deferred.",
      quota ? "quota" : "rate_limit",
      true,
    );
  }
  if (status === 404 || /not found|is not found|unknown model/.test(lower)) {
    return new AiProviderError("The configured Gemini model is not available to this account.", "unavailable", true);
  }
  if (status >= 500) {
    return new AiProviderError(`Gemini returned HTTP ${status}.`, "unavailable", false);
  }
  return new AiProviderError(`Gemini request failed with HTTP ${status}.`, "unavailable", false);
}

function readGeminiText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("candidates" in body)) {
    return undefined;
  }
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }
  const first = candidates[0];
  if (!first || typeof first !== "object" || !("content" in first)) {
    return undefined;
  }
  const content = first.content;
  if (!content || typeof content !== "object" || !("parts" in content) || !Array.isArray(content.parts)) {
    return undefined;
  }
  const texts = (content.parts as unknown[]).flatMap((part) => {
    if (!part || typeof part !== "object" || !("text" in part)) {
      return [];
    }
    return typeof part.text === "string" ? [part.text] : [];
  });
  const text = texts.join("");
  return text.length > 0 ? text : undefined;
}

function readOutputTokens(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || !("usageMetadata" in body)) {
    return undefined;
  }
  const usage = body.usageMetadata;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const total =
    (typeof record.candidatesTokenCount === "number" ? record.candidatesTokenCount : 0) +
    (typeof record.thoughtsTokenCount === "number" ? record.thoughtsTokenCount : 0);
  return total > 0 ? total : typeof record.totalTokenCount === "number" ? record.totalTokenCount : undefined;
}

export function createGeminiProvider(config: AppConfig): AiProvider {
  const model = config.aiModel ?? GEMINI_DEFAULT_MODEL;
  return {
    id: "gemini",
    async complete(request: AiCompletionRequest): Promise<AiCompletion> {
      if (!config.aiApiKey) {
        throw new AiProviderError("Gemini is selected, but AI_API_KEY (or GEMINI_API_KEY) is not set.", "disabled", true);
      }

      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const user = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n\n");
      if (!user) {
        throw new AiProviderError("Gemini completions require a user message.", "invalid", false);
      }

      const generationConfig: Record<string, unknown> = {
        temperature: 0.3,
        maxOutputTokens: request.maxOutputTokens ?? config.aiMaxOutputTokens,
        thinkingConfig: { thinkingLevel: "LOW" },
      };
      if (request.responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = request.responseSchema;
      }

      const payload = {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig,
      };

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        request.timeoutMs ?? config.aiRequestTimeoutMs,
      );

      let response: Response;
      try {
        response = await fetch(geminiEndpoint(model, config.aiBaseUrl), {
          method: "POST",
          headers: {
            "x-goog-api-key": config.aiApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new AiProviderError("Gemini request timed out.", "timeout", false);
        }
        throw new AiProviderError("Gemini request failed to reach the API.", "unavailable", false);
      } finally {
        clearTimeout(timeout);
      }

      const bodyText = await response.text();
      if (!response.ok) {
        throw classifyGeminiFailure(response.status, bodyText);
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        throw new AiProviderError("Gemini returned a non-JSON body.", "invalid", false);
      }

      const text = readGeminiText(body);
      if (!text) {
        throw new AiProviderError("Gemini returned an empty completion.", "invalid", false);
      }

      return {
        provider: "gemini",
        model,
        text,
        promptChars: system.length + user.length,
        outputTokens: readOutputTokens(body),
      };
    },
  };
}
