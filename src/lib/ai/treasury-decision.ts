import { CHAIN_CHOG_CAP, CHAIN_MON_AGGREGATE, CHAIN_MON_CITIZEN, CHAIN_MON_PER_TX } from "@/lib/chogbank/bank";
import { readModelJson } from "@/lib/ai/model-json";
import { APPLICATION_TREASURY_LIMITS, evaluateTreasuryAllocation, type AllocationDraft, type AllocationVerdict, type SpendRecord } from "@/lib/economy/treasury-policy";
import { formatTokenAmount } from "@/lib/wallets/present";

export type TreasuryRosterEntry = {
  tokenId: string;
  name: string;
  goal: string | null;
  /** Database id. It is never sent to the model. */
  citizenId?: string;
};

const FORBIDDEN_KEYS = new Set(["recipient", "to", "target", "address", "wallet", "owner"]);

export const TREASURY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    allocate: { type: "boolean" },
    tokenId: { type: "string" },
    asset: { type: "string", enum: ["MON"] },
    amountRaw: { type: "string" },
    reason: { type: "string" },
    expectedOutcome: { type: "string" },
  },
  required: ["reason"],
};

export const TREASURY_UNREADABLE = "The treasury proposal was not JSON.";

export type TreasuryPromptFacts = {
  monBalance: bigint;
  monPerTx: bigint;
  monCitizen: bigint;
  monAggregate: bigint;
  monSpentInWindow: bigint;
  chogCap: bigint;
  citizenSpentMon?: ReadonlyMap<string, bigint>;
};

export function monPayoutRoom(facts: Pick<TreasuryPromptFacts, "monBalance" | "monPerTx" | "monAggregate" | "monSpentInWindow">): bigint {
  const remaining = facts.monAggregate > facts.monSpentInWindow ? facts.monAggregate - facts.monSpentInWindow : 0n;
  let room = facts.monPerTx;
  if (room > remaining) room = remaining;
  if (room > facts.monBalance) room = facts.monBalance;
  return room > 0n ? room : 0n;
}

export function treasuryMessages(roster: readonly TreasuryRosterEntry[], facts: TreasuryPromptFacts): { system: string; user: string } {
  const room = monPayoutRoom(facts);
  const system = [
    "You propose at most one treasury allocation for one citizen in the list.",
    "Return JSON only.",
    "Fields are tokenId, asset, amountRaw, reason, and expectedOutcome.",
    "asset must be MON.",
    `The deployed $CHOG cap is ${facts.chogCap.toString(10)} wei. $CHOG is not available for a payout at that cap.`,
    "amountRaw is an integer string of MON wei, greater than 0.",
    `amountRaw must be at most ${room.toString(10)}, which is the smaller of the contract per-transaction cap, the remaining aggregate capacity, and the live MON balance.`,
    "Use the citizen goal when you choose who receives funds.",
    "Do not name an address, a contract, or a recipient.",
    "A proposal is not a payment. The server can reject it. An accepted MON allocation can be broadcast later by a signer that is not this model.",
    "If nobody should receive funds, return {\"allocate\":false,\"reason\":\"why\"}.",
  ].join(" ");
  const user = JSON.stringify({
    monBalanceRaw: facts.monBalance.toString(10),
    monBalance: formatTokenAmount(facts.monBalance.toString(10), 18, "MON"),
    contractCaps: {
      monPerTx: facts.monPerTx.toString(10),
      monPerCitizen: facts.monCitizen.toString(10),
      monAggregate: facts.monAggregate.toString(10),
      chogPerTx: facts.chogCap.toString(10),
    },
    monSpentThisWindow: facts.monSpentInWindow.toString(10),
    monRemainingAggregate: (facts.monAggregate > facts.monSpentInWindow ? facts.monAggregate - facts.monSpentInWindow : 0n).toString(10),
    maximumAmountRaw: room.toString(10),
    chog: "unavailable",
    citizens: roster.map((citizen) => ({
      tokenId: citizen.tokenId,
      name: citizen.name,
      goal: citizen.goal,
      monSpentThisWindow: (facts.citizenSpentMon?.get(citizen.tokenId) ?? 0n).toString(10),
    })),
  });
  return { system, user };
}

