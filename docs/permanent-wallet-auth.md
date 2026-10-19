# Permanent citizen wallets

One Chog NFT maps to one permanent citizen and one permanent smart-contract wallet. The wallet belongs to that NFT's identity. It does not belong to the current human owner, and it is not replaced when the NFT moves.

Token 104 always maps to citizen 104 and wallet `0x120615D3Acb1A417ADC4701426FEdA531A853786`. Token 129 always maps to citizen 129 and wallet `0x79FFBbC52935322fA5c20063F6131341c4bF6d41`. Both addresses are CREATE2 predictions on Monad 143 for Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`. Neither wallet is deployed. No factory in this design has been broadcast.

## What was already deployed

Nothing. Mainnet code at the V1 factory `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` and the V1.1 factory `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` is empty. No citizen account exists. Those two predictions stay unused.

V1.1 cannot be patched in place. Its `syncOwner` returns immediately when `ownerOf` equals the last owner it saw. After Alice → Bob → Alice, with no call while Bob held the NFT, `executeSession` still sees the original owner. `contracts/test/CitizenAccount.t.sol` keeps that failure as `testRoundTripWithoutSyncStillNeedsInvalidation`.

Chog Genesis is an ordinary ERC-721. It has no transfer callback and no transfer counter. `getApproved` clears on transfer, and the owner can set the same approval again, so it is not a nonce. A contract cannot read historical logs. An offchain watcher, a live `ownerOf` check, a short expiry, or a cached owner cannot prove that a round trip did not happen.

The server still refuses `executeSession`, including when the watcher is healthy and the transfer list is empty. That refusal is defense in depth. It is not the lock.

## The five concerns

1. **Identity and wallet address.** The proxy stores `(chain id, NFT, token id)` once. CREATE2 from the V2 factory makes the address permanent. An ERC-1967 upgrade changes the logic, not the address, the stored identity, or the assets.
2. **Current NFT ownership.** While the human holds the NFT, `ownerOf` is that human.
3. **Human authorization.** That live owner can `execute`. While the wallet holds the NFT through `deposit()`, the recorded controller is the human authority. A former owner cannot spend.
4. **AI session.** `openSession` works only in custody. `executeSession` works only while the wallet still holds the NFT and `session.epoch == authEpoch`. The executor cannot call the wallet, the bound NFT, or an approval selector.
5. **Budgets.** A session has a target, a selector, an ETH cap, and one ERC-20 cap. The cap is enforced on the declared transfer amount and on the token balance that actually leaves the wallet. Human `execute` is a different path. It is not an AI budget, and it increments `authEpoch` before the call, so it retires the session.

An NFT transfer does not move the wallet's ETH or tokens. The buyer can spend only by a later call while they are the live owner, or, after they `deposit()`, by opening a new session.

## Why custody is required

The NFT can leave a human's wallet and come back without calling the citizen wallet. No value stored at `openSession` can observe that round trip.

A session is therefore possible only while the citizen wallet holds the NFT. The only exit is `release(to)`. `release` increments `authEpoch` and marks the session dead before `safeTransferFrom`. Bob can later transfer the NFT to Carol, and Carol can transfer it back to Alice, without either transfer calling the wallet. Alice can `deposit()` again. The old session epoch does not match. The executor has to be given a new session by the current controller.

`testMissedObservationCannotReviveSession` performs that round trip with no watcher, no `invalidateSession`, and no ownership cache. The session call reverts. `testNftCannotLeaveCustodyWithoutTheWallet` shows that Alice, Bob, and the executor cannot move the NFT out while the session is open.

`deposit`, `release`, `revokeSession`, `upgradeTo`, and human `execute` all increment `authEpoch` before their external call. A bounced `release` reverts the whole transaction, so a failed exit does not retire the session and does not leave the NFT half-moved.

## Addresses

| Contract | Salt label | Predicted address |
| --- | --- | --- |
| V2 implementation | `chogOS.CitizenAccountV2.v1` | `0xAFA1eD6eeC7acB070C1e771B21E568fe10Ee24Fe` |
| V2 factory | `chogOS.CitizenAccountFactory.v2` | `0xC620021d28eA1bC7d2F9f6FF9fC45245c3dB2F53` |
| Wallet for token 104 | `keccak256(abi.encode(143, genesis, 104))` from the V2 factory | `0x120615D3Acb1A417ADC4701426FEdA531A853786` |
| Wallet for token 129 | `keccak256(abi.encode(143, genesis, 129))` from the V2 factory | `0x79FFBbC52935322fA5c20063F6131341c4bF6d41` |

The factory and implementation use Arachnid's existing CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`. `contracts/script/DeployCitizenAccountFactoryV2.s.sol` only predicts. `run()` reverts `BroadcastDisabled` and the file has no broadcast call.

Changing the V2 bytecode before the first deployment changes these predictions. After deployment, the permanent address is the proxy. Further authorization changes belong in a new implementation upgraded by the current human, which also increments `authEpoch`. The session executor cannot upgrade.

## Residual hazard

`safeTransferFrom` into the wallet is rejected unless `deposit()` requested that token. A raw `transferFrom` does not notify the recipient. If the current owner, or an operator they approved, unsafely transfers the NFT into its own wallet, `ownerOf` becomes the wallet without opening custody. That state authorizes nobody: the previous owner cannot spend, the session cannot revive, and there is no admin key that can seize the assets.

The profitable action for a malicious operator is to transfer the NFT to themselves, not into this wallet. After that transfer they are the live owner and can call `execute`. That is ordinary NFT ownership, not a revived session. Do not transfer the NFT to the wallet address. Call `deposit()` while you hold it.

The wallet cannot create ERC-721 or ERC-20 approvals, and it cannot sign EIP-2612 permits. A session therefore cannot inherit an allowance. The supported autonomous spend is ETH plus one declared ERC-20, inside the session caps. A DEX-style approval is a later explicit budget, not something this wallet can grant by accident.

## What this change does not do

- It does not deploy, broadcast, fund a wallet, or spend.
- It does not enable the relayer, gas sponsorship, or `/api/transactions`.
- It does not apply SQL, change Vercel, or attach the watcher to production.
- It does not move the running backfill or reset its cursor.
- It does not start Phase 7.
- It does not change citizen membership. A transfer still does not remove a citizen.

## Tests

Foundry `CitizenAccountV2Test` is the authorization path. The TypeScript tests only prove the server stays closed and that the pinned addresses match the Solidity test.

- Alice → Bob, then Bob → Carol → Alice, without moving the wallet, its identity, or its assets.
- An old session after `release`.
- A revoked session after the NFT returns to the original owner and is deposited again.
- A fresh session opened by the current owner.
- ETH, token, replay, target, approval, upgrade, and human-execute bypasses.
- A hidden token pull above the declared budget.
- Reentrancy and a recipient that bounces the NFT back.
- Token 104 and token 129 staying isolated.
- An upgrade that keeps the proxy address and balance and kills the session.
