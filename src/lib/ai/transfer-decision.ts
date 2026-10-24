import { MAINNET_CHOG_BANK } from "@/lib/chogbank/bank";
import { readModelJson } from "@/lib/ai/model-json";
import { walletControlFollowsNftOwner } from "@/lib/wallets/authority";
import { formatTokenAmount } from "@/lib/wallets/present";

/**
 * Citizen wallet and ChogBank limits for economic proposals.
 * CitizenAccountV3 can send MON only when its immutable agent key signs execute.
 * This application does not sign those calls. ChogBank.distribute remains the
 * only payout path, and it is decided in the treasury review, not here.
 * ChogBank.receive can accept MON. depositChog can pull $CHOG. Neither is broadcast.
 */

export const TRANSFER_DIRECTIONS = ["chogbank_to_citizen", "citizen_to_citizen", "citizen_to_chogbank"] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

export const PUBLIC_TRANSFER_STATES = [
  "proposed",
  "approved_awaiting_execution",
  "submitted_pending",
  "confirmed",
  "failed_execution",
  "deferred",
  "no_allocation",
  "technical_failure",
] as const;
export type PublicTransferState = (typeof PUBLIC_TRANSFER_STATES)[number];

export const TRANSFER_ACTIONS = [
  "pay_for_work",
  "buy_goods",
  "pay_for_service",
  "contribute",
  "fund_project",
  "payout",
  "other",
] as const;
export type TransferAction = (typeof TRANSFER_ACTIONS)[number];

export const CITIZEN_TRANSFER_LIMIT =
  "CitizenAccountV3 can send MON only when the immutable agent key signs that exact execute call. This application does not sign or broadcast citizen transfers. The proposal is not a payment.";

export const CITIZEN_CONTRIBUTION_LIMIT =
  "ChogBank.receive accepts MON and emits Funded. depositChog pulls $CHOG after an allowance. CitizenAccountV3 can call either only with an agent-signed execute. This application does not sign or broadcast that call. A contribution is voluntary. No tax rule is stored.";

export const CHOG_ASSET_LIMIT =
  "The deployed ChogBank $CHOG cap is 1 wei, so $CHOG is not a payout asset. A citizen $CHOG transfer also needs an agent-signed execute. Neither is broadcast.";

export const TRANSFER_UNREADABLE = "The transfer proposal was not JSON.";

const FACT_ID = /^[A-Za-z0-9:._-]{1,96}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKEN = /^[0-9]+$/;
export type TransferFactKind = "balance" | "wallet" | "goal" | "work" | "need" | "project" | "shortage" | "commerce" | "inventory" | "event" | "commitment";

export type TransferFact = {
  id: string;
  kind: TransferFactKind;
  summary: string;
  tokenId: string | null;
};

export type TransferCitizen = {
  tokenId: string;
  citizenId: string;
  name: string;
  wallet: string | null;
  role: string | null;
  activity: string | null;
  workId: string | null;
  goal: string | null;
  /** Null when this citizen's MON balance was not read. */
  monBalanceRaw: string | null;
};

export type PriorTransfer = {
  key: string;
  direction: string;
  senderTokenId: string | null;
  publicState: string;
};

export type TransferWorld = {
  bankAddress: string;
  citizens: TransferCitizen[];
  facts: TransferFact[];
  recordedKeys: string[];
  openDirections: string[];
  gaps: string[];
};

export type TransferWorldInput = {
  citizens: TransferCitizen[];
  needs: ReadonlyArray<{ needType: string; status: string; stock: Partial<Record<"food" | "wood" | "stone" | "tools", number>> }>;
  projects: ReadonlyArray<{ id: string; name: string; status: string; projectType: string; justification: string }>;
  events: ReadonlyArray<{ id: string; kind: string; summary: string; tokenId: string | null }>;
  priors: readonly PriorTransfer[];
  gaps?: readonly string[];
};

export const TRANSFER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["none", "citizen_to_citizen", "citizen_to_chogbank"] },
    action: { type: "string", enum: [...TRANSFER_ACTIONS] },
    senderTokenId: { type: "string" },
    recipientTokenId: { type: "string" },
    amountRaw: { type: "string" },
    asset: { type: "string", enum: ["MON"] },
    explanation: { type: "string" },
    factIds: { type: "array", items: { type: "string" } },
    prerequisites: { type: "array", items: { type: "string" } },
  },
  required: ["direction", "explanation"],
};