export function parseTreasuryProposal(
  text: string,
  eligibleTokenIds: ReadonlySet<string>,
): { ok: true; draft: AllocationDraft | null; reason: string } | { ok: false; reason: string } {
  const parsed = readModelJson(text);
  if (!parsed.ok) return { ok: false, reason: TREASURY_UNREADABLE };
  const raw = parsed.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The treasury proposal was not an object." };
  }
  const body = raw as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => FORBIDDEN_KEYS.has(key.toLowerCase()));
  if (forbidden) {
    return { ok: false, reason: "The model named a destination field. Only a citizen token id is accepted." };
  }
  if (body.allocate === false) {
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 320) : "The model proposed no allocation.";
    return { ok: true, draft: null, reason };
  }
  const tokenId = typeof body.tokenId === "string" || typeof body.tokenId === "number" ? String(body.tokenId).split(".")[0] : "";
  if (!/^[0-9]+$/.test(tokenId) || !eligibleTokenIds.has(tokenId)) {
    return { ok: false, reason: "The token id is not in the eligible roster." };
  }
  if (body.asset === "CHOG") {
    return {
      ok: false,
      reason: "The deployed $CHOG cap is 1 wei. $CHOG is not available for a payout at that cap. MON is the usable payout asset.",
    };
  }
  if (body.asset !== "MON") {
    return { ok: false, reason: "The asset must be MON." };
  }
  const amountRaw = amountRawText(body.amountRaw);
  if (!amountRaw) {
    return { ok: false, reason: "amountRaw must be a base-unit integer string." };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 320) : "";
  const expectedOutcome = typeof body.expectedOutcome === "string" ? body.expectedOutcome.trim().slice(0, 240) : "";
  if (!reason || !expectedOutcome || /https?:\/\//i.test(`${reason} ${expectedOutcome}`)) {
    return { ok: false, reason: "The reason and expected outcome must be present and must not contain a URL." };
  }
  return {
    ok: true,
    draft: { tokenId, asset: body.asset, amountRaw: BigInt(amountRaw), reason, expectedOutcome },
    reason,
  };
}

export function settleTreasuryText(input: {
  text: string;
  roster: readonly TreasuryRosterEntry[];
  nowMs: number;
  spent: readonly SpendRecord[];
  monBalance: bigint | null;
  chogBalance: bigint | null;
  chogDecimals: number | null;
  walletDeployed?: boolean;
  observedWindowSpent?: bigint;
  citizenSpentMon?: ReadonlyMap<string, bigint>;
}): { verdict: AllocationVerdict; draft: AllocationDraft | null } {
  const eligible = new Set(input.roster.map((citizen) => citizen.tokenId));
  const parsed = parseTreasuryProposal(input.text, eligible);
  if (!parsed.ok) {
    return {
      draft: null,
      verdict: {
        status: "rejected",
        reason: parsed.reason,
        executed: false,
        decisionId: null,
        reasonHash: null,
        deadline: null,
        windowId: null,
        onchain: false,
      },
    };
  }
  if (!parsed.draft) {
    return {
      draft: null,
      verdict: {
        status: "rejected",
        reason: parsed.reason,
        executed: false,
        decisionId: null,
        reasonHash: null,
        deadline: null,
        windowId: null,
        onchain: false,
      },
    };
  }
  const draft = parsed.draft;
  const observedCitizenSpent = input.citizenSpentMon?.get(draft.tokenId);
  if (input.citizenSpentMon && observedCitizenSpent == null) {
    return {
      draft,
      verdict: {
        status: "rejected",
        reason: "This citizen's MON spending was not read, so the allocation was not accepted.",
        executed: false,
        decisionId: null,
        reasonHash: null,
        deadline: null,
        windowId: null,
        onchain: false,
      },
    };
  }
  const verdict = evaluateTreasuryAllocation({
    draft,
    limits: {
      ...APPLICATION_TREASURY_LIMITS,
      maxPerTxMon: CHAIN_MON_PER_TX,
      maxCitizenWindowMon: CHAIN_MON_CITIZEN,
      maxAggregateWindowMon: CHAIN_MON_AGGREGATE,
      maxPerTxChog: CHAIN_CHOG_CAP,
      maxCitizenWindowChog: CHAIN_CHOG_CAP,
      maxAggregateWindowChog: CHAIN_CHOG_CAP,
    },
    nowMs: input.nowMs,
    eligibleTokenIds: eligible,
    spent: input.spent,
    monBalance: input.monBalance,
    chogBalance: input.chogBalance,
    chogDecimals: input.chogDecimals,
    walletDeployed: input.walletDeployed === true,
    executionEnabled: false,
    observedWindowSpent: input.observedWindowSpent,
    observedCitizenSpent,
  });
  if ((verdict.status === "accepted_not_executed" || verdict.status === "ready_for_signature") && input.walletDeployed !== true) {
    return {
      draft,
      verdict: {
        status: "rejected",
        reason: "No deployed citizen wallet was observed for this token, so the allocation was not accepted.",
        executed: false,
        decisionId: null,
        reasonHash: null,
        deadline: null,
        windowId: null,
        onchain: false,
      },
    };
  }
  return { draft, verdict };
}

function amountRawText(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}
