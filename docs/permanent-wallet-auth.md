# Permanent citizen wallets

One Chog NFT maps to one permanent citizen and one permanent smart-contract wallet. The wallet belongs to that NFT's identity. It does not belong to the current human owner, and it is not replaced when the NFT moves.

Token 104 always maps to citizen 104 and wallet `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502`. Token 129 always maps to citizen 129 and wallet `0x492905adbc786264f0195FAE4516F5275BB3b960`. Both addresses are CREATE2 predictions on Monad 143 for Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`. Neither wallet is deployed. No factory in this design has been broadcast.

These predictions were recalculated after the implementation was made immutable. The earlier upgradeable-draft addresses are void and must not be deployed:

| Void draft address | What it was |
| --- | --- |
| `0xAFA1eD6eeC7acB070C1e771B21E568fe10Ee24Fe` | Upgradeable-draft implementation |
| `0xC620021d28eA1bC7d2F9f6FF9fC45245c3dB2F53` | Upgradeable-draft factory |
| `0x120615D3Acb1A417ADC4701426FEdA531A853786` | Upgradeable-draft token 104 wallet |
| `0x79FFBbC52935322fA5c20063F6131341c4bF6d41` | Upgradeable-draft token 129 wallet |

## What was already deployed

Nothing in this wallet design. Mainnet code at the V1 factory `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` and the V1.1 factory `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` is empty. No citizen account exists. Those two predictions stay unused.

V1.1 cannot be patched in place. Its `syncOwner` returns immediately when `ownerOf` equals the last owner it saw. After Alice → Bob → Alice, with no call while Bob held the NFT, `executeSession` still sees the original owner. `contracts/test/CitizenAccount.t.sol` keeps that failure as `testRoundTripWithoutSyncStillNeedsInvalidation`.

Chog Genesis is an ordinary ERC-721. It has no transfer callback and no transfer counter. `getApproved` clears on transfer, and the owner can set the same approval again, so it is not a nonce. A contract cannot read historical logs. An offchain watcher, a live `ownerOf` check, a short expiry, or a cached owner cannot prove that a round trip did not happen.

The server still refuses `executeSession`, including when the watcher is healthy and the transfer list is empty. That refusal is defense in depth. It is not the lock.

## The five concerns

1. **Identity and wallet address.** The proxy stores `(chain id, NFT, token id)` once. CREATE2 from the V2 factory makes the address permanent. The implementation is fixed in the proxy bytecode. Replacing logic is not possible, so identity and assets stay with that address.
2. **Current NFT ownership.** While the human holds the NFT, `ownerOf` is that human.
3. **Human authorization.** That live owner can `execute`. While the wallet holds the NFT through `deposit()`, the recorded controller is the human authority. A former owner cannot spend.
4. **AI session.** `openSession` works only in custody. `executeSession` works only while the wallet still holds the NFT and `session.epoch == authEpoch`. The executor cannot call the wallet, the bound NFT, the implementation, or a known approval selector.
5. **Budgets.** A session has a target, a selector, an ETH cap, and one ERC-20 cap. The cap is enforced on the declared transfer amount and on the token balance that actually leaves the wallet. Human `execute` is a different path. It is not an AI budget, and it increments `authEpoch` before the call, so it retires the session.

An NFT transfer does not move the wallet's ETH or tokens. The buyer can spend only by a later call while they are the live owner, or, after they `deposit()`, by opening a new session.

## Why custody is required

The NFT can leave a human's wallet and come back without calling the citizen wallet. No value stored at `openSession` can observe that round trip.

A session is therefore possible only while the citizen wallet holds the NFT. The only exit is `release(to)`. `release` increments `authEpoch`, clears `controller`, and marks the session dead before `safeTransferFrom`. Bob can later transfer the NFT to Carol, and Carol can transfer it back to Alice, without either transfer calling the wallet. Alice can `deposit()` again. The old session epoch does not match. The executor has to be given a new session by the current controller.

`testMissedObservationCannotReviveSession` performs that round trip with no watcher, no `invalidateSession`, and no ownership cache. The session call reverts. `testNftCannotLeaveCustodyWithoutTheWallet` shows that Alice, Bob, and the executor cannot move the NFT out while the session is open.

`deposit`, `release`, `revokeSession`, and human `execute` all increment `authEpoch` before their external call. A bounced `release` reverts the whole transaction, so a failed exit does not retire the session and does not leave the NFT half-moved.

## Who can upgrade

Nobody. `CitizenWalletProxy` stores the implementation in the immutable `logic` and the fallback `delegatecall`s that address. The ERC-1967 slot is written once in the constructor so an explorer can see the implementation. The fallback does not read that slot. There is no `upgradeTo`, no admin, and no beacon.

A current NFT holder cannot install different code. A raw `upgradeTo` call reverts. Writing the ERC-1967 slot, including in a test with `vm.store`, does not change which code the wallet runs.

`code.length > 0` does not make an implementation safe. `codeVersion() == 1` does not either: a hostile contract can return 1. The permanent wallet is the CREATE2 address of the pinned factory, and that factory's creation code contains the honest implementation address. A different implementation produces a different factory and different wallet addresses. Those addresses are not citizen wallet 104 or 129.

Future logic changes are possible only before the first deployment, and they move these CREATE2 addresses. After deployment the logic is frozen. Preserving an upgrade path would let a former owner, or a platform admin, keep control after the NFT moves. That fails the ownership-transition requirement, so upgradability is not preserved.

## How to pause autonomy and transfer the NFT

An AI session exists only while this wallet holds the NFT.

1. The current owner calls `deposit()` while they hold the NFT. That pulls the NFT in with `safeTransferFrom`, records the controller, and retires any previous session epoch.
2. To stop the executor and keep the NFT in the wallet, the controller calls `pauseSession(true)`. `pauseSession(false)` resumes the same session if it has not expired or been revoked.
3. To end the session and keep the NFT in the wallet, the controller calls `revokeSession()`. That increments `authEpoch`. A later session is a new epoch.
4. To sell or transfer the NFT, the controller calls `release(to)` first. That increments `authEpoch`, clears `controller`, closes custody, and sends the NFT to `to`. The old executor can no longer call the wallet.
5. The human who received the NFT then transfers it with the NFT contract. The wallet address, the citizen identity, the ETH, and the tokens stay where they are. The new owner is the human authority.
6. Do not `transferFrom` the NFT into the wallet address. That is not a deposit. See the residual hazard below.

## Addresses

| Contract | Salt label | Predicted address |
| --- | --- | --- |
| V2 implementation | `chogOS.CitizenAccountV2.v1` | `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` |
| V2 factory | `chogOS.CitizenAccountFactory.v2` | `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` |
| Wallet for token 104 | `keccak256(abi.encode(143, genesis, 104))` from the V2 factory | `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` |
| Wallet for token 129 | `keccak256(abi.encode(143, genesis, 129))` from the V2 factory | `0x492905adbc786264f0195FAE4516F5275BB3b960` |

Creation-code hashes for the Arachnid deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`:

