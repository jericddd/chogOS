import type { AiProviderId } from "@/lib/config/env";

export type AiMessage = {
  role: "system" | "user";
  content: string;
};

export type AiCompletionRequest = {
  purpose: string;
  messages: AiMessage[];
  /** JSON Schema for providers that support structured output. */
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxOutputTokens?: number;
};

export type AiCompletion = {
  provider: AiProviderId;
  model: string;
  text: string;
  promptChars?: number;
  outputTokens?: number;
};

/**
 * The provider can draft text. It has no tool list, no wallet handle,
 * and no way to submit a transaction.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

export type AiHaltCode = "quota" | "rate_limit" | "billing" | "timeout" | "unavailable" | "invalid" | "disabled";

export class AiProviderError extends Error {
  readonly code: AiHaltCode;
  readonly halt: boolean;

  constructor(message: string, code: AiHaltCode, halt: boolean) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.halt = halt;
  }
}
