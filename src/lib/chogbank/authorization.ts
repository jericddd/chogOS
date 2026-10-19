import { getAddress, type Address, type Hex } from "viem";
import { sessionTransferRace } from "@/lib/chogbank/session-race";
import type { SessionPolicy, TransferLog } from "@/lib/chogbank/types";

export type SessionCheck =
  | { ok: true }
  | { ok: false; reason: string; mustInvalidate: boolean };

/**
 * Off-chain model of the refused V1.1 session policy.
 * It is not the V2 wallet lock. V2 allows executeSession only while the
 * permanent wallet holds the NFT and the session epoch still matches.
 * This function refuses every session, including a healthy watcher and an
 * empty transfer list.
 */
export function evaluateSessionExecution(input: {
  session: SessionPolicy;
  currentOwner: Address;
  executor: Address;
  target: Address;
  selector: Hex;
  valueWei: bigint;
  expectedNonce: bigint;
  now: number;
  transfersAfterOpen: TransferLog[];
}): SessionCheck {
  if (input.session.dead || input.session.paused) {
    return { ok: false, reason: "session is dead or paused", mustInvalidate: false };
  }
  if (getAddress(input.executor) !== getAddress(input.session.executor)) {
    return { ok: false, reason: "unauthorized executor", mustInvalidate: false };
  }
  if (input.now >= input.session.expiresAt) {
    return { ok: false, reason: "session expired", mustInvalidate: false };
  }
  if (getAddress(input.currentOwner) !== getAddress(input.session.ownerAtOpen)) {
    return { ok: false, reason: "nft owner changed", mustInvalidate: true };
  }
  if (input.transfersAfterOpen.length > 0) {
    return { ok: false, reason: "nft transferred after the session opened", mustInvalidate: true };
  }
  if (input.expectedNonce !== input.session.nonce) {
    return { ok: false, reason: "replay", mustInvalidate: false };
  }
  if (getAddress(input.target) !== getAddress(input.session.target)) {
    return { ok: false, reason: "target not allowed", mustInvalidate: false };
  }
  if (input.selector.toLowerCase() !== input.session.selector.toLowerCase()) {
    return { ok: false, reason: "selector not allowed", mustInvalidate: false };
  }
  if (input.valueWei > input.session.maxValuePerCall) {
    return { ok: false, reason: "value not allowed", mustInvalidate: false };
  }
  if (input.session.spent + input.valueWei > input.session.maxCumulativeValue) {
    return { ok: false, reason: "spend limit", mustInvalidate: false };
  }
  return { ok: false, reason: sessionTransferRace.executionRefused, mustInvalidate: false };
}

export function considerWalletActivation(input: {
  hasActiveWallet: boolean;
  motive: string | null;
  hasConcreteOnchainPlan: boolean;
}): "unnecessary" | "eligible_to_request" {
  if (input.hasActiveWallet) {
    return "unnecessary";
  }
  if (!input.motive || !input.hasConcreteOnchainPlan) {
    return "unnecessary";
  }
  return "eligible_to_request";
}