| Bytecode | `keccak256` |
| --- | --- |
| `CitizenAccountV2` creation code | `0x19c106f6993aad95c63cf742ec0eec9323f889a6feefd7ee8897768d216f1251` |
| `CitizenAccountFactoryV2` creation code, bound to the implementation above | `0xf949dcca45c301030267e8a46ecc2aabab92a79ad49d147a1b327307f00e1a64` |

The factory and implementation use Arachnid's existing CREATE2 deployer. `contracts/script/DeployCitizenAccountFactoryV2.s.sol` only predicts. `run()` reverts `BroadcastDisabled` and the file has no broadcast call.

Changing the V2 bytecode before the first deployment changes these predictions. Recalculate them from that script after any source change. Do not reuse the table above after a later edit.

## Security review

This is a review of the V2 sources and their Foundry tests. It is not a full smart-contract audit. Passing tests do not prove the absence of every bug. The items under "Independent review" should be reviewed by a person before any deployment is authorized.

### Critical — fixed

**C-1. A current holder could install a backdoor that survived the NFT transfer.**

`upgradeTo(address)` let the current authority write any contract with code into the ERC-1967 slot. The proxy then `delegatecall`ed that slot. The attack was:

1. Alice owns the NFT.
2. Alice upgrades the wallet to code that ignores `ownerOf` and sends the balance to Alice.
3. Alice transfers the NFT to Bob.
4. Bob holds the NFT and expects to control the permanent wallet.
5. Alice calls the backdoor and drains deposits that arrive later.

