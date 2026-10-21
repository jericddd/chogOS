import { haltFromError } from "@/lib/ai/budget";
import { settleTreasuryText, treasuryMessages, type TreasuryRosterEntry } from "@/lib/ai/treasury-decision";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";
import type { SpendRecord } from "@/lib/economy/treasury-policy";

export type TreasuryDecisionInsert = {
  purpose: "treasury_allocation";
  status: "proposed" | "rejected" | "failed";
  citizenId: string | null;
  rationale: string;
  validationResult: string;
  inputCommitment: string | null;
  provider: string;
  model: string;
  output: {
    executed: false;
    onchain: false;
    verified: false;
    stage: "proposed" | "rejected" | "failed";
    tokenId: string | null;
    asset: "MON" | "CHOG" | null;
    amountRaw: string | null;
    reason: string;
    expectedOutcome: string | null;
    decisionId: string | null;
    windowId: string | null;
    chainId: 143;
    txHash: null;
    blockNumber: null;
  };
};

export type TreasuryConsideration = {
  status: "skipped" | "proposed" | "rejected" | "failed" | "halt";
  detail: string;
  promptChars: number;
  outputTokens: number;
  halt: { until: string; reason: string } | null;
};

const COMMITMENT = /^0x[0-9a-f]{64}$/;

export async function considerTreasuryAllocation(input: {
  nowMs: number;
  roster: readonly TreasuryRosterEntry[] | null;
  prior: readonly SpendRecord[] | null;
  monBalance: bigint | null;
  chogBalance: bigint | null;
  chogDecimals: number | null;
  timeoutMs: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  complete: (request: { system: string; user: string; timeoutMs: number; maxOutputTokens: number }) => Promise<AiCompletion>;
  record: (row: TreasuryDecisionInsert) => Promise<boolean>;
}): Promise<TreasuryConsideration> {
  if (input.roster == null || input.prior == null) {
    return skipped("failed", "Earlier treasury records could not be read. The model was not called.", 0, 0);
  }
  if (input.roster.length === 0) {
    return skipped("skipped", "No enrolled citizen is eligible, so no allocation was requested.", 0, 0);
  }
  const messages = treasuryMessages(input.roster);
  let completion: AiCompletion;
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
        : new AiProviderError(error instanceof Error ? error.message : "The treasury model call failed.", "unavailable", false);
    const detail = providerError.message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 240);
    if (providerError.halt) {
      const halt = haltFromError(providerError);
      await input.record(row({
        provider: input.provider,
        model: input.model,
        status: "failed",
        stage: "failed",
        rationale: detail,
        citizenId: null,
        decisionId: null,
        tokenId: null,
        asset: null,
        amountRaw: null,
        expectedOutcome: null,
        windowId: null,
      }));
      return { status: "halt", detail, promptChars: 0, outputTokens: 0, halt };
    }
    const recorded = await input.record(row({
      provider: input.provider,
      model: input.model,
      status: "failed",
      stage: "failed",
      rationale: detail,
      citizenId: null,
      decisionId: null,
      tokenId: null,
      asset: null,
      amountRaw: null,
      expectedOutcome: null,
      windowId: null,
    }));
    return skipped("failed", recorded ? detail : "The treasury model call failed and the failure was not recorded.", 0, 0);
  }

  const promptChars = completion.promptChars ?? messages.system.length + messages.user.length;
  const outputTokens = completion.outputTokens ?? 0;
  const settled = settleTreasuryText({
    text: completion.text,
    roster: input.roster,
    nowMs: input.nowMs,
    spent: input.prior,
    monBalance: input.monBalance,
    chogBalance: input.chogBalance,
    chogDecimals: input.chogDecimals,
  });
  const admitted = settled.verdict.status === "accepted_not_executed";
  const citizen = input.roster.find((entry) => entry.tokenId === settled.draft?.tokenId);
  const recorded = await input.record(row({
    provider: input.provider,
    model: input.model,
    status: admitted ? "proposed" : "rejected",
    stage: admitted ? "proposed" : "rejected",
    rationale: settled.verdict.reason,
    citizenId: citizen?.citizenId ?? null,
    decisionId: settled.verdict.decisionId,
    tokenId: settled.draft?.tokenId ?? null,
    asset: settled.draft?.asset ?? null,
    amountRaw: settled.draft ? settled.draft.amountRaw.toString(10) : null,
    expectedOutcome: settled.draft?.expectedOutcome ?? null,
    windowId: settled.verdict.windowId,
    reason: settled.draft?.reason ?? settled.verdict.reason,
  }));
  if (!recorded) {
    return skipped("failed", "The treasury review finished, and the database did not store it. No transaction was created.", promptChars, outputTokens);
  }
  return {
    status: admitted ? "proposed" : "rejected",
    detail: settled.verdict.reason,
    promptChars,
    outputTokens,
    halt: null,
  };
}

function skipped(
  status: TreasuryConsideration["status"],
  detail: string,
  promptChars: number,
  outputTokens: number,
): TreasuryConsideration {
  return { status, detail, promptChars, outputTokens, halt: null };
}

function row(input: {
  provider: string;
  model: string;
  status: TreasuryDecisionInsert["status"];
  stage: TreasuryDecisionInsert["output"]["stage"];
  rationale: string;
  citizenId: string | null;
  decisionId: string | null;
  tokenId: string | null;
  asset: "MON" | "CHOG" | null;
  amountRaw: string | null;
  expectedOutcome: string | null;
  windowId: string | null;
  reason?: string;
}): TreasuryDecisionInsert {
  const commitment = input.decisionId && COMMITMENT.test(input.decisionId) ? input.decisionId.toLowerCase() : null;
  return {
    purpose: "treasury_allocation",
    status: input.status,
    citizenId: input.citizenId,
    rationale: input.rationale.slice(0, 500),
    validationResult: input.rationale.slice(0, 500),
    inputCommitment: commitment,
    provider: input.provider,
    model: input.model,
    output: {
      executed: false,
      onchain: false,
      verified: false,
      stage: input.stage,
      tokenId: input.tokenId,
      asset: input.asset,
      amountRaw: input.amountRaw,
      reason: (input.reason ?? input.rationale).slice(0, 320),
      expectedOutcome: input.expectedOutcome,
      decisionId: commitment,
      windowId: input.windowId,
      chainId: 143,
      txHash: null,
      blockNumber: null,
    },
  };
}