const FORBIDDEN_KEYS = new Set([
  "recipient",
  "to",
  "target",
  "address",
  "wallet",
  "owner",
  "holder",
  "nftholder",
  "privatekey",
  "signature",
]);

export function nftHolderAuthorizesSpend(input: { scheme: string; agentBefore: string; agentAfter: string }): boolean {
  return walletControlFollowsNftOwner(input.scheme) || input.agentBefore !== input.agentAfter;
}

export function assembleTransferWorld(input: TransferWorldInput): TransferWorld {
  const facts: TransferFact[] = [];
  const push = (fact: TransferFact) => {
    if (!FACT_ID.test(fact.id) || facts.some((row) => row.id === fact.id)) return;
    const summary = clip(fact.summary, 180);
    if (!summary) return;
    facts.push({ ...fact, summary });
  };
  for (const citizen of input.citizens) {
    if (!TOKEN.test(citizen.tokenId)) continue;
    if (citizen.wallet) {
      push({
        id: `citizen:${citizen.tokenId}:wallet`,
        kind: "wallet",
        tokenId: citizen.tokenId,
        summary: `${label(citizen)} has a verified citizen wallet. The NFT holder is not the signer.`,
      });
    }
    if (citizen.monBalanceRaw != null && TOKEN.test(citizen.monBalanceRaw)) {
      push({
        id: `citizen:${citizen.tokenId}:balance`,
        kind: "balance",
        tokenId: citizen.tokenId,
        summary: `${label(citizen)} MON balance is ${formatTokenAmount(citizen.monBalanceRaw, 18, "MON")}.`,
      });
    }
    if (citizen.role || citizen.activity || citizen.workId) {
      const parts = [
        citizen.role ? `role ${citizen.role}` : null,
        citizen.activity ? `activity ${citizen.activity}` : null,
        citizen.workId ? `work ${citizen.workId}` : null,
      ].filter((part): part is string => Boolean(part));
      push({
        id: `citizen:${citizen.tokenId}:work`,
        kind: "work",
        tokenId: citizen.tokenId,
        summary: `${label(citizen)} ${parts.join(", ")}.`,
      });
    }
    if (citizen.goal) {
      push({
        id: `citizen:${citizen.tokenId}:goal`,
        kind: "goal",
        tokenId: citizen.tokenId,
        summary: `${label(citizen)} stored goal: ${citizen.goal}`,
      });
    }
  }
  for (const need of input.needs) {
    if (need.status !== "active" || !FACT_ID.test(`need:${need.needType}`)) continue;
    const stock = (["food", "wood", "stone", "tools"] as const)
      .flatMap((key) => (typeof need.stock[key] === "number" && Number.isFinite(need.stock[key]) ? [`${key} ${Math.floor(need.stock[key]!)}`] : []));
    push({
      id: `need:${need.needType}`,
      kind: "shortage",
      tokenId: null,
      summary: `Town need ${need.needType} is active.${stock.length > 0 ? ` Storehouse: ${stock.join(", ")}.` : ""}`,
    });
  }
  for (const project of input.projects) {
    if (!["proposed", "active", "blocked"].includes(project.status)) continue;
    push({
      id: `project:${project.id}`,
      kind: "project",
      tokenId: null,
      summary: `Project ${project.name} (${project.projectType}) is ${project.status}. ${project.justification}`,
    });
  }
  for (const event of input.events) {
    push({
      id: `event:${event.id}`,
      kind: "event",
      tokenId: event.tokenId,
      summary: `Previous event ${event.kind}: ${event.summary}`,
    });
  }
  const recordedKeys = input.priors.map((prior) => prior.key).filter((key) => key.length > 0);
  const openDirections = input.priors
    .filter((prior) => prior.publicState === "proposed" || prior.publicState === "approved_awaiting_execution")
    .map((prior) => `${prior.direction}:${prior.senderTokenId ?? "bank"}`);
  return {
    bankAddress: MAINNET_CHOG_BANK,
    citizens: input.citizens.filter((citizen) => TOKEN.test(citizen.tokenId)),
    facts,
    recordedKeys,
    openDirections,
    gaps: [
      "No inventory table was read. Do not invent goods.",
      "No commerce order was read. Do not invent a purchase.",
      "Citizen MON balances are spendable only when a balance fact is present.",
      ...(input.gaps ?? []),
    ].map((gap) => clip(gap, 180)).filter((gap): gap is string => Boolean(gap)),
  };
}

