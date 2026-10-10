"use client";

import { useState, useTransition } from "react";
import { refreshGenesisRoster } from "@/app/treasury/actions";
import type { SyncResult } from "@/lib/civilization/sync-genesis";

function summarize(result: SyncResult): string {
  if (result.status === "succeeded") {
    return `Synchronized ${result.verifiedCount} verified NFTs at block ${result.blockNumber}. Created ${result.created}, updated ${result.updated}.`;
  }
  if (result.status === "skipped") {
    return result.reason;
  }
  return result.error;
}

export function RefreshRoster({ locked }: { locked: boolean }) {
  const [state, setState] = useState<SyncResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (locked) {
    return (
      <p className="text-sm leading-6 text-muted">
        Refresh is locked with SYNC_SECRET. Send POST /api/sync/genesis with header Authorization: Bearer and
        that server secret. The secret is not included in this page.
      </p>
    );
  }

  return (
    <form
      action={() => {
        startTransition(async () => {
          setState(await refreshGenesisRoster());
        });
      }}
      className="space-y-3"
    >
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-[#062117] disabled:opacity-60"
      >
        {pending ? "Checking Monad…" : "Refresh founding roster"}
      </button>
      {state ? <p className="text-sm leading-6 text-muted">{summarize(state)}</p> : null}
    </form>
  );
}
