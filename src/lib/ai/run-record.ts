import { explorerTxUrl } from "@/lib/blockchain/explorer";
import { confirmedDecisionReceipt } from "@/lib/ai/mind-receipt";

/** Written when a run passes its budget check and before model work starts. */
export const AI_RUN_STARTED = "AI run started. This record is not a finished decision cycle.";

/** Written when the host deadline wins before the decision cycle finishes. */
export const AI_RUN_INTERRUPTED =
  "AI run interrupted. Work was still unfinished at the host deadline. This is not a completed decision cycle.";

export const AI_RUN_FAILED_PREFIX = "AI run failed.";

export function completedWithProposals(reason?: string | null): string {
  const detail = reason?.trim();
  return detail ? `AI run completed with proposals. ${detail}` : "AI run completed with proposals.";
}

export function completedWithNoDecisions(reason?: string | null): string {
  const detail = reason?.trim();
  return detail ? `AI run completed with no decisions. ${detail}` : "AI run completed with no decisions.";
}

export type MindReportSnapshot = {
  status: string;
  provider: string;
  model: string | null;
  reason?: string;
  claimed: number;
  inferred: number;
  submitted: number;
  constructed: number;
  rejected: number;
  decisions: Array<{ tokenId: string; status: string; detail: string }>;
  treasury?: { status: string; detail: string };
  walletIssuance?: { status: string; detail: string };
  commerce?: { status: string; detail: string };
};

/** A copy the in-flight run cannot mutate after the host deadline wins. */
export function interruptedMindReport<T extends MindReportSnapshot>(report: T): T {
  return {
    ...report,
    status: "interrupted",
    reason: AI_RUN_INTERRUPTED,
    decisions: report.decisions.map((item) => ({ ...item })),
    treasury: report.treasury ? { ...report.treasury } : undefined,
    walletIssuance: report.walletIssuance ? { ...report.walletIssuance } : undefined,
    commerce: report.commerce ? { ...report.commerce } : undefined,
  };
}

function reviewStored(status: string | undefined): boolean {
  return Boolean(status) && status !== "skipped";
}

/** True when this cycle persisted or counted a real proposal. A skipped review does not count. */
export function producedDecisions(report: Pick<MindReportSnapshot, "inferred" | "submitted" | "constructed" | "rejected" | "decisions" | "treasury" | "walletIssuance" | "commerce">): boolean {
  if (report.inferred > 0 || report.submitted > 0 || report.constructed > 0 || report.rejected > 0) return true;
  if (report.decisions.some((item) => item.status !== "deferred" && item.status !== "skipped")) return true;
  return reviewStored(report.treasury?.status) || reviewStored(report.walletIssuance?.status) || reviewStored(report.commerce?.status);
}

/** Durable scheduler note for a cycle that actually returned. */
export function aiRunFinishNote(report: MindReportSnapshot): string {
  if (report.status === "interrupted") return AI_RUN_INTERRUPTED;
  if (report.status === "error") {
    const detail = report.reason?.trim();
    if (detail?.startsWith(AI_RUN_FAILED_PREFIX)) return detail;
    return `${AI_RUN_FAILED_PREFIX} ${detail || "The AI runner failed."}`;
  }
  if (report.status === "halted" || report.status === "budget") {
    return report.reason?.trim() || "The AI run stopped before a decision cycle finished.";
  }
  const reason = report.reason?.trim();
  if (reason?.startsWith("AI run completed with proposals.") || reason?.startsWith("AI run completed with no decisions.")) {
    return reason;
  }
  return producedDecisions(report) ? completedWithProposals(reason) : completedWithNoDecisions(reason);
}

export type AiRunState =
  | "unconfigured"
  | "unread"
  | "not_recorded"
  | "started"
  | "interrupted"
  | "halted"
  | "completed_with_proposals"
  | "completed_without_decisions"
  | "failed"
  | "noted";

export type StoredDecisionView = {
  id: string;
  statusLabel: string;
  summary: string;
  rationale: string | null;
  createdAt: string | null;
  txUrl: string | null;
  /** Present when the stored output names a token. Absent otherwise. */
  tokenId: string | null;
  /** Present when the stored output names a citizen action. Absent otherwise. */
  action: string | null;
};