export function transferMessages(world: TransferWorld): { system: string; user: string } {
  return {
    system: [
      "You propose at most one citizen transfer, or no transfer.",
      "Directions are citizen_to_citizen and citizen_to_chogbank.",
      "Do not propose a ChogBank payout. That review is separate.",
      "Use only token ids, fact ids, amounts, and actions from the snapshot.",
      "factIds must be copied from facts. Do not invent a citizen, balance, need, project, purchase, or completed payment.",
      "asset must be MON. amountRaw is an integer string of wei.",
      "A contribution to ChogBank is voluntary. Do not call it a tax.",
      "buy_goods and pay_for_service require a commerce or inventory fact. pay_for_work requires a work or goal fact. contribute and fund_project require a project or shortage fact.",
      "Do not name an address, a wallet, a contract, or an NFT holder.",
      "The proposal is not a transaction. This application does not sign citizen transfers.",
      "If nothing should move, return {\"direction\":\"none\",\"explanation\":\"why\"}.",
      "Return one JSON object.",
    ].join(" "),
    user: JSON.stringify({
      bank: "ChogBank",
      asset: "MON",
      chog: "unavailable",
      gaps: world.gaps,
      facts: world.facts.map((fact) => ({ id: fact.id, summary: fact.summary })),
      citizens: world.citizens.map((citizen) => ({
        tokenId: citizen.tokenId,
        name: citizen.name,
        role: citizen.role,
        activity: citizen.activity,
        workId: citizen.workId,
        goal: citizen.goal,
        monBalanceRaw: citizen.monBalanceRaw,
        walletVerified: citizen.wallet != null,
      })),
    }),
  };
}

export type TransferSettlement = {
  record: boolean;
  purpose: "citizen_trade" | "citizen_return";
  publicState: PublicTransferState;
  citizenId: string | null;
  tokenId: string | null;
  counterpartyTokenId: string | null;
  wallet: string | null;
  recipientWallet: string | null;
  rationale: string;
  fromModel: boolean;
  direction: TransferDirection | null;
  action: string | null;
  amountRaw: string | null;
  asset: "MON" | null;
  factIds: string[];
  factSummaries: string[];
  limitation: string | null;
  idempotencyKey: string;
  executable: false;
  prerequisites: string[];
};

export function blockingTransferReason(world: TransferWorld): string | null {
  if (world.citizens.length === 0) return "No citizen has a verified wallet, so no citizen transfer was proposed.";
  if (!world.citizens.some((citizen) => citizen.monBalanceRaw != null)) {
    return "Citizen MON balances were not read, so no citizen transfer was proposed.";
  }
  const grounded = world.facts.some((fact) => ["work", "goal", "need", "project", "shortage", "commerce", "inventory", "event"].includes(fact.kind));
  if (!grounded) return "No stored work, goal, project, shortage, order, or recent economic event was available, so no citizen transfer was proposed.";
  return null;
}

