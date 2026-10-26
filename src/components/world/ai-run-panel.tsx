import { formatUtc } from "@/lib/civilization/labels";
import type { AiRunView } from "@/lib/ai/run-record";

/** Stored AI run and the newest decision. Simulation rows stay in the activity list. */
export function AiRunPanel({ run, compact = false }: { run: AiRunView; compact?: boolean }) {
  const decision = run.decision;
  return (
    <section
      aria-label="AI run status"
      data-ai-run={run.state}
      className={
        compact
          ? "shrink-0 border-b-4 border-line px-2.5 py-2"
          : "mb-4 rounded-2xl border border-violet/40 bg-card px-4 py-4 sm:px-5"
      }
    >
      <p className={compact ? "font-display text-[0.55rem] leading-4 text-violet" : "text-xs tracking-[0.16em] text-violet uppercase"}>
        AI decision activity
      </p>
      <h2 className={compact ? "font-display text-[0.62rem] leading-4 text-foreground" : "mt-1 font-serif text-2xl tracking-tight"}>{run.title}</h2>
      <p className={compact ? "mt-1 line-clamp-3 text-xs leading-4 text-muted" : "mt-2 text-sm leading-6 text-muted"}>{run.detail}</p>
      <p className={compact ? "mt-1 text-xs leading-4 text-muted" : "mt-2 text-sm text-muted"}>
        Latest successful run: {formatUtc(run.lastSuccessAt)}
      </p>
      <p className={compact ? "text-xs leading-4 text-muted" : "text-sm text-muted"}>Latest run: {formatUtc(run.lastRunAt)}</p>
      <p className={compact ? "text-xs leading-4 text-muted" : "text-sm text-muted"}>
        Most recent decision: {formatUtc(run.latestDecisionAt)}
      </p>
      {decision ? (
        <div className={compact ? "mt-1" : "mt-3"}>
          <p className={compact ? "text-xs leading-4 text-foreground" : "text-sm text-foreground"}>{decision.statusLabel}</p>
          {decision.summary === `${decision.statusLabel}.` ? null : (
            <p className={compact ? "line-clamp-2 text-xs leading-4 text-muted" : "mt-1 text-sm leading-6 text-muted"}>{decision.summary}</p>
          )}
          <p className={compact ? "line-clamp-2 text-xs leading-4 text-muted" : "mt-1 text-sm leading-6 text-muted"}>
            {decision.rationale ?? "No rationale was stored."}
          </p>
          {decision.txUrl ? (
            <a href={decision.txUrl} target="_blank" rel="noreferrer" className="text-xs text-accent">
              Verified transaction
            </a>
          ) : (
            <p className={compact ? "text-xs leading-4 text-muted" : "mt-1 text-sm text-muted"}>
              No verified transaction is stored for this decision.
            </p>
          )}
        </div>
      ) : (
        <p className={compact ? "mt-1 text-xs leading-4 text-muted" : "mt-3 text-sm text-muted"}>No AI decision is stored.</p>
      )}
      <p className={compact ? "mt-1 line-clamp-3 text-xs leading-4 text-muted" : "mt-3 text-sm leading-6 text-muted"}>
        Rows in the activity list are separate from this record. Simulation rows are rule-based world transitions, not AI decisions.
      </p>
    </section>
  );
}
