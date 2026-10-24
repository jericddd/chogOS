import { haltFromError } from "@/lib/ai/budget";
import { modelJsonShape } from "@/lib/ai/model-json";
import { CHAIN_CHOG_CAP, CHAIN_MON_AGGREGATE, CHAIN_MON_CITIZEN, CHAIN_MON_PER_TX } from "@/lib/chogbank/bank";
import {
  monPayoutRoom,
  settleTreasuryText,
  TREASURY_RESPONSE_SCHEMA,
  TREASURY_UNREADABLE,
  treasuryMessages,
  type TreasuryRosterEntry,
} from "@/lib/ai/treasury-decision";
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
    replyShape: string | null;
  };
};

export type TreasuryConsideration = {
  status: "skipped" | "proposed" | "rejected" | "failed" | "halt";
  detail: string;
  promptChars: number;
  outputTokens: number;
  /** Outbound model calls, including one repair retry. */
  modelCalls: number;
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
  monPerTx?: bigint;
  monCitizen?: bigint;
  monAggregate?: bigint;
  monSpentInWindow?: bigint;
  chogCap?: bigint;
  walletDeployed?: boolean;
  citizenSpentMon?: ReadonlyMap<string, bigint>;
  timeoutMs: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  complete: (request: {
    system: string;
    user: string;
    timeoutMs: number;
    maxOutputTokens: number;
    responseSchema?: Record<string, unknown>;
  }) => Promise<AiCompletion>;
  record: (row: TreasuryDecisionInsert) => Promise<boolean>;
}): Promise<TreasuryConsideration> {
  if (input.roster == null || input.prior == null) {
    return skipped("failed", "Earlier treasury records could not be read. The model was not called.", 0, 0);
  }
  if (input.roster.length === 0) {
    const detail = "No eligible citizen has a deployed wallet whose stored token id matches, so no allocation was requested.";
    await input.record(blankReview(input, "rejected", "rejected", detail));
    return skipped("skipped", detail, 0, 0);
  }
  if (input.monBalance == null || input.chogBalance == null || input.chogDecimals == null) {
    const detail = "Treasury balances and caps were not read. No allocation was requested.";
    await input.record(blankReview(input, "failed", "failed", detail));
    return skipped("failed", detail, 0, 0);
  }
  const facts = {
    monBalance: input.monBalance,
    monPerTx: input.monPerTx ?? CHAIN_MON_PER_TX,
    monCitizen: input.monCitizen ?? CHAIN_MON_CITIZEN,
    monAggregate: input.monAggregate ?? CHAIN_MON_AGGREGATE,
    monSpentInWindow: input.monSpentInWindow ?? 0n,
    chogCap: input.chogCap ?? CHAIN_CHOG_CAP,
    citizenSpentMon: input.citizenSpentMon,
  };
  if (monPayoutRoom(facts) === 0n) {
    const detail = "The MON balance or the remaining contract capacity does not cover a payout. No allocation was requested.";
    await input.record(blankReview(input, "rejected", "rejected", detail));
    return skipped("rejected", detail, 0, 0);
  }
  const messages = treasuryMessages(input.roster, facts);
  const ask = (user: string, timeoutMs: number) =>
    input.complete({
      system: messages.system,
      user,
      timeoutMs,
      maxOutputTokens: input.maxOutputTokens,
      responseSchema: TREASURY_RESPONSE_SCHEMA,
    });
  let completion: AiCompletion;
  const started = Date.now();
  try {
    completion = await ask(messages.user, input.timeoutMs);
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
      return { status: "halt", detail, promptChars: 0, outputTokens: 0, modelCalls: 1, halt };
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
    return skipped("failed", recorded ? detail : "The treasury model call failed and the failure was not recorded.", 0, 0, 1);
  }

  let promptChars = completion.promptChars ?? messages.system.length + messages.user.length;
  let outputTokens = completion.outputTokens ?? 0;
  let modelCalls = 1;
  const settle = (text: string) =>
    settleTreasuryText({
      text,
      roster: input.roster ?? [],
      nowMs: input.nowMs,
      spent: input.prior ?? [],
      monBalance: input.monBalance,
      chogBalance: input.chogBalance,
      chogDecimals: input.chogDecimals,
      walletDeployed: input.walletDeployed === true,
      observedWindowSpent: input.monSpentInWindow,
      citizenSpentMon: input.citizenSpentMon,
    });
  let settled = settle(completion.text);
  let replyShape: string | null = null;
  if (settled.verdict.reason === TREASURY_UNREADABLE) {
    replyShape = modelJsonShape(completion.text);
    const remaining = input.timeoutMs - (Date.now() - started);
    if (remaining >= 1_500) {
      console.info(JSON.stringify({ source: "ai.treasury", event: "unreadable_proposal", retry: true, replyShape }));
      try {
        modelCalls = 2;
        const retry = await ask(
          `${messages.user}\n\nThe previous reply was not one JSON object. Return one JSON object only. If nobody should be paid, set allocate to false and include a reason.`,
          remaining,
        );
        promptChars += retry.promptChars ?? 0;
        outputTokens += retry.outputTokens ?? 0;
        const again = settle(retry.text);
        if (again.verdict.reason !== TREASURY_UNREADABLE) {
          settled = again;
          replyShape = null;
        } else {
          replyShape = modelJsonShape(retry.text);
          console.info(JSON.stringify({ source: "ai.treasury", event: "unreadable_proposal", retry: false, replyShape }));
        }
      } catch (error) {
        const providerError =
          error instanceof AiProviderError
            ? error
            : new AiProviderError(error instanceof Error ? error.message : "The treasury model call failed.", "unavailable", false);
        if (providerError.halt) {
          const detail = providerError.message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 240);
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
            replyShape,
          }));
          return { status: "halt", detail, promptChars, outputTokens, modelCalls, halt };
        }
      }
    } else {
      console.info(JSON.stringify({ source: "ai.treasury", event: "unreadable_proposal", retry: false, replyShape }));
    }
  }
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
    replyShape,
  }));
  if (!recorded) {
    return skipped("failed", "The treasury review finished, and the database did not store it. No transaction was created.", promptChars, outputTokens, modelCalls);
  }
  return {
    status: admitted ? "proposed" : "rejected",
    detail: settled.verdict.reason,
    promptChars,
    outputTokens,
    modelCalls,
    halt: null,
  };
}

function blankReview(
  input: { provider: string; model: string },
  status: TreasuryDecisionInsert["status"],
  stage: TreasuryDecisionInsert["output"]["stage"],
  rationale: string,
): TreasuryDecisionInsert {
  return row({
    provider: input.provider,
    model: input.model,
    status,
    stage,
    rationale,
    citizenId: null,
    decisionId: null,
    tokenId: null,
    asset: null,
    amountRaw: null,
    expectedOutcome: null,
    windowId: null,
  });
}

export function treasuryReviewInsert(input: {
  provider: string;
  model: string;
  status: TreasuryDecisionInsert["status"];
  stage: TreasuryDecisionInsert["output"]["stage"];
  rationale: string;
}): TreasuryDecisionInsert {
  return blankReview(input, input.status, input.stage, input.rationale);
}

function skipped(
  status: TreasuryConsideration["status"],
  detail: string,
  promptChars: number,
  outputTokens: number,
  modelCalls = 0,
): TreasuryConsideration {
  return { status, detail, promptChars, outputTokens, modelCalls, halt: null };
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
  replyShape?: string | null;
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
      replyShape: input.replyShape ?? null,
    },
  };
}
