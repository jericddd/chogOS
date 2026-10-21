import { haltFromError } from "@/lib/ai/budget";
import { AiProviderError, type AiCompletion } from "@/lib/ai/types";
import {
  evaluateIssuanceDecision,
  type IssuanceChoice,
  type IssuanceVerdict,
  type WalletLifecycle,
} from "@/lib/wallets/issuance";

export type WalletRosterEntry = {
  tokenId: string;
  name: string;
  goal: string | null;
  lifecycle: WalletLifecycle;
  /** Database id. It is never sent to the model. */
  citizenId?: string;
};

export type WalletIssuanceInsert = {
  purpose: "wallet_issuance";
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
    choice: IssuanceChoice | null;
    tokenId: string | null;
    lifecycle: WalletLifecycle;
    decisionId: string | null;
    duplicate: boolean;
    deploymentPathReady: boolean;
    chainId: 143;
    txHash: null;
    blockNumber: null;
    address: null;
  };
};

export type WalletIssuanceConsideration = {
  status: "skipped" | "proposed" | "rejected" | "failed" | "halt";
  detail: string;
  promptChars: number;
  outputTokens: number;
  halt: { until: string; reason: string } | null;
};

const FORBIDDEN_KEYS = new Set([
  "address",
  "wallet",
  "owner",
  "recipient",
  "to",
  "target",
  "signature",
  "privatekey",
  "private_key",
]);

export function walletIssuanceMessages(roster: readonly WalletRosterEntry[], deploymentPathReady: boolean): { system: string; user: string } {
  const system = [
    "You decide whether one enrolled citizen should be issued a permanent wallet.",
    "Return JSON only.",
    "Fields are choice, tokenId, and rationale.",
    "choice is issue, defer, or unnecessary.",
    "A citizen can live, keep goals, and keep memories with no wallet.",
    "Do not issue a wallet only because the citizen exists.",
    "Do not name an address, a contract, a key, or a signature.",
    "This choice is not a deployment. The server can reject it, and it does not sign or broadcast.",
    "If no citizen needs a wallet now, return {\"choice\":\"unnecessary\",\"tokenId\":null,\"rationale\":\"why\"}.",
  ].join(" ");
  const user = JSON.stringify({
    deploymentPathReady,
    treasuryBalancesRead: false,
    citizens: roster.map((citizen) => ({
      tokenId: citizen.tokenId,
      name: citizen.name,
      goal: citizen.goal,
      wallet: citizen.lifecycle,
    })),
  });
  return { system, user };
}

export function parseWalletIssuance(text: string): { ok: true; choice: IssuanceChoice; tokenId: string | null; rationale: string } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "The wallet decision was not JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The wallet decision was not an object." };
  }
  const body = raw as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => FORBIDDEN_KEYS.has(key.toLowerCase()));
  if (forbidden) {
    return { ok: false, reason: "The model named an address or a key. Only a citizen token id is accepted." };
  }
  if (body.choice !== "issue" && body.choice !== "defer" && body.choice !== "unnecessary") {
    return { ok: false, reason: "choice must be issue, defer, or unnecessary." };
  }
  const rationale = typeof body.rationale === "string" ? body.rationale.trim().slice(0, 320) : "";
  if (!rationale) return { ok: false, reason: "The rationale must be present." };
  if (body.tokenId == null) {
    return { ok: true, choice: body.choice, tokenId: null, rationale };
  }
  const tokenId = typeof body.tokenId === "string" || typeof body.tokenId === "number" ? String(body.tokenId).split(".")[0] : "";
  if (!/^[0-9]+$/.test(tokenId)) return { ok: false, reason: "The token id is not a number." };
  return { ok: true, choice: body.choice, tokenId, rationale };
}

