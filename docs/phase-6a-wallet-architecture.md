> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 6a — Citizen wallet architecture (Mainnet-first V1)

Date: 17 October 2026.
Base: production `cursor/phase-1-genesis-world-155c` @ `7b9f2bf`.
Status on 17 October 2026: **stop before the first Mainnet broadcast**. This document is the V1 review package. A local Foundry fork is not a deployed factory. The factory that later received code is `CitizenAccountFactoryV3` in [README.md](../README.md), not the V1 prediction in this file.

Citizen identity remains `(chain_id, nft_contract, token_id)`. The NFT is the citizen. The current owner's EOA is not the citizen wallet. The Civilization Treasury, ChogTreasury NFT holder, AI model, and citizen account are distinct. No private keys are in git or Supabase.

## Production state rechecked on 17 October 2026

As of this recheck, founding-citizen wallets had not been created yet. That changed later. See [README.md](../README.md).

- Wallet registry exists (`citizen_wallet_registry`). The only scheme the application writes is `unassigned`. The only application-written status is `not_configured`.
- `walletControlFollowsNftOwner()` is false for that scheme.
- No predicted or deployed citizen account addresses are stored.
- No private keys are stored in Supabase.
- Civilization Treasury remains a separate row and is not configured.
- `POST /api/transactions` still calls `assertExecutionDisabled` and returns 403.
- Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` has bytecode on Monad mainnet (143) and empty code on testnet (10143).
- ChogTreasury `0x84113421A8a564b594ee9Ae78c875310332d7023` is the NFT mint receiver, not the economic treasury.

## Options

### Option A — ERC-6551 Token-Bound Account (Tokenbound V3)

Evidence, 17 October 2026, `cast keccak(eth_getCode)`:

| Contract | Address | Monad 143 | Monad 10143 | Ethereum |
| --- | --- | --- | --- | --- |
| ERC-6551 registry v0.3.1 | `0x000000006551c19487814612e58FE06813775758` | hash-matched | same hash | same hash |
| Tokenbound Account V3 | `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC` | hash-matched | same hash | same hash |
| Tokenbound Account Proxy | `0x55266d75D1a14E4572138116aF39863Ed6596E7F` | hash-matched | same hash | same hash |
| Tokenbound Guardian | `0x2fe5CCB0d7Ea195FEB87987D3573f9FccE2b5d57` | present | same hash as mainnet | not compared this run |
| Tokenbound Forwarder | `0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD` | present | same hash as mainnet | not compared this run |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | hash-matched | same hash | same hash |

Sources: [Monad ERC-6551 guide](https://docs.monad.xyz/guides/erc-6551), [Tokenbound deployments](https://docs.tokenbound.org/contracts/deployments), [ERC-6551 registry v0.3.1](https://docs.tokenbound.org/guides/deploy-registry).

Ownership: the TBA owner is the current `ownerOf`. Transfer of the NFT moves control and the assets sitting in the account. Address = `(implementation, salt, chainId, tokenContract, tokenId)` through the registry. Predicted ≠ deployed.

Delegation: Tokenbound's documented `execute` is an arbitrary call authorized by the current NFT holder. Extra executor permissions exist in the Tokenbound account surface, but they are not a typed allowlist of targets and selectors. Using that stack as the AI path would grant unrestricted external calls unless we add a custom policy layer anyway.

### Option B — Project NFT-bound account (selected)

A CREATE2 factory deploys `CitizenAccount` with immutable `(boundChainId, nftContract, tokenId)`. `currentOwner()` is `IERC721.ownerOf(tokenId)` at call time. The current NFT owner may `execute` any call. Account address and token identity do not change when the NFT transfers. Assets held by the account stay in the account.

An earlier draft also stored `grantDelegation` / `executeDelegated` with `ownerAtGrant == currentOwner()`. That check is only **invalid while another address owns the NFT**. It is not **permanently invalidated by a transfer**. V1 therefore disables those entrypoints at the contract. See [Transfer-lifecycle finding](#transfer-lifecycle-finding).

### Option C — Safe / ERC-4337

Safe 1.3.0, 1.4.1, and 1.5.0 singletons and factories are hash-matched on Monad mainnet (see `docs/contracts.md`). EntryPoint v0.6 and v0.7 match Ethereum; v0.8 and v0.9 have code but did not match Ethereum, so they are not treated as canonical.

A conventional Safe stores owners. It does not read `ownerOf`. Predicting a Safe for today's holder would leave the previous owner in control after a transfer. Making it NFT-aware requires a custom module that rotates owners from `ownerOf` and a session/allowance module for the AI. That is two custom pieces plus Safe proxy initialization, more gas, and more upgrade surface, for the same owner-follow behavior Option B encodes directly.

ERC-4337 is a submission path, not an ownership model. It can sit in front of Option B later. It is not selected as the account itself.

## Decision

Select **Option B**, V1 surface:

- Deploy `CitizenAccountFactory` on Monad 143 only, after explicit broadcast authorization.
- `CitizenAccount` root authority is live `ownerOf`.
- Delegated grant/execute is disabled (`DelegationDisabled`) until a later version can observe transfers.
- Do not deploy a mock NFT on Mainnet. Do not create founding-citizen accounts. Do not fund accounts. Do not enable AI execution. Do not configure a treasury. Do not apply hosted SQL. Do not change production world data.

Reasons:

1. NFT transfer behavior for **owner** `execute` is implemented and tested against both a mock ERC-721 and a Mainnet fork of real Chog Genesis.
2. Tokenbound `execute` is arbitrary. Safe does not follow `ownerOf`.
3. The language model never holds a key and has no executor path in V1.
4. Option A remains verified infrastructure and a possible later address scheme. It is not the V1 permission layer.

Production application code still writes `unassigned` rows. `walletControlFollowsNftOwner("nft_bound_v1")` is true; the no-argument call stays false so live copy does not claim a deployed NFT-following wallet.

## Transfer-lifecycle finding

Chog Genesis is an ordinary ERC-721: `ownerOf`, `Transfer`, `transferFrom`. It has no ownership-change counter, no epoch, and it does not callback a citizen account on transfer. The citizen account is not the token recipient.

Reproduce with Foundry (`OwnerAtGrantPreview`, not shipped):

| Sequence | `ownerAtGrant == currentOwner()` grant from A |
| --- | --- |
| A grants | executes |
| A → B | rejected (`NotNftOwner`) |
| B → A | **executes again** |
| A → B → C | A's grant rejected; B's new grant rejected after C holds |
| C → B | B's grant executes again; A's grant still rejected |

Revoke and expiry still work on that preview. They do not fix revival: an unexpired, unrevoked grant becomes valid whenever the snapshotted address owns the NFT again.

V1 therefore does **not** ship `grantDelegation`, `revokeDelegation`, or `executeDelegated`. Those functions revert `DelegationDisabled`.

What V1 does guarantee:

- After A → B, A cannot `execute`. B can.
- After B → A, A can `execute` again because A is the current owner. That is NFT-bound authority, not a revived delegation.
- `(boundChainId, nftContract, tokenId)` and the account address are unchanged across transfers.

`evaluateDelegatedCall` in TypeScript is the off-chain picture of the rejected rule, kept so the revival hole stays visible. `V1_DELEGATION_ENABLED` is `false`.

## V1 contracts and features

| Item | V1 |
| --- | --- |
| `CitizenAccountFactory` | Yes. No constructor arguments. `create` / `predict` / `accountSalt`. `create` reverts unless `chainId == block.chainid`. |
| `CitizenAccount` | Yes. Immutable token identity. `currentOwner()`, owner `execute`, `receive()`. |
| `grantDelegation` / `revokeDelegation` / `executeDelegated` | Present as `pure`/`view` stubs that revert `DelegationDisabled`. |
| `MockGenesisNFT` | Tests only. Not deployed on 143. |
| `OwnerAtGrantPreview` | Tests only. Not deployed. |
| `EventAnchor` | Unchanged, not this launch. |
| AI executor / model key | None. |
| Treasury / account funding | None. |
| Hosted `nft_bound_v1` rows | Migration file exists; **not applied**. |

## Authority model (V1)

| Role | Can propose | Can execute | Can grant | Follows NFT transfer |
| --- | --- | --- | --- | --- |
| Current NFT owner | yes (off-chain) | `execute` | no; entrypoint reverts | yes, via `ownerOf` |
| Previous NFT owner | no | no while someone else holds the NFT | no | n/a |
| Delegated executor | no | no | no | n/a |
| AI model | proposal text/JSON only | no | no | n/a |
| Treasury admin | treasury config only | no citizen execute | no | n/a |
| Recovery admin | not implemented | not implemented | not implemented | n/a |

The application must not store a previous owner's signature as proof of current ownership. The chain `ownerOf` result is authoritative.

## Registry

Additive migration `supabase/migrations/20261017200000_phase6a_wallet_scheme.sql` allows scheme `nft_bound_v1` and account type `nft_bound`. It is **not applied to hosted Supabase**. No rows are inserted. Status semantics from Phase 2 stand: `address_predicted` is not `deployed`; `deployed` requires code; `verified` requires a hash match and a verified NFT identity.

## Compiler, bytecode, CREATE2

Pinned in `contracts/foundry.toml`: Solidity `0.8.28`, optimizer on, 200 runs, Cancun, `via_ir = false`, `bytecode_hash = "ipfs"`, `use_literal_content = true`.

Measured from this bytecode (any source or compiler change moves the factory address):

| Artifact | Size | keccak256 |
| --- | --- | --- |
| Factory creation | 3597 bytes | `0xf21c506f5624bcad60c12f18ed13c345d4c268a6bde686dd961af21d3b7b697a` |
| Factory runtime | 3569 bytes | `0xf7eafdc8e06b2fce761d73e196aaf6d23c81c8adb3fbcedf153d31def59587bd` |
| Account creation | 2503 bytes | `0x959661716f6d6b484b43855ecb187878b8663b1441a4a7d9deae673f189c4cfe` |
| Account runtime | 2179 bytes | `0x20515e3b10b835798756afbcf6dba257f753e3f0cba85c4b12a4da0c41e4480f` |

Factory constructor arguments: none.

Account constructor arguments: `(uint256 chainId_, address nftContract_, uint256 tokenId_)`. Constructor also requires `chainId_ != 0`, `chainId_ == block.chainid`, `nftContract_ != 0`.

Factory address (Foundry broadcasts `new {salt}` through Arachnid's proxy, which has 69 bytes of code on Monad 143):

```
salt     = keccak256("chogOS.CitizenAccountFactory.v1")
address  = CREATE2(0x4e59b44847b379578588920cA78FbF26c0B4956C, salt, keccak256(factoryCreationCode))
         = 0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c
