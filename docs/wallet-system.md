> **Not the live record.** This file describes the Phase 0 shell on `main`. The live app and the deployment record are in the repository README and on `cursor/phase-1-genesis-world-155c`.

# Wallet system

This Phase 0 note does not deploy a wallet. It chooses a design. The wallets that were later deployed are in the repository README.

## What the wallets have to do

- One Chog Genesis token id maps to one citizen wallet.
- The current NFT owner is the root authority for that wallet. A transfer of the NFT moves that authority.
- The AI can act only inside a permission the root authority granted: assets, targets, spend ceiling, and expiry. The AI never holds the root key.
- A transferred NFT must not leave an old AI permission able to spend.
- The owner can recover control without asking the AI. Loss of the NFT is loss of the citizen unless the owner arranged a recovery path in advance.
- The shared treasury is a separate wallet. The administrator funds it with an ordinary transfer. The AI cannot replace the treasury owners.
- Businesses need wallets too. Chog Genesis `maxSupply()` is 1,969, so a business must not need a genesis token. That would cap the economy at the size of the collection.

The NFT function `treasury()` returns `0x84113421A8a564b594ee9Ae78c875310332d7023`. That is the collection's mint receiver. It is not a candidate for the civilization treasury.

## Token-bound accounts

ERC-6551 gives an NFT a smart-account address derived from a registry, an implementation, the chain id, the token contract, the token id, and a salt. The account's owner is defined as the current token owner, so a transfer moves control without a database update.

On 10 October 2026, `eth_getCode` returned bytecode at the well-known registry address `0x000000006551c19487814612e58FE06813775758` on Monad mainnet. That address is not in the Monad canonical-contract list read for this phase, and the bytecode was not hash-matched to the ERC-6551 reference repository. The registry is observed, not attested.

A token-bound account fits the citizen identity cleanly. It does not, by itself, provide a shared treasury, a business wallet, or an AI session key. Those require a custom account implementation. Once the implementation is custom, the registry is only an address scheme. The permission code is the actual wallet.

Using a genesis token as the binding for every business would also tie economic expansion to a 1,969 token collection. That conflicts with the requirement that legitimate businesses are not capped.

## Dedicated factory

A project factory deploys one smart account per subject with CREATE2:

- Citizen account salt: chain id, Chog Genesis address, token id.
- Business account salt: business id, assigned when the business is recorded.
- Treasury: not a citizen account. It is a separate deployment with a different owner policy.

The citizen account does not store an owner address as its root. On each validation it reads `ownerOf(tokenId)` from Chog Genesis. The NFT owner can always act. After a transfer, the new owner is the root on the next call, without a database write.

AI authority is a session signer recorded by the current root:

- allowed target addresses and function selectors
- allowed asset addresses
- a raw-integer spend ceiling for a time window
- an expiry
- the `ownerOf` result observed when the session was granted

The account rejects the session when `ownerOf` has changed, when the window has expired, or when the call exceeds the ceiling. The session signer cannot rotate the root, cannot extend its own ceiling, and cannot change the treasury.

Recovery sits with the NFT owner. An optional guardian can be named by that owner, with a delay, and can be revoked by the owner immediately. The AI cannot add a guardian. If the owner loses the NFT and did not name a guardian, the citizen wallet follows the NFT. That is the identity rule, and it should be said at enrollment rather than patched later.

Business accounts have an explicit owner set by the founding citizen's wallet. They are not bound to a genesis token. Nothing in the factory limits how many of them can exist.

Monad's canonical contract list includes ERC-4337 EntryPoint v0.6 through v0.9, and each of those addresses had bytecode on mainnet during the Phase 0 check. User operations are a way for a relayer to submit a call the AI session signed, without giving the AI the root key. The EntryPoint version should be pinned in Phase 1 only after its bytecode is hash-matched to the upstream release. This phase did not hash-match it.

## Shared treasury

The treasury should be a Safe, using the Safe singleton listed in Monad's mainnet canonical contracts (`0x69f4D1788e39c87893C980c06EdF4b7f686e2938`). Bytecode is present there. It was not hash-matched in this phase, so deployment waits for that check.

The administrator is the initial Safe owner, preferably as a hardware-backed signer or a small owner set the administrator controls. Funding is a normal MON or token transfer into that Safe. The AI is not an owner.

A later module can give the AI a narrow allowance from the treasury. The module has to be revocable by the Safe owners without the AI's signature. That Safe module was not built. Spending that exists today is the ChogBank path in the repository README.

The Safe proxy factory address `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` is listed in Monad's testnet documentation and has bytecode on mainnet as well. It was not in the mainnet canonical table read for this phase, and it was not hash-matched. Treat it as observed infrastructure, not as a finished choice.

## Recommendation

Use a dedicated factory.

- Citizen wallets resolve their root with `ownerOf` and give the AI a revocable session.
- Business wallets come from the same factory and are not tied to the 1,969 genesis supply.
- The civilization treasury is a separate Safe controlled by the administrator.
- ERC-6551 can be revisited as an address scheme for citizen accounts only. It does not replace the permissioned account, the business wallets, or the treasury.
- The first implementation should deploy audited Safe bytecode for the treasury, and it should not introduce a new account implementation for citizens until that bytecode has been reviewed. A factory of Safes, with the NFT owner as the Safe owner and a scoped module for the AI, is the lower-risk way to build the same design. A custom ERC-4337 account can replace the citizen implementation later if the Safe deployment cost is too high.

No factory, Safe, module, or account is deployed in Phase 0.

## Enrollment consequence

The database wallet row is written after the chain deployment receipt is stored. The row's address is a pointer. Balances continue to be read from Monad at use time.
