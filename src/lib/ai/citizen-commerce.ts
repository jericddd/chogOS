import { haltFromError } from "@/lib/ai/budget";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";

export const COMMERCE_BATCH = 5;

export type CommerceCitizen = {
  tokenId: string;
  name: string;
  citizenId: string;
  wallet: string;
  missing: Array<"trade" | "return">;
};

export type CitizenCommerceInsert = {
  purpose: "citizen_trade" | "citizen_return";
  citizenId: string;
  tokenId: string;
  wallet: string;
  rationale: string;
  fromModel: boolean;
  provider: string;
  model: string;
};

export type CitizenCommerceConsideration = {
  status: "skipped" | "proposed" | "failed" | "halt";
  detail: string;
  promptChars: number;
  outputTokens: number;
  halt: { until: string; reason: string } | null;
};

type SettledReason = { text: string; fromModel: boolean };

export function tradePolicy(tokenId: string): string {
  return `Chog #${tokenId} should trade so the town can exchange what it already has. This decision does not broadcast a transaction.`;
}

export function returnPolicy(tokenId: string): string {
  return `Chog #${tokenId} should return surplus funds to ChogBank. ChogBank is not deployed, so this decision does not broadcast a transaction.`;
}

export function commerceMessages(citizens: readonly CommerceCitizen[]): { system: string; user: string } {
  return {
    system: [
      "You are the chogOS mind speaking for enrolled citizens.",
      "For each citizen, write why that citizen should trade and why surplus MON should go back to ChogBank.",
      "You do not sign, broadcast, choose an amount, or name an address.",
      'Reply with JSON only: {"citizens":[{"tokenId":"7","tradeRationale":"...","returnRationale":"..."}]}',
      "Each rationale is one or two sentences, under 240 characters, with no URL.",
    ].join(" "),
    user: citizens.map((citizen) => `${citizen.tokenId} ${citizen.name}`).join("\n"),
  };
}

function clip(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim().slice(0, 240);
  if (!text || /https?:\/\//i.test(text)) return "";
  return text;
}

/** Model words are kept only for a listed citizen and a URL-free rationale. Everyone else gets the policy sentence. */
export function settleCommerceText(text: string, citizens: readonly CommerceCitizen[]): Map<string, { trade: SettledReason; returnToBank: SettledReason }> {
  const fromModel = new Map<string, { trade: string; returnToBank: string }>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { citizens?: unknown };
      const rows = Array.isArray(parsed.citizens) ? parsed.citizens : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const body = row as Record<string, unknown>;
        const tokenId = typeof body.tokenId === "string" ? body.tokenId.split(".")[0] : "";
        if (!tokenId) continue;
        fromModel.set(tokenId, { trade: clip(body.tradeRationale), returnToBank: clip(body.returnRationale) });
      }
    } catch {
      fromModel.clear();
    }
  }
  const settled = new Map<string, { trade: SettledReason; returnToBank: SettledReason }>();
  for (const citizen of citizens) {
    const model = fromModel.get(citizen.tokenId);
    settled.set(citizen.tokenId, {
      trade: model?.trade ? { text: model.trade, fromModel: true } : { text: tradePolicy(citizen.tokenId), fromModel: false },
      returnToBank: model?.returnToBank
        ? { text: model.returnToBank, fromModel: true }
        : { text: returnPolicy(citizen.tokenId), fromModel: false },
    });
  }
  return settled;
}

export async function considerCitizenCommerce(input: {
  citizens: readonly CommerceCitizen[];
  timeoutMs: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  complete: ((request: { system: string; user: string; timeoutMs: number; maxOutputTokens: number }) => Promise<AiCompletion>) | null;
  record: (row: CitizenCommerceInsert) => Promise<boolean>;
}): Promise<CitizenCommerceConsideration> {
  const batch = input.citizens.filter((citizen) => citizen.missing.length > 0).slice(0, COMMERCE_BATCH);
  if (batch.length === 0) {
    return skipped("skipped", "Every citizen with a verified wallet already has a trade decision and a return decision.", 0, 0);
  }
  if (!input.complete) {
    return skipped("skipped", "No model time remained for a trade or return decision. No transaction was broadcast.", 0, 0);
  }
  const messages = commerceMessages(batch);
  let completion: AiCompletion | null = null;
  let halt: { until: string; reason: string } | null = null;
  if (input.complete) {
    try {
      completion = await input.complete({
        system: messages.system,
        user: messages.user,
        timeoutMs: input.timeoutMs,
        maxOutputTokens: input.maxOutputTokens,
      });
    } catch (error) {
      const providerError =
        error instanceof AiProviderError
          ? error
          : new AiProviderError(error instanceof Error ? error.message : "The citizen commerce model call failed.", "unavailable", false);
      if (providerError.halt) halt = haltFromError(providerError);
    }
  }
  const settled = settleCommerceText(completion?.text ?? "", batch);
  const stored: string[] = [];
  for (const citizen of batch) {
    const words = settled.get(citizen.tokenId);
    if (!words) continue;
    if (citizen.missing.includes("trade")) {
      const recorded = await input.record({
        purpose: "citizen_trade",
        citizenId: citizen.citizenId,
        tokenId: citizen.tokenId,
        wallet: citizen.wallet,
        rationale: words.trade.text,
        fromModel: words.trade.fromModel,
        provider: input.provider,
        model: input.model,
      });
      if (!recorded) return skipped("failed", "A trade decision was not stored. No transaction was broadcast.", completion?.promptChars ?? 0, completion?.outputTokens ?? 0);
      stored.push(`${citizen.tokenId} trade`);
    }
    if (citizen.missing.includes("return")) {
      const recorded = await input.record({
        purpose: "citizen_return",
        citizenId: citizen.citizenId,
        tokenId: citizen.tokenId,
        wallet: citizen.wallet,
        rationale: words.returnToBank.text,
        fromModel: words.returnToBank.fromModel,
        provider: input.provider,
        model: input.model,
      });
      if (!recorded) return skipped("failed", "A return decision was not stored. No transaction was broadcast.", completion?.promptChars ?? 0, completion?.outputTokens ?? 0);
      stored.push(`${citizen.tokenId} return`);
    }
  }
  const detail = `Trade and return decisions for ${stored.join(", ")}. No transaction was broadcast.`;
  if (halt) {
    return { status: "halt", detail, promptChars: completion?.promptChars ?? 0, outputTokens: completion?.outputTokens ?? 0, halt };
  }
  return { status: "proposed", detail, promptChars: completion?.promptChars ?? 0, outputTokens: completion?.outputTokens ?? 0, halt: null };
}

function skipped(
  status: CitizenCommerceConsideration["status"],
  detail: string,
  promptChars: number,
  outputTokens: number,
): CitizenCommerceConsideration {
  return { status, detail, promptChars, outputTokens, halt: null };
}
