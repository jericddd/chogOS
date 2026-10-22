import { CHAIN_CHOG_CAP, CHAIN_MON_AGGREGATE, CHAIN_MON_CITIZEN, CHAIN_MON_PER_TX } from "@/lib/chogbank/bank";
import { APPLICATION_TREASURY_LIMITS, evaluateProductionTreasuryAllocation, type AllocationDraft, type AllocationVerdict, type SpendRecord } from "@/lib/economy/treasury-policy";

export type TreasuryRosterEntry = {
  tokenId: string;
  name: string;
  goal: string | null;
  /** Database id. It is never sent to the model. */
  citizenId?: string;
};

const FORBIDDEN_KEYS = new Set(["recipient", "to", "target", "address", "wallet", "owner"]);

export function treasuryMessages(roster: readonly TreasuryRosterEntry[]): { system: string; user: string } {
  const system = [
    "You propose at most one treasury allocation for one citizen in the list.",
    "Return JSON only.",
    "Fields are tokenId, asset, amountRaw, reason, and expectedOutcome.",
    "asset is MON or CHOG.",
    "amountRaw is an integer string of base units. MON uses wei.",
    `MON amountRaw must be at most ${CHAIN_MON_PER_TX.toString(10)}. CHOG amountRaw must be ${CHAIN_CHOG_CAP.toString(10)}.`,
    "Do not name an address, a contract, a recipient, or a spending cap.",
    "A proposal is not a payment. The server can reject it. An accepted MON allocation can be broadcast later by a signer that is not this model.",
    "If nobody should receive funds, return {\"allocate\":false,\"reason\":\"why\"}.",
  ].join(" ");
  const user = JSON.stringify({
    citizens: roster.map((citizen) => ({
      tokenId: citizen.tokenId,
      name: citizen.name,
      goal: citizen.goal,
    })),
  });
  return { system, user };
}

export function parseTreasuryProposal(
  text: string,
  eligibleTokenIds: ReadonlySet<string>,
): { ok: true; draft: AllocationDraft | null; reason: string } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "The treasury proposal was not JSON." };
  }
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
  if (body.asset !== "MON" && body.asset !== "CHOG") {
    return { ok: false, reason: "The asset must be MON or CHOG." };
  }
  if (typeof body.amountRaw !== "string" || !/^[0-9]+$/.test(body.amountRaw)) {
    return { ok: false, reason: "amountRaw must be a base-unit integer string." };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 320) : "";
  const expectedOutcome = typeof body.expectedOutcome === "string" ? body.expectedOutcome.trim().slice(0, 240) : "";
  if (!reason || !expectedOutcome || /https?:\/\//i.test(`${reason} ${expectedOutcome}`)) {
    return { ok: false, reason: "The reason and expected outcome must be present and must not contain a URL." };
  }
  return {
    ok: true,
    draft: { tokenId, asset: body.asset, amountRaw: BigInt(body.amountRaw), reason, expectedOutcome },
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
  const draft =
    parsed.draft.asset === "MON" && parsed.draft.amountRaw > CHAIN_MON_PER_TX
      ? { ...parsed.draft, amountRaw: CHAIN_MON_PER_TX }
      : parsed.draft.asset === "CHOG" && parsed.draft.amountRaw > CHAIN_CHOG_CAP
        ? { ...parsed.draft, amountRaw: CHAIN_CHOG_CAP }
        : parsed.draft;
  return {
    draft,
    verdict: evaluateProductionTreasuryAllocation({
      draft,
      limits: {
        ...APPLICATION_TREASURY_LIMITS,
        maxPerTxMon: CHAIN_MON_PER_TX,
        maxCitizenWindowMon: CHAIN_MON_CITIZEN,
        maxAggregateWindowMon: CHAIN_MON_AGGREGATE,
      },
      nowMs: input.nowMs,
      eligibleTokenIds: eligible,
      spent: input.spent,
      monBalance: input.monBalance,
      chogBalance: input.chogBalance,
      chogDecimals: input.chogDecimals,
    }),
  };
}
