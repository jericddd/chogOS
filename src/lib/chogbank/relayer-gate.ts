import { sessionTransferRace } from "@/lib/chogbank/session-race";
import { RELAYER_OPS, type RelayerOp } from "@/lib/chogbank/types";
import type { ProtectedSigner } from "@/lib/chogbank/signer";

export type TxStage = "monitoring" | "simulated" | "prepared" | "submitted" | "confirmed" | "reverted";

export type RelayerGate =
  | { accepted: false; stage: "monitoring"; reason: string }
  | { accepted: true; stage: "prepared" | "simulated"; op: RelayerOp; reason: string };

/**
 * Paying gas does not authorize an arbitrary call.
 * Production signing stays disabled: accepted plans stop at prepared or simulated.
 */
export function gateRelayerOp(input: {
  op: string;
  chainId: number;
  signer: ProtectedSigner;
  mode: "production" | "simulated";
  reservationHeld: boolean;
  treasuryConfigured: boolean;
  preflightOk: boolean;
  preflightReason?: string;
}): RelayerGate {
  if (input.chainId !== 143) {
    return { accepted: false, stage: "monitoring", reason: "wrong chain" };
  }
  if (!(RELAYER_OPS as readonly string[]).includes(input.op)) {
    return { accepted: false, stage: "monitoring", reason: "relayer op is not allowed" };
  }
  if (input.op === "account.executeSession") {
    return { accepted: false, stage: "monitoring", reason: sessionTransferRace.executionRefused };
  }
  if (!input.preflightOk) {
    return { accepted: false, stage: "monitoring", reason: input.preflightReason ?? "preflight failed" };
  }
  if (!input.treasuryConfigured) {
    return { accepted: false, stage: "monitoring", reason: "treasury balance cannot be verified" };
  }
  if (!input.reservationHeld) {
    return { accepted: false, stage: "monitoring", reason: "no treasury reservation" };
  }
  if (input.signer.kind !== "none") {
    return { accepted: false, stage: "monitoring", reason: "unexpected signer kind" };
  }
  if (input.mode === "production") {
    return {
      accepted: false,
      stage: "monitoring",
      reason: input.signer.reason,
    };
  }
  return {
    accepted: true,
    stage: "simulated",
    op: input.op as RelayerOp,
    reason: "simulated relayer only; no transaction is signed or broadcast",
  };
}

export function stageOfJob(input: {
  state: "queued" | "submitted" | "confirmed" | "reverted" | "failed";
  simulated: boolean;
}): TxStage {
  if (input.state === "confirmed") {
    return "confirmed";
  }
  if (input.state === "reverted") {
    return "reverted";
  }
  if (input.state === "submitted") {
    return "submitted";
  }
  if (input.state === "queued" && input.simulated) {
    return "simulated";
  }
  return "monitoring";
}
