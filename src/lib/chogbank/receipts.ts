import type { Hex } from "viem";
import { reconcileReservation } from "@/lib/chogbank/ledger";
import type { Reservation, SponsoredJob } from "@/lib/chogbank/types";

export type ReceiptObservation =
  | { state: "success"; txHash: Hex; gasUsedWei: bigint }
  | { state: "reverted"; txHash: Hex; gasUsedWei: bigint }
  | { state: "unknown"; txHash: Hex | null };

export type ReceiptReconciliation = {
  job: SponsoredJob;
  reservation: Reservation | null;
  spendWei: bigint;
  duplicate: boolean;
  ambiguous: boolean;
};

/** Apply one receipt. A second success for the same hash does not spend again. */
export function reconcileReceipt(input: {
  job: SponsoredJob;
  reservation: Reservation | null;
  receipt: ReceiptObservation;
}): ReceiptReconciliation {
  if (input.receipt.state !== "unknown" && input.job.txHash && input.job.txHash.toLowerCase() !== input.receipt.txHash.toLowerCase()) {
    return {
      job: input.job,
      reservation: input.reservation,
      spendWei: 0n,
      duplicate: false,
      ambiguous: true,
    };
  }
  if (
    input.receipt.state === "success" &&
    input.job.state === "confirmed" &&
    input.job.txHash &&
    input.job.txHash.toLowerCase() === input.receipt.txHash.toLowerCase()
  ) {
    return { job: input.job, reservation: input.reservation, spendWei: 0n, duplicate: true, ambiguous: false };
  }
  if (input.receipt.state === "unknown") {
    return {
      job: { ...input.job, state: input.job.state === "queued" ? "submitted" : input.job.state, txHash: input.receipt.txHash ?? input.job.txHash },
      reservation: input.reservation,
      spendWei: 0n,
      duplicate: false,
      ambiguous: false,
    };
  }
  if (input.receipt.state === "reverted") {
    const released = input.reservation
      ? reconcileReservation({ held: input.reservation, actualWei: 0n, success: false }).reservation
      : null;
    return {
      job: {
        ...input.job,
        state: "reverted",
        txHash: input.receipt.txHash,
        gasUsedWei: input.receipt.gasUsedWei,
        failureReason: "transaction reverted",
      },
      reservation: released,
      spendWei: 0n,
      duplicate: false,
      ambiguous: false,
    };
  }
  const settled = input.reservation
    ? reconcileReservation({ held: input.reservation, actualWei: input.receipt.gasUsedWei, success: true })
    : null;
  return {
    job: {
      ...input.job,
      state: "confirmed",
      txHash: input.receipt.txHash,
      gasUsedWei: input.receipt.gasUsedWei,
      failureReason: null,
    },
    reservation: settled?.reservation ?? input.reservation,
    spendWei: settled?.spentWei ?? 0n,
    duplicate: false,
    ambiguous: false,
  };
}