export function settleTransferText(text: string, world: TransferWorld): TransferSettlement {
  const blocker = blockingTransferReason(world);
  if (blocker) return deferredSettlement(world, blocker, false);
  const parsed = readModelJson(text);
  if (!parsed.ok) return technicalSettlement(world, TRANSFER_UNREADABLE);
  const raw = parsed.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return technicalSettlement(world, "The transfer proposal was not an object.");
  const body = raw as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => FORBIDDEN_KEYS.has(key.toLowerCase()));
  if (forbidden) {
    return technicalSettlement(world, "The proposal named an address, wallet, or NFT holder. An NFT holder cannot authorize a citizen wallet.");
  }
  if (body.direction === "none") {
    const explanation = clip(body.explanation, 320) ?? "The model proposed no transfer.";
    return noAllocation(world, explanation);
  }
  if (body.direction === "chogbank_to_citizen") {
    return deferredSettlement(
      world,
      "ChogBank to citizen payouts are accepted only by the treasury review, which checks caps, the live balance, and a deployed citizen wallet. This review did not create a payout.",
      true,
    );
  }
  if (body.direction !== "citizen_to_citizen" && body.direction !== "citizen_to_chogbank") {
    return technicalSettlement(world, "The transfer direction is not supported.");
  }
  if (body.asset === "CHOG") return deferredSettlement(world, CHOG_ASSET_LIMIT, true);
  if (body.asset != null && body.asset !== "MON") return technicalSettlement(world, "The asset must be MON.");
  const action = typeof body.action === "string" && (TRANSFER_ACTIONS as readonly string[]).includes(body.action) ? (body.action as TransferAction) : null;
  if (!action || action === "payout") return technicalSettlement(world, "The transfer action is not supported for this direction.");
  const sender = citizen(world, tokenText(body.senderTokenId));
  const recipientToken = tokenText(body.recipientTokenId);
  const recipient = body.direction === "citizen_to_citizen" ? citizen(world, recipientToken) : null;
  if (!sender) return deferredSettlement(world, "The sender is not a citizen in this review.", true);
  if (body.direction === "citizen_to_citizen" && !recipient) return deferredSettlement(world, "The recipient is not a citizen in this review.", true, sender);
  if (recipient && recipient.tokenId === sender.tokenId) return deferredSettlement(world, "The sender and recipient are the same citizen.", true, sender);
  const amountRaw = amountText(body.amountRaw);
  if (!amountRaw) return technicalSettlement(world, "amountRaw must be a base-unit integer string.");
  const factIds = factIdList(body.factIds);
  if (!factIds) return technicalSettlement(world, "factIds must be an array of stored fact ids.");
  const known = new Map(world.facts.map((fact) => [fact.id, fact]));
  const cited: TransferFact[] = [];
  for (const id of factIds) {
    const fact = known.get(id);
    if (!fact) return deferredSettlement(world, "The proposal cited a world fact that was not in this review.", true, sender);
    cited.push(fact);
  }
  if (cited.length === 0) return deferredSettlement(world, "The proposal did not cite a stored world fact.", true, sender);
  const support = actionSupport(action, cited);
  if (support) return deferredSettlement(world, support, true, sender);
  if (!sender.wallet) return deferredSettlement(world, `${label(sender)} has no verified citizen wallet, so the transfer was not proposed.`, true, sender);
  if (sender.monBalanceRaw == null) return deferredSettlement(world, `${label(sender)} MON balance was not read, so the transfer was not proposed.`, true, sender);
  let balance: bigint;
  let amount: bigint;
  try {
    balance = BigInt(sender.monBalanceRaw);
    amount = BigInt(amountRaw);
  } catch {
    return technicalSettlement(world, "The amount or balance could not be read.");
  }
  if (amount > balance) {
    return deferredSettlement(
      world,
      `${label(sender)} MON balance is ${formatTokenAmount(sender.monBalanceRaw, 18, "MON")}, which is below the proposed ${formatTokenAmount(amountRaw, 18, "MON")}.`,
      true,
      sender,
    );
  }
  if (body.direction === "citizen_to_citizen" && recipient && !recipient.wallet) {
    return deferredSettlement(world, `${label(recipient)} has no verified citizen wallet, so the transfer was not proposed.`, true, sender);
  }
  if (world.bankAddress.toLowerCase() !== MAINNET_CHOG_BANK.toLowerCase()) {
    return deferredSettlement(world, "The ChogBank destination does not match the pinned deployment, so no contribution was proposed.", true, sender);
  }
  const openKey = `${body.direction}:${sender.tokenId}`;
  const key = transferKey({
    direction: body.direction,
    senderTokenId: sender.tokenId,
    recipientTokenId: recipient?.tokenId ?? null,
    amountRaw,
    factIds,
  });
  if (world.recordedKeys.includes(key) || world.openDirections.includes(openKey)) {
    return {
      ...baseSettlement("deferred", "This transfer is already recorded. No second proposal was stored."),
      record: false,
      citizenId: sender.citizenId,
      tokenId: sender.tokenId,
      idempotencyKey: key,
    };
  }
  const limitation = body.direction === "citizen_to_chogbank" ? CITIZEN_CONTRIBUTION_LIMIT : CITIZEN_TRANSFER_LIMIT;
  const prerequisites = [
    ...textList(body.prerequisites, 3, 120),
    limitation,
  ];
  const explanation = serverExplanation({
    direction: body.direction,
    action,
    sender,
    recipient,
    amountRaw,
    cited,
    limitation,
  });
  return {
    record: true,
    purpose: body.direction === "citizen_to_chogbank" ? "citizen_return" : "citizen_trade",
    publicState: "proposed",
    citizenId: sender.citizenId,
    tokenId: sender.tokenId,
    counterpartyTokenId: recipient?.tokenId ?? null,
    wallet: sender.wallet,
    recipientWallet: body.direction === "citizen_to_chogbank" ? MAINNET_CHOG_BANK : recipient?.wallet ?? null,
    rationale: explanation,
    fromModel: true,
    direction: body.direction,
    action,
    amountRaw,
    asset: "MON",
    factIds,
    factSummaries: cited.map((fact) => fact.summary),
    limitation,
    idempotencyKey: key,
    executable: false,
    prerequisites,
  };
}