```

That address had **empty code** on live Mainnet when this review was written. Predicted ≠ deployed.

Citizen account address:

```
salt        = keccak256(abi.encode(chainId, nftContract, tokenId))
initCode    = CitizenAccount.creationCode ++ abi.encode(chainId, nftContract, tokenId)
address     = CREATE2(factory, salt, keccak256(initCode))
```

A predicted account is not a deployed account. `create` is idempotent.

## Mainnet fork validation (not a live deployment)

RPC from `MONAD_RPC_URL` (public fallback `https://rpc.monad.xyz`). Chain id **143**. Fork tests skip on any other chain.

Checked against live Genesis (fork block around `114269626` on 17 October 2026):

- `extcodesize` 17264, `codehash` `0x91aa1fd28371674abeb31670fd694cacaca57ac29cae579452c5150eb5dbab46`
- `name()` = `Chog Genesis`
- `ownerOf(1)` returns a nonzero address (not recorded here)
- `ownerOf(0)` reverts `ERC721NonexistentToken(0)`

On the same fork, a locally constructed factory `create(143, Genesis, 1)` followed `ownerOf` through an impersonated A → B → A cycle, rejected the previous owner, kept identity stable, and reverted `grantDelegation` with `DelegationDisabled`. That mutates **fork state only**. It is not a Mainnet transfer and not evidence that `0x2d8c32…` has code on chain 143.