export type AiRunView = {
  state: AiRunState;
  title: string;
  detail: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  latestDecisionAt: string | null;
  decision: StoredDecisionView | null;
  /**
   * Recent citizen-turn rows. The newest row of any purpose can be a later
   * wallet proposal, so these stay visible beside that row.
   */
  citizenDecisions: StoredDecisionView[];
};

export type SchedulerRecord = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  haltUntil: string | null;
  haltReason: string | null;
};

export type StoredDecisionRecord = {
  id: string;
  status: string;
  purpose: string;
  rationale: string | null;
  output: unknown;
  createdAt: string | null;
};

function outputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function decisionStatus(status: string, confirmed: boolean): { statusLabel: string; summary: string } {
  switch (status) {
    case "draft":
      return { statusLabel: "Proposal not finished", summary: "Proposal not finished." };
    case "proposed":
    case "accepted":
      return { statusLabel: "Proposal persisted", summary: "Proposal persisted." };
    case "rejected":
      return { statusLabel: "Proposal rejected", summary: "Proposal rejected." };
    case "failed":
      return { statusLabel: "Proposal failed", summary: "Proposal failed." };
    case "queued":
      return { statusLabel: "Proposal submitted to the simulation", summary: "Proposal submitted to the simulation." };
    case "deferred":
      return { statusLabel: "Proposal deferred", summary: "Proposal deferred." };
    case "executed":
      return confirmed
        ? { statusLabel: "Confirmed on-chain action", summary: "Confirmed on-chain action." }
        : { statusLabel: "Action recorded", summary: "Action recorded. This is not a chain receipt." };
    default:
      return { statusLabel: "Stored decision", summary: `Stored status: ${status}.` };
  }
}

function citizenIdentity(output: Record<string, unknown> | null): { tokenId: string | null; action: string | null } {
  const rawToken =
    output && (typeof output.tokenId === "string" || typeof output.tokenId === "number")
      ? String(output.tokenId).split(".")[0]
      : "";
  const rawAction = output && typeof output.action === "string" ? output.action.trim() : "";
  return {
    tokenId: /^[0-9]{1,78}$/.test(rawToken) ? rawToken : null,
    action: /^[a-z_]{1,32}$/.test(rawAction) ? rawAction : null,
  };
}

/** Labels one stored decision. A proposal is never called executed. A transaction link requires a verified receipt. */
export function describeStoredDecision(row: StoredDecisionRecord): StoredDecisionView {
  const output = outputRecord(row.output);
  const receipt = confirmedDecisionReceipt(row.purpose, output);
  const txUrl = receipt ? explorerTxUrl(143, receipt.txHash) : null;
  const labeled = decisionStatus(row.status, Boolean(receipt && txUrl));
  const identity = citizenIdentity(output);
  return {
    id: row.id,
    statusLabel: labeled.statusLabel,
    summary: receipt && txUrl ? receipt.reason : labeled.summary,
    rationale: row.rationale,
    createdAt: row.createdAt,
    txUrl,
    tokenId: identity.tokenId,
    action: identity.action,
  };
}

/** How many citizen-turn rows the panel keeps. Newer wallet rows do not count against this. */
export const AI_CITIZEN_PANEL_LIMIT = 8;

const CITIZEN_PANEL_STATUSES = new Set(["queued", "accepted", "proposed", "executed", "rejected", "failed"]);

function visibleCitizenDecisions(rows: readonly StoredDecisionRecord[] | undefined): StoredDecisionView[] {
  const seen = new Set<string>();
  const views: StoredDecisionView[] = [];
  for (const row of rows ?? []) {
    if (row.purpose !== "citizen_turn" || !CITIZEN_PANEL_STATUSES.has(row.status)) continue;
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    views.push(describeStoredDecision(row));
    if (views.length >= AI_CITIZEN_PANEL_LIMIT) break;
  }
  return views;
}