export function classifyTransferReceipt(input: {
  expected: { asset: "MON"; amountRaw: string; sender: string; recipient: string };
  receipt: {
    chainId: number;
    txHash: string | null;
    status: "success" | "reverted" | "unknown" | null;
    sender: string | null;
    recipient: string | null;
    amountRaw: string | null;
    asset: string | null;
    /** True only when the expected event log was decoded from the receipt. */
    logMatched: boolean;
  } | null;
}): "confirmed" | "failed_execution" | "submitted_pending" | "not_confirmed" {
  const receipt = input.receipt;
  if (!receipt?.txHash || !HASH.test(receipt.txHash)) return "not_confirmed";
  if (receipt.chainId !== 143) return "failed_execution";
  if (receipt.status == null || receipt.status === "unknown") return "submitted_pending";
  if (receipt.status === "reverted" || !receipt.logMatched) return "failed_execution";
  const same = (left: string | null, right: string) => left != null && left.toLowerCase() === right.toLowerCase();
  if (receipt.asset !== input.expected.asset || receipt.amountRaw !== input.expected.amountRaw) return "failed_execution";
  if (!same(receipt.sender, input.expected.sender) || !same(receipt.recipient, input.expected.recipient)) return "failed_execution";
  return "confirmed";
}

export function treasuryActivityState(status: string, reason: string): PublicTransferState {
  if (status === "accepted_not_executed" || status === "ready_for_signature") return "approved_awaiting_execution";
  if (reason === "The treasury proposal was not JSON." || /not JSON|could not be read|model call failed|was not stored/i.test(reason)) {
    return "technical_failure";
  }
  if (status === "failed") return "technical_failure";
  if (status === "duplicate" || status === "insufficient_funds") return "deferred";
  if (status === "budget_exhausted") return "no_allocation";
  if (/not read|not observed|not in this review|did not cite|No eligible|citizen wallet|not available for a payout|already admitted|already recorded/i.test(reason)) {
    return "deferred";
  }
  if (status === "rejected") return "no_allocation";
  return "deferred";
}

function actionSupport(action: TransferAction, cited: readonly TransferFact[]): string | null {
  const kinds = new Set(cited.map((fact) => fact.kind));
  if (action === "pay_for_work" && !kinds.has("work") && !kinds.has("goal")) {
    return "No stored work or goal fact supports paying for work.";
  }
  if ((action === "buy_goods" || action === "pay_for_service") && !kinds.has("commerce") && !kinds.has("inventory")) {
    return "No stored order, service, or inventory fact supports this purchase. No purchase was recorded.";
  }
  if ((action === "contribute" || action === "fund_project") && !kinds.has("project") && !kinds.has("shortage") && !kinds.has("need")) {
    return "No stored project or shortage supports this contribution. It was not recorded as a tax.";
  }
  if (action === "other" && cited.length === 0) return "The transfer did not cite a stored world fact.";
  return null;
}