## Deployment readiness (unauthorized)

### Transaction count

**One** transaction: a `CREATE2` call to `0x4e59…` that writes `CitizenAccountFactory` at `0x2d8c32…`. Value `0`. No account `create`. No mock NFT. No verification tx is required for the contract to exist; verification is a later explorer API call.

### Gas / MON (simulation, not broadcast)

`forge script` on a chain-143 fork, 17 October 2026, **without** `--broadcast`:

- Estimated gas: `1_089_461` (`0x109fb5`)
- Estimated base fee: 100 gwei; max priority 2 gwei; max fee 202 gwei
- Estimated amount: **0.220071122 MON**
- Fund the signer with at least **1 MON** so a fee spike still lands. Unused MON stays in the signer.

Later, one `factory.create` (not part of this launch) measured about `517_006` gas locally / `522_960` on the fork (~0.10 MON at the same max fee).

### Exact simulation command

Never add `--broadcast` until the project owner authorizes a specific signer. Never put a private key in git, `.env` files that are committed, chat logs, or Supabase.

```bash
export MONAD_RPC_URL=https://rpc.monad.xyz   # or a private endpoint
# optional: Foundry uses --account / --private-key from the invoking shell only
cd contracts
forge script script/DeployCitizenAccountFactory.s.sol:DeployCitizenAccountFactory \
  --rpc-url "$MONAD_RPC_URL" \
  --sender <authorized-deployer-address>
```