function view(
  partial: Omit<AiRunView, "decision" | "latestDecisionAt" | "citizenDecisions"> & {
    decision: StoredDecisionRecord | null;
    citizenDecisions?: readonly StoredDecisionRecord[];
  },
): AiRunView {
  const decision = partial.decision ? describeStoredDecision(partial.decision) : null;
  return {
    state: partial.state,
    title: partial.title,
    detail: partial.detail,
    lastRunAt: partial.lastRunAt,
    lastSuccessAt: partial.lastSuccessAt,
    latestDecisionAt: decision?.createdAt ?? null,
    decision,
    citizenDecisions: visibleCitizenDecisions(partial.citizenDecisions),
  };
}

/**
 * Turns the scheduler row, the newest decision, and recent citizen turns into the sentences the site can show.
 * Older notes stay verbatim. Only the explicit prefixes above are classified.
 * An interrupted later run does not drop the citizen turns passed in.
 */
export function describeAiRun(input: {
  configured: boolean;
  readable: boolean;
  scheduler: SchedulerRecord | null;
  decision: StoredDecisionRecord | null;
  citizenDecisions?: readonly StoredDecisionRecord[];
  nowMs?: number;
}): AiRunView {
  const decision = input.decision;
  function shown(partial: Omit<Parameters<typeof view>[0], "citizenDecisions">): AiRunView {
    return view({
      ...partial,
      citizenDecisions: input.configured && input.readable ? input.citizenDecisions : [],
    });
  }
  if (!input.configured) {
    return shown({
      state: "unconfigured",
      title: "AI run record unavailable",
      detail: "The AI run record is not connected to its database.",
      lastRunAt: null,
      lastSuccessAt: null,
      decision,
    });
  }
  if (!input.readable) {
    return shown({
      state: "unread",
      title: "AI run record unavailable",
      detail: "The AI run record could not be read.",
      lastRunAt: null,
      lastSuccessAt: null,
      decision: null,
    });
  }

  const scheduler = input.scheduler;
  const lastRunAt = scheduler?.lastRunAt ?? null;
  const lastSuccessAt = scheduler?.lastSuccessAt ?? null;
  const lastError = scheduler?.lastError ?? null;
  const haltUntil = scheduler?.haltUntil ? Date.parse(scheduler.haltUntil) : Number.NaN;
  const halted = Number.isFinite(haltUntil) && haltUntil > (input.nowMs ?? Date.now());
  if (halted) {
    return shown({
      state: "halted",
      title: "AI run halted",
      detail: scheduler?.haltReason?.trim() || "The mind is halted. No halt reason was stored.",
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }

  const hasRun = Boolean(lastRunAt || lastSuccessAt || lastError);
  if (!hasRun && !decision) {
    return shown({
      state: "not_recorded",
      title: "No AI run recorded",
      detail: "No AI run has been recorded.",
      lastRunAt: null,
      lastSuccessAt: null,
      decision: null,
    });
  }
  if (!hasRun && decision) {
    return shown({
      state: "noted",
      title: "No AI run record",
      detail: "The scheduler has no stored run. The newest stored decision is shown below.",
      lastRunAt: null,
      lastSuccessAt: null,
      decision,
    });
  }

  if (lastError === AI_RUN_STARTED) {
    return shown({
      state: "started",
      title: "AI run started",
      detail: AI_RUN_STARTED,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  if (lastError === AI_RUN_INTERRUPTED || lastError?.startsWith("AI run interrupted.")) {
    return shown({
      state: "interrupted",
      title: "AI run interrupted",
      detail: lastError,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  if (lastError?.startsWith("AI run completed with proposals.")) {
    return shown({
      state: "completed_with_proposals",
      title: "AI run completed with proposals",
      detail: lastError,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  if (lastError?.startsWith("AI run completed with no decisions.")) {
    return shown({
      state: "completed_without_decisions",
      title: "AI run completed with no decisions",
      detail: lastError,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  if (lastError?.startsWith(AI_RUN_FAILED_PREFIX)) {
    return shown({
      state: "failed",
      title: "AI run failed",
      detail: lastError,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  if (lastError) {
    return shown({
      state: "noted",
      title: "Stored run note",
      detail: lastError,
      lastRunAt,
      lastSuccessAt,
      decision,
    });
  }
  return shown({
    state: "noted",
    title: "Stored run note",
    detail: "The last run did not store a note.",
    lastRunAt,
    lastSuccessAt,
    decision,
  });
}