function serverExplanation(input: {
  direction: TransferDirection;
  action: string;
  sender: TransferCitizen;
  recipient: TransferCitizen | null;
  amountRaw: string;
  cited: readonly TransferFact[];
  limitation: string;
}): string {
  const amount = formatTokenAmount(input.amountRaw, 18, "MON");
  const route =
    input.direction === "citizen_to_chogbank"
      ? `${label(input.sender)} to ChogBank`
      : `${label(input.sender)} to ${input.recipient ? label(input.recipient) : "the recipient"}`;
  const facts = input.cited.map((fact) => fact.summary).join(" ");
  return clip(`Proposed ${input.action}: ${route}, ${amount}. ${facts} ${input.limitation}`, 500) ?? input.limitation;
}

function deferredSettlement(world: TransferWorld, reason: string, fromModel: boolean, actor?: TransferCitizen | null): TransferSettlement {
  const key = `defer:${compact(reason)}`;
  const citizen = actor ?? world.citizens[0] ?? null;
  return {
    ...baseSettlement("deferred", reason),
    record: !world.recordedKeys.includes(key),
    fromModel,
    idempotencyKey: key,
    citizenId: citizen?.citizenId ?? null,
    tokenId: citizen?.tokenId ?? null,
    wallet: citizen?.wallet ?? null,
  };
}

function technicalSettlement(world: TransferWorld, reason: string): TransferSettlement {
  const key = `technical:${compact(reason)}`;
  return {
    ...baseSettlement("technical_failure", reason),
    record: !world.recordedKeys.includes(key),
    purpose: "citizen_trade",
    idempotencyKey: key,
    citizenId: null,
    tokenId: null,
  };
}

function noAllocation(world: TransferWorld, reason: string): TransferSettlement {
  const key = `none:${compact(reason)}`;
  return {
    ...baseSettlement("no_allocation", reason),
    record: !world.recordedKeys.includes(key),
    fromModel: true,
    idempotencyKey: key,
    citizenId: world.citizens[0]?.citizenId ?? null,
    tokenId: world.citizens[0]?.tokenId ?? null,
  };
}

function baseSettlement(publicState: PublicTransferState, rationale: string): TransferSettlement {
  return {
    record: true,
    purpose: publicState === "proposed" ? "citizen_trade" : "citizen_trade",
    publicState,
    citizenId: null,
    tokenId: null,
    counterpartyTokenId: null,
    wallet: null,
    recipientWallet: null,
    rationale,
    fromModel: false,
    direction: null,
    action: null,
    amountRaw: null,
    asset: null,
    factIds: [],
    factSummaries: [],
    limitation: null,
    idempotencyKey: `state:${publicState}`,
    executable: false,
    prerequisites: [],
  };
}

function transferKey(input: {
  direction: TransferDirection;
  senderTokenId: string;
  recipientTokenId: string | null;
  amountRaw: string;
  factIds: readonly string[];
}): string {
  return [
    input.direction,
    input.senderTokenId,
    input.recipientTokenId ?? "bank",
    input.amountRaw,
    [...input.factIds].sort().join("."),
  ].join(":");
}

function citizen(world: TransferWorld, tokenId: string | null): TransferCitizen | null {
  if (!tokenId) return null;
  return world.citizens.find((row) => row.tokenId === tokenId) ?? null;
}

function label(citizen: TransferCitizen): string {
  const name = clip(citizen.name, 80);
  return name && name.startsWith("Chog #") ? name : `Chog #${citizen.tokenId}`;
}

function tokenText(value: unknown): string | null {
  const tokenId = typeof value === "string" || typeof value === "number" ? String(value).split(".")[0] : "";
  return TOKEN.test(tokenId) ? tokenId : null;
}

function amountText(value: unknown): string | null {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^[0-9]+$/.test(text)) return null;
  try {
    const amount = BigInt(text);
    return amount > 0n ? amount.toString(10) : null;
  } catch {
    return null;
  }
}

function factIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !FACT_ID.test(item) || ids.includes(item)) return null;
    ids.push(item);
  }
  return ids;
}

function textList(value: unknown, limit: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clip(item, length))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function clip(value: unknown, length: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, length);
  if (!text || /https?:\/\//i.test(text)) return null;
  return text;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);
}