The script reverts `NotMonadMainnet` unless `block.chainid == 143`. It reverts `MissingCreate2Deployer` if `0x4e59…` has no code.

### Exact broadcast command (do not run yet)

After written authorization of the signer:

```bash
export MONAD_RPC_URL="<rpc>"
cd contracts
forge script script/DeployCitizenAccountFactory.s.sol:DeployCitizenAccountFactory \
  --rpc-url "$MONAD_RPC_URL" \
  --account <foundry-keystore-account> \
  --broadcast \
  --chain 143
```

`--private-key` also works and must never be checked in. Prefer a keystore account. The CREATE2 address does not depend on which funded EOA sends the call; the first successful deploy occupies `0x2d8c32…`.

### Contract verification (after a real receipt)

Sourcify / MonadVision ([Monad Foundry verify guide](https://docs.monad.xyz/guides/verify-smart-contract/foundry)):

```bash
forge verify-contract \
  0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c \
  src/CitizenAccountFactory.sol:CitizenAccountFactory \
  --chain 143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --rpc-url "$MONAD_RPC_URL"
```

Monadscan (needs an explorer API key, not a wallet key):

```bash
forge verify-contract \
  0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c \
  src/CitizenAccountFactory.sol:CitizenAccountFactory \
  --chain 143 \
  --verifier etherscan \
  --etherscan-api-key "$MONADSCAN_API_KEY" \
  --watch
```

No constructor arguments. Compiler 0.8.28, optimizer 200, Cancun, viaIR false.

### Post-deployment checks (after a real receipt)

1. `cast chain-id --rpc-url $MONAD_RPC_URL` is `143`.
2. `cast codesize 0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` is `3569`.
3. `cast keccak $(cast code 0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c --rpc-url $MONAD_RPC_URL)` equals `0xf7eafdc8e06b2fce761d73e196aaf6d23c81c8adb3fbcedf153d31def59587bd`.
4. Explorer source matches `CitizenAccountFactory.sol`.
5. `predict(143, 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763, 1)` is not treated as a deployed account until `create` is later authorized.
6. Do not call `create` for the 59 founding tokens in this launch.
7. Confirm production app still writes `unassigned` / `not_configured`.
8. Confirm `/api/transactions` still 403 and the AI runner still cannot sign.

## Unresolved security limitations

- **No on-chain transfer epoch.** Genesis cannot tell the account that a transfer happened. V1 therefore has no delegated executor at all.
- **Owner `execute` is unrestricted** for the current NFT holder (any target, selector, and value). That is the V1 product: the NFT owner is the account. A stolen owner EOA is full control of that account's assets.
- **Arachnid CREATE2 proxy** `0x4e59…` is observed infrastructure (69-byte canonical deployer). chogOS did not deploy it. If it were ever changed (it is not designed to be), Foundry's `new {salt}` path would need review.
- **Bytecode freeze.** Comments, compiler flags, and `CitizenAccount` bytecode all feed the factory creation code. Changing any of them changes `0x2d8c32…`.
- **No audit.** These contracts are small and tested; they are not a third-party audit.
- **No 4337 / paymaster / session key.**
- **ETH/MON sitting in an undeployed CREATE2 address** is not recoverable by this factory until the factory exists; do not pre-fund `0x2d8c32…` with assets that are not meant for a factory. Citizen assets belong in a created `CitizenAccount`, which this launch does not create.
- Application, treasury, AI, and world state are intentionally unchanged.

## Postponed to V2

- Delegated execution, and only with a mechanism that actually invalidates grants on transfer (Genesis itself will not do this).
- An executor key that is not the model and is not the NFT owner's root EOA.
- Creating citizen accounts for founding tokens.
- Wiring `/api/transactions` or the AI runner to `execute`.
- Civilization Treasury configuration and funding.
- Hosted `nft_bound_v1` registry rows.
- ERC-4337 submission.
- EventAnchor.
- Any Testnet mock-NFT deployment (Mainnet-first; Genesis is empty on 10143).
