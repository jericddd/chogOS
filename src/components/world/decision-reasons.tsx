import Link from "next/link";
import type { CitizenMindView } from "@/lib/ai/mind-view";

export function decisionPurposeLabel(purpose: string): string {
  switch (purpose) {
    case "wallet_issuance":
      return "Creating a wallet";
    case "treasury_allocation":
      return "Sending funds";
    case "citizen_trade":
      return "Trade";
    case "citizen_return":
      return "Return to ChogBank";
    case "citizen_turn":
      return "Citizen turn";
    default:
      return purpose.replaceAll("_", " ");
  }
}

/** Stored mind decisions and the reason written for each one. */
export function DecisionReasons({ decisions }: { decisions: CitizenMindView["decisions"] }) {
  const withReason = decisions.filter((decision) => decision.rationale || decision.summary);
  const shown = (withReason.length > 0 ? withReason : decisions).slice(0, 6);
  if (shown.length === 0) {
    return <p className="mt-2 text-xs text-muted">No AI decision has been stored for this citizen.</p>;
  }
  return (
    <ul className="mt-2 space-y-2">
      {shown.map((decision) => (
        <li key={decision.id} className="text-xs leading-5">
          <p className="text-muted">
            {decisionPurposeLabel(decision.purpose)} · {decision.status}
          </p>
          {decision.rationale || decision.summary ? (
            <p className="text-foreground/90">{decision.rationale ?? decision.summary}</p>
          ) : (
            <p className="text-muted">No reason was stored.</p>
          )}
          {decision.outcomeEventId ? (
            <Link href={`/verify/events/${decision.outcomeEventId}`} className="text-accent hover:underline">
              Verify
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
