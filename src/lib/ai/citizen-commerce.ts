import { haltFromError } from "@/lib/ai/budget";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";
import {
  blockingTransferReason,
  settleTransferText,
  TRANSFER_RESPONSE_SCHEMA,
  transferMessages,
  type TransferSettlement,
  type TransferWorld,
} from "@/lib/ai/transfer-decision";

export type CitizenCommerceInsert = TransferSettlement & {
  provider: string;
  model: string;
};

export type CitizenCommerceConsideration = {
  status: "skipped" | "proposed" | "deferred" | "rejected" | "failed" | "halt";
  detail: string;
  promptChars: number;
  outputTokens: number;
  halt: { until: string; reason: string } | null;
};

export async function considerCitizenCommerce(input: {
  world: TransferWorld;
  timeoutMs: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  complete: ((request: {
    system: string;
    user: string;
    timeoutMs: number;
    maxOutputTokens: number;
    responseSchema?: Record<string, unknown>;
  }) => Promise<AiCompletion>) | null;
  record: (row: CitizenCommerceInsert) => Promise<boolean>;
}): Promise<CitizenCommerceConsideration> {
  const blocked = blockingTransferReason(input.world);
  if (!input.complete) {
    return skipped("skipped", "No model time remained for a citizen transfer. No transaction was broadcast.", 0, 0);
  }
  if (blocked) {
    const settled = settleTransferText("", input.world);
    if (!settled.record) return skipped("skipped", `${blocked} The same deferral is already stored.`, 0, 0);
    const recorded = await input.record({ ...settled, rationale: blocked, provider: input.provider, model: input.model });
    return skipped(recorded ? "deferred" : "failed", recorded ? blocked : "The deferral was not stored. No transaction was broadcast.", 0, 0);
  }
  const messages = transferMessages(input.world);
  let completion: AiCompletion | null = null;
  let halt: { until: string; reason: string } | null = null;
  try {
    completion = await input.complete({
      system: messages.system,
      user: messages.user,
      timeoutMs: input.timeoutMs,
      maxOutputTokens: input.maxOutputTokens,
      responseSchema: TRANSFER_RESPONSE_SCHEMA,
    });
  } catch (error) {
    const providerError =
      error instanceof AiProviderError
        ? error
        : new AiProviderError(error instanceof Error ? error.message : "The citizen transfer model call failed.", "unavailable", false);
    if (!providerError.halt && (providerError.code === "quota" || providerError.code === "rate_limit" || /not sent/i.test(providerError.message))) {
      return skipped(
        "skipped",
        "The Lite model slot is not open. No trade or return was requested. No transaction was broadcast.",
        0,
        0,
      );
    }
    if (providerError.halt) halt = haltFromError(providerError);
    const detail = providerError.message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 240);
    const settled = settleTransferText("", input.world);
    const technical = { ...settled, publicState: "technical_failure" as const, rationale: detail, fromModel: false };
    if (technical.record) {
      const recorded = await input.record({ ...technical, provider: input.provider, model: input.model });
      if (!recorded) return skipped("failed", "The transfer failure was not stored. No transaction was broadcast.", 0, 0);
    }
    if (halt) return { status: "halt", detail, promptChars: 0, outputTokens: 0, halt };
    return skipped("failed", detail, 0, 0);
  }
  const settled = settleTransferText(completion.text, input.world);
  if (settled.record) {
    const recorded = await input.record({ ...settled, provider: input.provider, model: input.model });
    if (!recorded) {
      return skipped("failed", "The transfer decision was not stored. No transaction was broadcast.", completion.promptChars ?? 0, completion.outputTokens ?? 0);
    }
  }
  const detail = `${settled.rationale} No transaction was broadcast.`;
  const status = settled.publicState === "proposed"
    ? "proposed"
    : settled.publicState === "technical_failure"
      ? "failed"
      : settled.publicState === "no_allocation"
        ? "rejected"
        : "deferred";
  if (halt) return { status: "halt", detail, promptChars: completion.promptChars ?? 0, outputTokens: completion.outputTokens ?? 0, halt };
  return { status, detail, promptChars: completion.promptChars ?? 0, outputTokens: completion.outputTokens ?? 0, halt: null };
}

function skipped(
  status: CitizenCommerceConsideration["status"],
  detail: string,
  promptChars: number,
  outputTokens: number,
): CitizenCommerceConsideration {
  return { status, detail, promptChars, outputTokens, halt: null };
}
