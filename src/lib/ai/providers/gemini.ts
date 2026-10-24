import type { AppConfig } from "@/lib/config/env";
import { geminiModelForRequest, modelCallTimeoutMs } from "@/lib/ai/model-route";
import { AiProviderError, type AiCompletion, type AiCompletionRequest, type AiProvider } from "@/lib/ai/types";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
/** Kept so older checks can name the Lite model. Completions do not walk this list. */
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

/** One model for this purpose. Routine work does not fall through to Flash. */
export function geminiModelsToTry(configured: string, purpose = ""): string[] {
  return [geminiModelForRequest(configured, purpose)];
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

export function geminiEndpoint(model: string, baseUrl?: string): string {
  if (baseUrl) {
    return baseUrl;
  }
  return `${DEFAULT_HOST}/models/${encodeURIComponent(model)}:generateContent`;
}

/**
 * Google's stock 429 says "check your plan and billing details" on ordinary quota errors.
 * That sentence is not a request to turn on paid inference.
 */
function isBillingRefusal(lower: string): boolean {
  const asksToPay =
    /enable billing|upgrade to (a )?paid|paid tier|credit card|payment required|billing account|set up billing|activate billing/.test(
      lower,
    );
  if (asksToPay) return true;
  if (/billing details/.test(lower)) return false;
  return /\bbilling\b|\bpayment\b/.test(lower);
}

/**
 * A daily close needs an explicit per-day signal and no per-minute or token signal.
 * "quota" and RESOURCE_EXHAUSTED appear on RPM, TPM, and daily 429s, so they are not proof.
 * A body that mentions both day and minute limits is ambiguous and stays a temporary limit.
 */
function isDailyQuotaExhausted(lower: string): boolean {
  const daily = /per[\s_-]?day|\bdaily\b|\brpd\b|requestsperday/.test(lower);
  const burst =
    /per[\s_-]?minute|\brpm\b|\btpm\b|requestsperminute|tokensperminute|input_token|output_token|token_count/.test(
      lower,
    );
  return daily && !burst;
}

function classifyGeminiFailure(status: number, bodyText: string): AiProviderError {
  const lower = bodyText.toLowerCase();
  if (isBillingRefusal(lower)) {
    return new AiProviderError(
      "Gemini refused the request for a billing-related reason. chogOS will not enable paid inference.",
      "billing",
      true,
    );
  }
  if (status === 429 || /resource_exhausted|quota|rate.?limit/.test(lower)) {
    const daily = isDailyQuotaExhausted(lower);
    return new AiProviderError(
      daily
        ? "Gemini free-tier quota is exhausted for this model."
        : "Gemini rate-limited the request. This model is deferred.",
      daily ? "quota" : "rate_limit",
      false,
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

async function reserveOutbound(request: AiCompletionRequest, model: string): Promise<void> {
  if (!request.reserveAttempt) {
    throw new AiProviderError("A shared model slot was not reserved, so this request was not sent.", "unavailable", false);
  }
  try {
    await request.reserveAttempt(model);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("The shared model ledger is unavailable, so this request was not sent.", "unavailable", false);
  }
}

export function createGeminiProvider(config: AppConfig): AiProvider {
  const configured = config.aiModel ?? GEMINI_DEFAULT_MODEL;
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

      const model = geminiModelForRequest(configured, request.purpose);
      const timeoutMs = modelCallTimeoutMs(model, request.timeoutMs ?? config.aiRequestTimeoutMs);
      const budgetEndsAt = Date.now() + timeoutMs;
      const headers = {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      };
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
      let skipReserve = request.attemptAlreadyReserved === true;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const slice = budgetEndsAt - Date.now();
        if (slice < 1_500) {
          throw new AiProviderError("Gemini request timed out.", "timeout", false);
        }
        if (skipReserve) {
          skipReserve = false;
        } else {
          await reserveOutbound(request, model);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), slice);
        let response: Response;
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

        const bodyText = await response.text();
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
          return {
            provider: "gemini",
            model,
            text,
            promptChars: system.length + user.length,
            outputTokens: readOutputTokens(body),
          };
        }

        const failure = classifyGeminiFailure(response.status, bodyText);
        if (response.status === 429 || failure.code === "quota" || failure.code === "rate_limit") {
          throw failure;
        }
        const retryable = failure.code === "unavailable" && response.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        throw failure;
      }

      throw new AiProviderError("Gemini request failed to reach the API.", "unavailable", false);
    },
  };
}
