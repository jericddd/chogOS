"use client";

import { useState, useTransition } from "react";
import { recordCitizenWallets } from "@/app/treasury/actions";

export function RecordWallets({ locked }: { locked: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (locked) {
    return (
      <p className="text-sm leading-6 text-muted">
        Wallet recording is locked with SYNC_SECRET. POST /api/sync/genesis records one unassigned wallet row
        per persisted citizen. It does not deploy a wallet.
      </p>
    );
  }

  return (
    <form
      action={() => {
        startTransition(async () => {
          const result = await recordCitizenWallets();
          setMessage(
            result.ok
              ? `Wallet records created ${result.created}, already present ${result.unchanged}. No address was predicted or deployed.`
              : result.error,
          );
        });
      }}
      className="space-y-3"
    >
      <button
        type="submit"
        disabled={pending}
        className="rounded-full border border-line px-4 py-2 text-sm hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record wallet assignments"}
      </button>
      {message ? <p className="text-sm leading-6 text-muted">{message}</p> : null}
    </form>
  );
}
