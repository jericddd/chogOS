import type { LedgerBucket, Reservation } from "@/lib/chogbank/types";

export function heldWei(rows: Reservation[], bucket?: Reservation["bucket"]): bigint {
  return rows
    .filter((row) => row.state === "held" && (bucket ? row.bucket === bucket : true))
    .reduce((sum, row) => sum + row.amountWei, 0n);
}

export function reconcileReservation(input: {
  held: Reservation;
  actualWei: bigint;
  success: boolean;
}): { reservation: Reservation; spentWei: bigint; releasedWei: bigint } {
  if (input.held.state !== "held") {
    return { reservation: input.held, spentWei: 0n, releasedWei: 0n };
  }
  if (!input.success) {
    return {
      reservation: { ...input.held, state: "released" },
      spentWei: 0n,
      releasedWei: input.held.amountWei,
    };
  }
  const spent = input.actualWei < input.held.amountWei ? input.actualWei : input.held.amountWei;
  const released = input.held.amountWei > spent ? input.held.amountWei - spent : 0n;
  return {
    reservation: { ...input.held, state: "reconciled" },
    spentWei: spent,
    releasedWei: released,
  };
}

export function bucketForReservation(bucket: Reservation["bucket"]): LedgerBucket {
  if (bucket === "deployment") {
    return "deployment_spent";
  }
  if (bucket === "business_capital") {
    return "outstanding_capital";
  }
  return "sponsored_gas_spent";
}
