import { V1_FACTORY_PREDICTED, V11_FACTORY_PREDICTED } from "@/lib/chogbank/factory";

/**
 * V1.1 CitizenAccount.syncOwner returns when ownerOf equals lastSeenOwner.
 * After A→B→A with no account call, ownerOf is A again, so syncOwner does nothing
 * and executeSession still sees currentOwner() == ownerAtOpen.
 *
 * Chog Genesis is an ordinary ERC-721. It has no transfer callback and no
 * ownership nonce. The account cannot read historical Transfer logs.
 * An offchain watcher can queue invalidateSession, but that transaction can
 * land after executeSession, including in the same block. Zero watcher lag
 * does not close that race.
 *
 * A permissionless poke of syncOwner does not help once the NFT has returned
 * to the original owner. The smallest later change is a new account that
 * checks an ownership nonce Genesis does not provide. That is new bytecode
 * and a new factory address. Do not replace the V1.1 prediction below.
 */
export const sessionTransferRace = {
  atomicInvalidation: false as const,
  v11EnforcesTransferAtExecution: false as const,
  offchainWatcherClosesRace: false as const,
  executionRefused:
    "executeSession is refused; an empty transfer list cannot prove the NFT stayed with the session owner",
  v11Factory: V11_FACTORY_PREDICTED,
  unusedV1Factory: V1_FACTORY_PREDICTED,
  smallestChange:
    "Add a new CitizenAccount that stores an ownership nonce at openSession and requires the same nonce in executeSession. Chog Genesis does not expose that nonce, so this cannot be done by editing the current bytecode. Deploying it creates a new factory address. Leave 0xA2edAC990B30A488D61fc4607D4365b22e41e39c unused.",
} as const;
