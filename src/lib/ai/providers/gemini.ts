import type { AppConfig } from "@/lib/config/env";
import { AiProviderError, type AiCompletion, type AiCompletionRequest, type AiProvider } from "@/lib/ai/types";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
/**
 * This AI Studio key has `gemini-3.8-flash` (LOW thinking timed out on Hobby).
 * 2.5/2.0 404'd and wrongly halted the mind. Try 3.x lite/MINIMAL first, then 3.8.
 */
export const GEMINI_HOBBY_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-3.8-flash",
] as const;
export const GEMINI_HOBBY_MODEL = GEMINI_HOBBY_MODELS[0];
export const GEMINI_HOBBY_FALLBACK_MODEL = GEMINI_HOBBY_MODELS[1];
/** Fastest thinking 3.8 Flash accepts. `MINIMAL` returns HTTP 400 on this model. */
export const GEMINI_THINKING_LEVEL = "LOW";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com/v1beta";

export function geminiModelsToTry(configured: string): string[] {
  const model = configured.trim();
  if (model === "gemini-3.8-flash" || model.startsWith("gemini-3.8-flash")) {
    return [...GEMINI_HOBBY_MODELS];
  }
  return [model];
}

/** Try the model that already answered in this process before the 404 ladder. */
export function withRememberedModel(models: readonly string[], remembered: string | undefined): string[] {
  if (!remembered || models[0] === remembered || !models.includes(remembered)) {
    return [...models];
  }
  return [remembered, ...models.filter((model) => model !== remembered)];
}

export function geminiThinkingConfig(model: string): Record<string, unknown> {
  if (model.startsWith("gemini-2.")) {
    return { thinkingBudget: 0 };
  }
  if (model.startsWith("gemini-3.8")) {
    return { thinkingLevel: GEMINI_THINKING_LEVEL };
  }
  return { thinkingLevel: "MINIMAL" };
}

function isMissingModel(status: number, bodyText: string): boolean {
  return status === 404 || /not found|is not found|unknown model/.test(bodyText.toLowerCase());
}

function isThinkingRejected(status: number, bodyText: string): boolean {
  return status === 400 && /thinking|minimal|thinking_budget|thinkingbudget/.test(bodyText.toLowerCase());
}

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
  if (isMissingModel(status, bodyText)) {
    return new AiProviderError("The configured Gemini model is not available to this account.", "unavailable", false);
  }
  if (status >= 500) {
    return new AiProviderError(`Gemini returned HTTP ${status}.`, "unavailable", false);
  }
  const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 180);
  const suffix = snippet ? ` ${snippet}` : "";
  return new AiProviderError(
    `Gemini request failed with HTTP ${status}.${suffix}`,
    status === 400 ? "invalid" : "unavailable",
    false,
  );
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
  const configured = config.aiModel ?? GEMINI_DEFAULT_MODEL;
  let rememberedModel: string | undefined;
  return {
    id: "gemini",
    async complete(request: AiCompletionRequest): Promise<AiCompletion> {
      const apiKey = config.aiApiKey;
      if (!apiKey) {
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

      const timeoutMs = request.timeoutMs ?? config.aiRequestTimeoutMs;
      const headers = {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      };
      const models = withRememberedModel(geminiModelsToTry(configured), rememberedModel);
      let lastFailure: AiProviderError | undefined;

      for (const model of models) {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.3,
          maxOutputTokens: request.maxOutputTokens ?? config.aiMaxOutputTokens,
          thinkingConfig: geminiThinkingConfig(model),
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
        const endpoint = geminiEndpoint(model, config.aiBaseUrl);
        const maxAttempts = 2;
        let bodyText = "";
        let response: Response | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw new AiProviderError("Gemini request timed out.", "timeout", false);
            }
            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 800));
              continue;
            }
            throw new AiProviderError("Gemini request failed to reach the API.", "unavailable", false);
          } finally {
            clearTimeout(timeout);
          }

          bodyText = await response.text();
          if (response.ok) {
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
            rememberedModel = model;
            return {
              provider: "gemini",
              model,
              text,
              promptChars: system.length + user.length,
              outputTokens: readOutputTokens(body),
            };
          }

          const failure = classifyGeminiFailure(response.status, bodyText);
          lastFailure = failure;
          const skipModel =
            (isMissingModel(response.status, bodyText) || isThinkingRejected(response.status, bodyText)) &&
            model !== models[models.length - 1];
          if (skipModel) {
            break;
          }
          const retryable = !failure.halt && failure.code === "unavailable" && response.status >= 500;
          if (retryable && attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            continue;
          }
          throw failure;
        }
      }

      throw lastFailure ?? new AiProviderError("Gemini request failed to reach the API.", "unavailable", false);
    },
  };
}