export async function considerWalletIssuance(input: {
  roster: readonly WalletRosterEntry[] | null;
  admittedDecisionIds: ReadonlySet<string> | null;
  deploymentPathReady: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  provider: string;
  model: string;
  complete: (request: { system: string; user: string; timeoutMs: number; maxOutputTokens: number }) => Promise<AiCompletion>;
  record: (row: WalletIssuanceInsert) => Promise<boolean>;
}): Promise<WalletIssuanceConsideration> {
  if (input.roster == null || input.admittedDecisionIds == null) {
    return skipped("failed", "Earlier wallet records could not be read. The model was not called.", 0, 0);
  }
  if (input.roster.length === 0) {
    return skipped("skipped", "No enrolled citizen is eligible, so no wallet was requested.", 0, 0);
  }
  const messages = walletIssuanceMessages(input.roster, input.deploymentPathReady);
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
        : new AiProviderError(error instanceof Error ? error.message : "The wallet model call failed.", "unavailable", false);
    const detail = providerError.message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 240);
    const recorded = await input.record(failureRow(input.provider, input.model, detail));
    if (providerError.halt) {
      return { status: "halt", detail, promptChars: 0, outputTokens: 0, halt: haltFromError(providerError) };
    }
    return skipped("failed", recorded ? detail : "The wallet model call failed and the failure was not recorded.", 0, 0);
  }

  const promptChars = completion.promptChars ?? messages.system.length + messages.user.length;
  const outputTokens = completion.outputTokens ?? 0;
  const parsed = parseWalletIssuance(completion.text);
  const verdict: IssuanceVerdict = parsed.ok
    ? evaluateIssuanceDecision({
        choice: parsed.choice,
        tokenId: parsed.tokenId,
        rationale: parsed.rationale,
        eligibleTokenIds: new Set(input.roster.map((entry) => entry.tokenId)),
        lifecycleByToken: new Map(input.roster.map((entry) => [entry.tokenId, entry.lifecycle])),
        admittedDecisionIds: input.admittedDecisionIds,
        deploymentPathReady: input.deploymentPathReady,
      })
    : {
        status: "rejected",
        choice: null,
        tokenId: null,
        decisionId: null,
        lifecycle: "citizen_active",
        reason: parsed.reason,
        executed: false,
        onchain: false,
        duplicate: false,
      };
  const citizen = input.roster.find((entry) => entry.tokenId === verdict.tokenId);
  const recorded = await input.record(verdictRow(input.provider, input.model, verdict, citizen?.citizenId ?? null, input.deploymentPathReady));
  if (!recorded) {
    return skipped("failed", "The wallet review finished, and the database did not store it. No wallet was created.", promptChars, outputTokens);
  }
  return {
    status: verdict.status,
    detail: verdict.reason,
    promptChars,
    outputTokens,
    halt: null,
  };
}

function skipped(
  status: WalletIssuanceConsideration["status"],
  detail: string,
  promptChars: number,
  outputTokens: number,
): WalletIssuanceConsideration {
  return { status, detail, promptChars, outputTokens, halt: null };
}

function failureRow(provider: string, model: string, rationale: string): WalletIssuanceInsert {
  return {
    purpose: "wallet_issuance",
    status: "failed",
    citizenId: null,
    rationale: rationale.slice(0, 500),
    validationResult: rationale.slice(0, 500),
    inputCommitment: null,
    provider,
    model,
    output: {
      executed: false,
      onchain: false,
      verified: false,
      stage: "failed",
      choice: null,
      tokenId: null,
      lifecycle: "citizen_active",
      decisionId: null,
      duplicate: false,
      deploymentPathReady: false,
      chainId: 143,
      txHash: null,
      blockNumber: null,
      address: null,
    },
  };
}

function verdictRow(
  provider: string,
  model: string,
  verdict: IssuanceVerdict,
  citizenId: string | null,
  deploymentPathReady: boolean,
): WalletIssuanceInsert {
  return {
    purpose: "wallet_issuance",
    status: verdict.status,
    citizenId,
    rationale: verdict.reason.slice(0, 500),
    validationResult: verdict.reason.slice(0, 500),
    inputCommitment: verdict.decisionId,
    provider,
    model,
    output: {
      executed: false,
      onchain: false,
      verified: false,
      stage: verdict.status,
      choice: verdict.choice,
      tokenId: verdict.tokenId,
      lifecycle: verdict.lifecycle,
      decisionId: verdict.decisionId,
      duplicate: verdict.duplicate,
      deploymentPathReady,
      chainId: 143,
      txHash: null,
      blockNumber: null,
      address: null,
    },
  };
}