Checking `code.length` does not prevent this. A UUPS UUID check does not prevent it either, because the malicious implementation can return the expected id. Restricting `upgradeTo` to the current owner is the same attack. A project admin or beacon key would be able to spend every citizen wallet after any transfer, which is the same ownership failure.

The fix removes `upgradeTo`. The proxy executes immutable `logic`. Regression coverage:

- `testFormerOwnerCannotInstallABackdoorOrDrainFutureDeposits`
- `testCustodyUpgradeAttemptDoesNotSurviveRelease`
- `testCorruptedImplementationSlotDoesNotRetargetTheWallet`
- `testHostileFactoryIsNotThePermanentWallet`

### High

No other confirmed high-severity theft path remained in the reviewed functions: human `execute`, `openSession`, `pauseSession`, `revokeSession`, `executeSession`, `deposit`, `release`, token custody, `onERC721Received`, proxy initialization, and the reentrancy lock. Those paths are covered by the Foundry suite below. This is not a claim that an independent reviewer will find nothing else.

### Residual hazards

**Unsafe transfer freeze.** `safeTransferFrom` into the wallet is rejected unless `deposit()` requested that token. A raw `transferFrom` does not notify the recipient. If the current owner, or an operator they approved, unsafely transfers the bound NFT into its own wallet, `ownerOf` becomes the wallet without opening custody. That state authorizes nobody: the previous owner cannot spend, the session cannot revive, and there is no admin key that can seize the assets. There is no recovery function. A last-controller rescue would be a theft path after a transfer the wallet did not see.

The profitable action for a malicious operator is to transfer the NFT to themselves, not into this wallet. After that transfer they are the live owner and can call `execute`. That is ordinary NFT ownership, not a revived session. Do not transfer the NFT to the wallet address. Call `deposit()` while you hold it.

**Approval denylist.** Human `execute` and session calls reject `approve` (`0x095ea7b3`), `increaseAllowance` (`0x39509351`), `increaseApproval` (`0xd73dd623`), `setApprovalForAll` (`0xa22cb465`), EIP-2612 `permit` (`0xd505accf`), and DAI-style `permit` (`0x8fcbaf0c`). The session also has one target and one selector. User calls use `CALL`. The wallet does not `delegatecall` calldata supplied by the owner or the executor. A multicall or forwarder therefore runs its inner calls as itself, and that does not create a standard ERC-20 allowance on the wallet. A direct call to some other function can still do whatever that function does. If that function grants a non-standard allowance or operator, the grant remains after the NFT moves and can reach tokens deposited later.

**Spend-token accounting.** The session budget reads `balanceOf` on the one declared token and counts `max(balance decrease, declared transfer amount)` for `transfer` and `transferFrom`. For any other selector, only the balance decrease is counted. A token whose `balanceOf` hides the decrease can move tokens beyond the cap. An honest balance decrease is capped, including a hidden pull of that same token.

**The bound NFT is trusted for `ownerOf`.** Chog Genesis is an ordinary ERC-721. A malicious token contract could lie. The pinned wallets are the CREATE2 addresses for the Genesis contract and token ids 104 and 129. The factory will create a wallet for another NFT contract, at a different address.

