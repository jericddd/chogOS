import {
  V1_FACTORY_PREDICTED,
  V11_FACTORY_PREDICTED,
  V2_FACTORY_PREDICTED,
  V2_IMPLEMENTATION_PREDICTED,
} from "@/lib/chogbank/factory";

/**
 * V1.1 CitizenAccount.syncOwner returns when ownerOf equals lastSeenOwner.
 * After A→B→A with no account call, ownerOf is A again, so syncOwner does nothing
 * and executeSession still sees currentOwner() == ownerAtOpen.
 *
 * Chog Genesis is an ordinary ERC-721. It has no transfer callback and no
 * ownership nonce. The account cannot read historical Transfer logs.
 * An offchain watcher can queue invalidateSession, but that transaction can
 * land after executeSession, including in the same block. Zero watcher lag
 * does not close that race on V1.1.
 *
 * V2 does not consult a watcher. executeSession is valid only while the
 * permanent proxy holds the NFT and session.epoch equals authEpoch. deposit,
 * release, revoke, and human execute increment authEpoch before their
 * external call. Returning the NFT to the original owner does not restore a
 * retired epoch. The proxy implementation is immutable, so a former owner
 * cannot leave an upgrade behind.
 *
 * V2 is predicted and not deployed. The server still refuses executeSession.
 * predictedFactoryAddress() remains the unused V1.1 factory.
 */
export const sessionTransferRace = {
  atomicInvalidation: false as const,
  v11EnforcesTransferAtExecution: false as const,
  offchainWatcherClosesRace: false as const,
  v2EscrowEpochClosesUnseenRoundTrip: true as const,
  executionRefused:
    "executeSession is refused; an empty transfer list cannot prove the NFT stayed with the session owner",
  v11Factory: V11_FACTORY_PREDICTED,
  unusedV1Factory: V1_FACTORY_PREDICTED,
  v2Factory: V2_FACTORY_PREDICTED,
  v2Implementation: V2_IMPLEMENTATION_PREDICTED,
  smallestChange:
    "V1.1 cannot see an unseen round trip, and its bytecode must stay unused. V2 is a new proxy and factory. The proxy implementation is immutable: there is no upgrade. executeSession requires the wallet to hold the NFT and session.epoch == authEpoch. Leave 0xA2edAC990B30A488D61fc4607D4365b22e41e39c unused. Do not deploy V2 until the project owner authorizes it.",
} as const;
