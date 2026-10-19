import { getAddress, type Address } from "viem";
import { addresses } from "@/lib/blockchain/addresses";
import type { SessionPolicy, TransferLog } from "@/lib/chogbank/types";
import type { WatcherHealth } from "@/lib/watcher/types";

export type SessionPreflight =
  | { ok: true }
  | { ok: false; invalidate: boolean; reason: string };

/**
 * Offchain check immediately before executeSession.
 * Any transfer after openedBlock refuses execution, including A→B→A.
 * A healthy watcher is not an onchain lock; a transfer in the same block
 * as submission can still win the race.
 */
export function preflightExecuteSession(input: {
  health: WatcherHealth;
  chainId: number;
  nftContract: Address;
  account: Address;
  tokenId: string;
  expectedTokenId: string;
  expectedAccount: Address;
  currentOwner: Address;
  session: SessionPolicy;
  transfersAfterOpen: TransferLog[];
}): SessionPreflight {
  if (input.chainId !== 143) {
    return { ok: false, invalidate: false, reason: "wrong chain" };
  }
  if (getAddress(input.nftContract) !== getAddress(addresses.chogGenesis)) {
    return { ok: false, invalidate: false, reason: "wrong nft" };
  }
  if (getAddress(input.account) !== getAddress(input.expectedAccount)) {
    return { ok: false, invalidate: false, reason: "wrong account" };
  }
  if (!input.health.executionAllowed || input.health.status !== "healthy") {
    return { ok: false, invalidate: false, reason: `watcher is ${input.health.status}` };
  }
  if (input.session.dead || input.session.paused) {
    return { ok: false, invalidate: false, reason: "session is not live" };
  }
  if (input.transfersAfterOpen.length > 0) {
    return { ok: false, invalidate: true, reason: "nft transferred after the session opened" };
  }
  if (getAddress(input.currentOwner) !== getAddress(input.session.ownerAtOpen)) {
    return { ok: false, invalidate: true, reason: "nft owner changed" };
  }
  if (input.tokenId !== input.expectedTokenId) {
    return { ok: false, invalidate: false, reason: "wrong token" };
  }
  return { ok: true };
}
