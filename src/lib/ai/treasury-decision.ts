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

const FORBIDDEN_KEYS = new Set(["recipient", "to", "target", "address", "wallet", "owner", "holder", "nftholder"]);
const FACT_ID = /^[A-Za-z0-9:._-]{1,96}$/;

export type TreasuryWorldFact = {
  id: string;
  kind: "balance" | "wallet" | "goal" | "spent" | "need" | "project" | "event";
  summary: string;
  tokenId: string | null;
};

export type GroundedAllocation = AllocationDraft & { factIds: string[] };

export const TREASURY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    allocate: { type: "boolean" },
    tokenId: { type: "string" },
    asset: { type: "string", enum: ["MON"] },
    amountRaw: { type: "string" },
    reason: { type: "string" },
    expectedOutcome: { type: "string" },
    factIds: { type: "array", items: { type: "string" } },
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
  extraFacts?: readonly TreasuryWorldFact[];
};

export function treasuryWorldFacts(roster: readonly TreasuryRosterEntry[], facts: TreasuryPromptFacts): TreasuryWorldFact[] {
  const rows: TreasuryWorldFact[] = [
    {
      id: "bank:mon",
      kind: "balance",
      tokenId: null,
      summary: `ChogBank MON balance is ${formatTokenAmount(facts.monBalance.toString(10), 18, "MON")}.`,
    },
  ];
  for (const citizen of roster) {
    rows.push({
      id: `citizen:${citizen.tokenId}:wallet`,
      kind: "wallet",
      tokenId: citizen.tokenId,
      summary: `Chog #${citizen.tokenId} has a deployed citizen wallet in this review.`,
    });
    if (citizen.goal?.trim()) {
      rows.push({
        id: `citizen:${citizen.tokenId}:goal`,
        kind: "goal",
        tokenId: citizen.tokenId,
        summary: `Chog #${citizen.tokenId} stored goal: ${citizen.goal.trim().slice(0, 120)}.`,
      });
    }
    const spent = facts.citizenSpentMon?.get(citizen.tokenId);
    if (spent != null) {
      rows.push({
        id: `citizen:${citizen.tokenId}:spent`,
        kind: "spent",
        tokenId: citizen.tokenId,
        summary: `Chog #${citizen.tokenId} has been paid ${formatTokenAmount(spent.toString(10), 18, "MON")} from ChogBank in this window.`,
      });
    }
  }
  for (const extra of facts.extraFacts ?? []) {
    if (!FACT_ID.test(extra.id) || rows.some((row) => row.id === extra.id)) continue;
    const summary = extra.summary.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!summary || /https?:\/\//i.test(summary)) continue;
    rows.push({ id: extra.id, kind: extra.kind, summary, tokenId: extra.tokenId });
  }
  return rows;
}

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
    "Fields are tokenId, asset, amountRaw, reason, expectedOutcome, and factIds.",
    "asset must be MON.",
    `The deployed $CHOG cap is ${facts.chogCap.toString(10)} wei. $CHOG is not available for a payout at that cap.`,
    "amountRaw is an integer string of MON wei, greater than 0.",
    `amountRaw must be at most ${room.toString(10)}, which is the smaller of the contract per-transaction cap, the remaining aggregate capacity, and the live MON balance.`,
    "factIds must be copied from facts. Cite at least one fact for the citizen, a project, or a shortage. Do not invent a fact id.",
    "Use a stored goal, town need, or project when one is listed.",
    "Do not name an address, a contract, a recipient, or an NFT holder.",
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
    facts: treasuryWorldFacts(roster, facts).map((fact) => ({ id: fact.id, summary: fact.summary })),
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
): { ok: true; draft: GroundedAllocation | null; reason: string } | { ok: false; reason: string } {
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
  const factIds = factIdList(body.factIds);
  if (!factIds) return { ok: false, reason: "factIds must be an array of stored fact ids." };
  const named = reason.match(/#([0-9]+)/g) ?? [];
  if (named.some((match) => match.slice(1) !== tokenId)) {
    return { ok: false, reason: "The reason names a citizen who is not the recipient." };
  }
  return {
    ok: true,
    draft: { tokenId, asset: body.asset, amountRaw: BigInt(amountRaw), reason, expectedOutcome, factIds },
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
  extraFacts?: readonly TreasuryWorldFact[];
}): { verdict: AllocationVerdict; draft: GroundedAllocation | null; factSummaries: string[] } {
  const eligible = new Set(input.roster.map((citizen) => citizen.tokenId));
  const parsed = parseTreasuryProposal(input.text, eligible);
  if (!parsed.ok) {
    return {
      draft: null,
      factSummaries: [],
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
      factSummaries: [],
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
  const knownFacts =
    input.monBalance == null
      ? []
      : treasuryWorldFacts(input.roster, {
          monBalance: input.monBalance,
          monPerTx: CHAIN_MON_PER_TX,
          monCitizen: CHAIN_MON_CITIZEN,
          monAggregate: CHAIN_MON_AGGREGATE,
          monSpentInWindow: input.observedWindowSpent ?? 0n,
          chogCap: CHAIN_CHOG_CAP,
          citizenSpentMon: input.citizenSpentMon,
          extraFacts: input.extraFacts,
        });
  const grounded = input.monBalance == null ? null : citationProblem(parsed.draft, knownFacts);
  if (grounded) {
    return {
      draft: null,
      factSummaries: [],
      verdict: {
        status: "rejected",
        reason: grounded,
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
  const factSummaries = knownFacts.filter((fact) => draft.factIds.includes(fact.id)).map((fact) => fact.summary);
  const observedCitizenSpent = input.citizenSpentMon?.get(draft.tokenId);
  if (input.citizenSpentMon && observedCitizenSpent == null) {
    return {
      draft,
      factSummaries,
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
      factSummaries,
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
  return { draft, factSummaries, verdict };
}

function citationProblem(draft: GroundedAllocation, facts: readonly TreasuryWorldFact[]): string | null {
  if (draft.factIds.length === 0) return "The payout did not cite a stored world fact.";
  const known = new Map(facts.map((fact) => [fact.id, fact]));
  const cited: TreasuryWorldFact[] = [];
  for (const id of draft.factIds) {
    const fact = known.get(id);
    if (!fact) return "The payout cited a world fact that was not in this review.";
    cited.push(fact);
  }
  const supports = cited.some((fact) => fact.tokenId === draft.tokenId || fact.kind === "need" || fact.kind === "project" || fact.kind === "event");
  return supports ? null : "The payout did not cite that citizen, a project, or a shortage.";
}

function factIdList(value: unknown): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !FACT_ID.test(item) || ids.includes(item)) return null;
    ids.push(item);
  }
  return ids;
}

function amountRawText(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}