**`codeVersion()` is not a safety proof.** The factory constructor rejects an implementation that does not return 1, and it rejects an empty address. A hostile contract can return 1 and have code. Used with a different factory, it creates a different wallet, which `testHostileFactoryIsNotThePermanentWallet` drains without touching wallet 104.

### What the reviewed paths guarantee in the tests

- One NFT id maps to one predicted wallet, and a second `create` returns that same address.
- Alice → Bob, then Bob → Carol → Alice, leaves the wallet address, the stored identity, and the assets in place.
- An old session fails after `release`. A revoked session stays dead when the NFT returns and is deposited again.
- The current owner can open a fresh session. The previous executor cannot use it.
- A previous owner cannot `execute` or drain ETH that arrives after the transfer.
- Session ETH caps, the cumulative cap, the nonce, the target, and the selector are enforced. A hidden pull of the declared token above the cap reverts.
- Reentrancy cannot `release` or start a second `execute`. A recipient that sends the NFT back cannot force `release`.
- Token 104 and token 129 stay isolated.
- The implementation address is unchanged after a hostile `upgradeTo` attempt, and the known approval selectors revert.

### Independent review still required

Automated tests are not a full audit. Before any deployment is considered, an independent reviewer should read the proxy, the factory, and `CitizenAccountV2` with the source in hand. In particular:

- The decision that the implementation is immutable, and that no admin upgrade is acceptable.
- The unsafe-transfer freeze, which has no recovery path.
- Trust in the bound ERC-721 and in the spend token's `balanceOf`.
- Whether the human path should stay a denylist or become an allowlist.
- Storage layout, the reentrancy lock, and the order of `authEpoch` updates against external calls.

No such review has been commissioned by this change.

## Pre-merge disposition

Reviewed against commit `5319d4f` and the documentation update that records this disposition. The proxy ABI is `implementation()` and `logic()` only. `CitizenAccountV2` has no upgrade function. `logic()` (`0xd7dfa0dd`) does not share a selector with any wallet function, so the proxy getter does not shadow `deposit`, `release`, `execute`, or `executeSession`.

| Residual | Code change before merge | This merge | Mainnet deployment |
| --- | --- | --- | --- |
| Non-standard approval call | No. An allowlist would be a different human-execution design. Standard approval selectors already revert, and multicall cannot grant a standard allowance because the wallet does not delegatecall user calldata. | Accepted limitation. | Blocked until the project owner accepts that an explicit non-standard grant can outlive a transfer, or the human path is restricted before any broadcast. |
| `balanceOf` budget | No. The wallet cannot prove an arbitrary token's balance. | Accepted limitation. | Autonomous spending is blocked until each spend token is a reviewed contract. A lying `balanceOf` can hide a transfer. |
| Unsafe NFT transfer freeze | No. A recovery path for a previous controller is a theft path after a transfer the wallet did not see. | Accepted limitation. | Blocked until the project owner accepts permanent loss of that NFT and of every asset in its wallet. Immutability means this cannot be patched later. |
| Initialization, factory, immutable logic | No. The canonical proxy initializes inside its constructor. The pinned factory address contains the implementation address. `codeVersion()` does not authenticate bytecode. | Accepted. This is the fix for the upgrade backdoor. | Blocked until an independent reviewer accepts this exact bytecode, the deployed codehash is checked against this build before any citizen wallet is created, and the project owner accepts that there is no upgrade. One logic bug would affect every wallet. V2 has not been run against a fork of Chog Genesis. |

Merging this source does not deploy it. `predictedFactoryAddress()` remains the unused V1.1 factory. The server still refuses `executeSession`.

## What this change does not do

- It does not deploy, broadcast, fund a wallet, or spend.
- It does not enable the relayer, gas sponsorship, or `/api/transactions`.
- It does not apply SQL, change Vercel, or attach the watcher to production.
- It does not move the running backfill or reset its cursor.
- It does not start Phase 7.
- It does not change citizen membership. A transfer still does not remove a citizen.
