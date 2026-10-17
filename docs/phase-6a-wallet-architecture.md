# Phase 6a — Citizen wallet architecture

Date: 17 October 2026.
Base: production `cursor/phase-1-genesis-world-155c` @ `7b9f2bf`.
This is an architecture and local proof of concept. It is not a Testnet or Mainnet deployment.

Citizen identity remains `(chain_id, nft_contract, token_id)`. The NFT is the citizen. The current owner's EOA is not. The Civilization Treasury, ChogTreasury NFT holder, AI model, and citizen account are distinct. Production registry rows stay `unassigned` / `not_configured`. No founding-citizen accounts were created.

## Current production state (rechecked)

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

Cost: creating a TBA is a registry `createAccount` plus initialize. Compatible with Monad. Not suitable as the AI executor without extra policy.

### Option B — Project NFT-bound account (selected)

A CREATE2 factory deploys `CitizenAccount` with immutable `(boundChainId, nftContract, tokenId)`. `currentOwner()` is `IERC721.ownerOf(tokenId)` at call time. The NFT owner may `execute` any call. An executor may `executeDelegated` only if a grant matches executor, target, selector, value flag, expiry, nonce, and `ownerAtGrant == currentOwner()`.

Transfer: Wallet B becomes owner on the next `ownerOf` read. Wallet A cannot `execute` or grant. Existing delegations fail because `ownerAtGrant` no longer matches. Account address and token identity do not change. Assets held by the account remain in the account (custody follows the NFT, not the previous EOA).

Recovery: the current NFT owner is recovery. There is no admin override in Phase 6a. Loss of the NFT is loss of control unless the holder arranged something else off-contract. Pending delegated calls that were already in-flight can still land if they were signed against the old owner before the transfer is finalized; after `ownerOf` changes they revert. The chain `ownerOf` result is authoritative, not an indexer.

AI: the model returns a proposal. A separate executor key, never shown to the model, submits `executeDelegated`. No product-level random spend cap. Controls are: explicit target, selector, optional value, expiry, nonce, revocation, and NFT-owner snapshot. Compromised executor: current owner revokes.

Dependencies: only our contracts plus an ERC-721 with `ownerOf`. No EntryPoint is required for the Phase 6a PoC. Local Foundry tests deploy a mock NFT because Chog Genesis does not exist on testnet.

### Option C — Safe / ERC-4337

Safe 1.3.0, 1.4.1, and 1.5.0 singletons and factories are hash-matched on Monad mainnet (see `docs/contracts.md`). EntryPoint v0.6 and v0.7 match Ethereum; v0.8 and v0.9 have code but did not match Ethereum, so they are not treated as canonical.

A conventional Safe stores owners. It does not read `ownerOf`. Predicting a Safe for today's holder would leave the previous owner in control after a transfer. Making it NFT-aware requires a custom module that rotates owners from `ownerOf` and a session/allowance module for the AI. That is two custom pieces plus Safe proxy initialization, more gas, and more upgrade surface, for the same behavior Option B encodes directly.

ERC-4337 is a submission path, not an ownership model. It can sit in front of Option B later. It is not selected as the account itself.

## Decision

Select **Option B**: `CitizenAccount` + `CitizenAccountFactory`.

Reasons:

1. NFT transfer behavior is implemented and tested, not assumed.
2. AI delegation is an allowlist, not Tokenbound's arbitrary `execute`.
3. It can be proven on a local EVM without deploying to Monad or creating 59 production accounts.
4. Option A is verified infrastructure and remains a possible later address scheme. It is not the AI permission layer.
5. Option C cannot follow NFT ownership without custom modules we would still have to write and test.

Production application code still writes `unassigned` rows. `walletControlFollowsNftOwner("nft_bound_v1")` is true; the no-argument call stays false so live copy does not claim a deployed NFT-following wallet.

## Authority model

| Role | Can propose | Can execute | Can revoke | Follows NFT transfer |
| --- | --- | --- | --- | --- |
| Current NFT owner | yes (off-chain) | `execute`, grant/revoke | yes | yes, via `ownerOf` |
| Previous NFT owner | no | no | no | n/a |
| Delegated executor | no | `executeDelegated` within one grant | no | no; grant dies |
| AI model | proposal text/JSON only | no | no | n/a |
| Treasury admin | treasury config only | no citizen execute | no citizen grants | n/a |
| Recovery admin | not implemented | not implemented | not implemented | n/a |

The application must not store a previous owner's signature as proof of current ownership. Grants record `ownerAtGrant` and re-read `ownerOf`.

## Registry

Additive migration `supabase/migrations/20261017200000_phase6a_wallet_scheme.sql` allows scheme `nft_bound_v1` and account type `nft_bound`. It is **not applied to hosted Supabase**. No rows are inserted. Status semantics from Phase 2 stand: `address_predicted` is not `deployed`; `deployed` requires code; `verified` requires a hash match and a verified NFT identity.

## Testnet plan (not authorized)

See the last section. No `--broadcast`. No Mainnet factory.

## Local proof

Foundry tests in `contracts/test/CitizenAccount.t.sol` cover owner execute, two transfers, previous-owner rejection, grant/revoke, replay, wrong target/selector/value/executor/chain, expiry, failed calls, constructor guards, CREATE2 predict vs create, and identity stability. TypeScript tests cover salts, policy evaluation, and safety boundaries. These are local. They are not Monad Testnet proof.

## Testnet deployment plan (pending approval)

Official Testnet: chain id `10143`, RPC `https://testnet-rpc.monad.xyz`, explorers `https://testnet.monadscan.com` and `https://testnet.monadvision.com`.

Chog Genesis has empty code on testnet. A Testnet PoC must deploy:

1. `MockGenesisNFT` (or another test ERC-721).
2. `CitizenAccountFactory`.
3. Mint token `1` to Wallet A.
4. `factory.create(10143, mockNft, 1)`.
5. Transfer token `1` to Wallet B and show A rejected / B accepted.
6. Grant a ping-only delegation, succeed once, replay-fail, revoke, fail.
7. Compare receipts and `ownerOf` independently.

Required from the project owner before any of that:

- Explicit approval to broadcast on Testnet.
- A funded Testnet signer that is **not** a production key and **not** stored in the repo or Supabase.
- Acceptance that mock NFT addresses are not Chog Genesis.

Do not deploy the factory or any citizen account on Mainnet in this phase. Do not create accounts for the 59 founding tokens. Do not enable `/api/transactions`. Do not let the AI runner sign. Do not configure or fund the Civilization Treasury.
