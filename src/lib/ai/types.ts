import type { AiProviderId } from "@/lib/config/env";

export type AiMessage = {
  role: "system" | "user";
  content: string;
};

export type AiCompletionRequest = {
  purpose: string;
  messages: AiMessage[];
};

export type AiCompletion = {
  provider: Exclude<AiProviderId, "none">;
  model: string;
  text: string;
};

/**
 * The provider can draft text. It has no tool list, no wallet handle,
 * and no way to submit a transaction.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}
