# Phase 11 — ChogBank

The live record is [README.md](../README.md). ChogBank is deployed at `0xB2494538433B2FA3167A723d32329cc22c3A59C1`. The contract has no owner, no administrator, no proxy, and no upgrade. The authorizer is still a privileged signer inside the immutable caps. The website does not sign. A person starts one stored payout from `.github/workflows/chogbank-payout.yml`. The scheduled AI mind workflow does not broadcast.

The paragraphs below are the build journal. Where they say the contract is not deployed, or that this server does not broadcast, they describe the Next.js process and the day the journal was written. The Actions workflow is the broadcaster.

The ChogTreasury wallet `0x84113421A8a564b594ee9ae78c875310332d7023` holds Chog Genesis NFTs. It is not this treasury.

## Architecture

`contracts/src/ChogBank.sol` is a small treasury for native MON and one pinned ERC-20, the official `$CHOG` token `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`. The official collection is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`. The constructor reverts unless `block.chainid` is 143.

There is no `owner`, no ownership transfer, no proxy, no upgrade function, no emergency withdrawal, no fallback, and no `delegatecall`. Numeric caps, the accounting window, and the authorization lifetime are stored once in the constructor. No function writes them again. Immutables are the chain id, Genesis, `$CHOG`, the citizen-wallet factory, the citizen-wallet implementation, and the authorizer.

The contract is deployed with normal `CREATE` in `contracts/script/DeployChogBank.s.sol`. There is no predicted ChogBank address to fund ahead of a broadcast.

`/economy` leads with this contract. While `CHOG_BANK_CONTRACT_ADDRESS` is unset, and when a configured address fails the code checks, the page shows a deployment-pending or rejected state. It does not invent an address, a balance, a deployment transaction, or a source-verification badge. The older operations panel still observes `CHOG_BANK_ASSET_ADDRESS` when that separate variable is set. That observer is not ChogBank.

## Threat model

| Actor | What they can do | What they cannot do |
| --- | --- | --- |
| AI model | Propose one token id, an asset, a base-unit amount, a reason, and an expected outcome. | Choose an address, change a cap, sign, or broadcast. |
| Application server | Reject a proposal, or record an accepted review. The Next.js process does not sign. | Hold the authorizer key or the agent key. A manual GitHub Actions workflow, not this server, can broadcast one stored MON allocation. |
| Authorizer key | After deployment, sign an EIP-712 allocation. The contract still enforces the asset, caps, expiry, nonce, and recipient. | Change caps, upgrade the contract, or pay an arbitrary address. |
| Transaction submitter | Pay gas for a valid signed allocation. | Change policy or bypass `distribute`. |
| NFT holder | Transfer the NFT. The site updates the displayed owner. | Control the citizen wallet, redirect an allocation, or reset the citizen. The recipient is the wallet for the token id, not `ownerOf`. |
| Anyone | Send MON to `receive` or transfer `$CHOG` to the contract. | Withdraw except through a valid allocation to a deployed citizen wallet. |

A leaked authorizer key is a real spending authority inside the caps. This system does not claim to have no privileged key.

## How the AI decides

The existing mind runner, `runAiMind`, makes one treasury pass per run after the growth pass, including a run that finds no citizen ready for a growth turn. It does not replace the growth prompt. That prompt still forbids `propose_economy` and `request_wallet_activation`.

The treasury prompt lists enrolled citizens by token id, name, and an optional goal. It asks for JSON. Forbidden fields are `recipient`, `to`, `target`, `address`, `wallet`, and `owner`. `amountRaw` must be a digit string, so a JSON number such as `1e18` is rejected. `allocate: false` is recorded as a rejection, not a payment.

The server then runs the policy below. The model is not asked again to approve its own limits. A passing production review is stored in `ai_decisions` with `purpose = treasury_allocation`, `executed: false`, `onchain: false`, and `txHash: null`. The decision id is `keccak256("chogos.treasury.v1:{tokenId}:{asset}:{windowId}")`. The same citizen and asset cannot be admitted twice in one window, even if the reason is rewritten.

If earlier rows cannot be read, the model is not called. A provider quota error halts the scheduler. Any other treasury failure leaves the growth result in place. A completion is counted in the existing budget. The runner does not call an RPC and does not retry a payout, because it never creates one.

A second pass, `considerWalletIssuance`, runs after the treasury pass. It may choose `issue`, `defer`, or `unnecessary` for one enrolled citizen. The growth prompt is unchanged and still forbids `request_wallet_activation`. The server rejects a second issuance for a citizen that already has a proposal or a wallet assignment. The decision id is `keccak256(abi.encode("chogos.wallet.issue.v3", 143, genesis, tokenId))`, the same encoding as `DeployCitizenWallets`. A deferral does not consume that id. The stored row has `purpose = wallet_issuance`, `executed: false`, `onchain: false`, `txHash: null`, and `address: null`. The runner passes `deploymentPathReady: false` because this server does not know a deployed factory and does not ask an RPC. An issue choice therefore stays `wallet_issuance_proposed`. It does not predict an address and it does not sign.

## Authorization

The contract typehash is:

```text
Allocation(bytes32 decisionId,uint256 tokenId,address asset,uint256 amount,uint256 deadline,bytes32 reasonHash)
```

The EIP-712 domain is name `chogOS ChogBank`, version `1`, chain id 143, and the deployed contract as `verifyingContract`. A signature for another chain or another verifying contract is rejected. High-s signatures are rejected. `bytes32(0)` is rejected. An expired authorization does not consume the id. A used id cannot be replayed.

`distribute` marks the id and the window spend before the external call, then pays. The recipient must be `citizenWallet(tokenId)` and that address must already have code. A short ERC-20 transfer, a `false` return, or a reentering second distribution reverts the whole call. A reverted transaction is not a payout. `classifyPayout` requires a successful Monad mainnet receipt that includes this decision id in a `Distributed` event. Seeing that event twice does not count the payout twice. If the database write fails after a real event, `recoveryAction` says to record the confirmation once, and the public page shows the chain event even when the stored row still says proposed.

No code path in this phase produces that signature. `loadProtectedSigner` refuses `CHOG_BANK_AUTHORIZER_PRIVATE_KEY` and the older ChogBank private-key names. It does not load them.

## Funding

After a real deployment, native MON is sent to the contract. No approval is required. `$CHOG` can be sent with a normal transfer. `depositChog` pulls tokens and emits `Funded` for the amount actually received. A direct transfer increases `balanceOf` and does not emit `Funded`. The page balance is the chain balance, not a reconstructed event sum.

After the address passes the owner, proxy, chain, and asset checks, the page reads `Funded` and `Distributed` logs from the deployment block through the latest block, in ranges the RPC accepts. A finished scan with no events says so. A failed, timed-out, or incomplete scan says the logs were not read and is not an empty history. An empty log list is not displayed as a zero balance. The live address is in the README.

`CHOG_BANK_DEPLOYMENT_TX` is optional in code. Production uses the creation transaction in the README. The page links it only when the contract checks pass and a successful receipt has `contractAddress` equal to that contract. Any other hash stays "Not recorded".

## How a citizen would receive funds

Citizen identity is the NFT token id. Personality, goals, biography, history, and economic records stay with that id when the NFT moves.

The only payout destination in the contract is the CREATE2 citizen wallet for that token id, using the pinned V3 factory, `CitizenWalletProxy`, and `CitizenAccountV3.initialize(chainId, genesis, tokenId)`. The contract does not read `ownerOf`. If the wallet has no code, `distribute` reverts with `WalletNotDeployed`. An empty predicted address is never paid. `distributeWithIssuance` creates that wallet through the factory and then pays it. The factory checks a separate agent signature. If creation fails, the whole transaction reverts, so the allocation is not a completed payout.

The NFT holder does not withdraw. The agent signature on the wallet is the only spend path. A treasury signature cannot be replayed as a wallet call: the domains are `chogOS ChogBank` version `1` and `chogOS CitizenWallet` version `3`.

When this journal was written, no V3 wallet address was copied into this file, because each wallet depends on the agent public key. Wallets have since been created from the factory in the README. The old V2 predictions are still void. Do not deploy `CitizenAccountV2`.

Remaining limits:

- Genesis `transferFrom` can still move an NFT into a contract that has no receiver hook. A deployed V3 wallet rejects `safeTransferFrom`. A raw `transferFrom` can leave the NFT inside the wallet. The wallet refuses to call the NFT contract, so that NFT cannot be moved back out. MON already in the wallet can still be spent by the agent. This is an NFT-trapping hazard, not a fund freeze, and it is not a reason to require custody.
- The agent key can sign an exact call, including an approval, for any target except the wallet itself, its implementation, the zero address, and the Genesis contract. There is no numeric wallet-wide cap. ChogBank's demo caps are not copied into the wallet. A compromised agent key can spend what the wallet holds.
- The wallet bytecode has not had an independent audit.
- One logic bug would affect every wallet, and this treasury has no admin path to retarget a wallet after deployment.

This repository does not pay the current holder's account, and it does not display a predicted wallet as a deployed destination. Production reviews stay off-chain until a later authorized broadcast.

Changing the V3 implementation or factory after ChogBank is deployed strands the payout path. Funds already in the bank would have no admin rescue. Choose the agent public key and freeze that bytecode before broadcast.

## Policy limits

Application review limits, used before any signature exists:

| Limit | Value |
| --- | --- |
| Chain | 143 |
| Window | 24 hours |
| Authorization lifetime | 1 hour |
| MON per transaction | 0.1 MON (`100000000000000000` wei) |
| MON per citizen per window | 1 MON |
| MON aggregate per window | 2 MON |
| `$CHOG` per transaction, per citizen, and aggregate | 0 |

`$CHOG` stays closed in the application. No price was invented. The official token's `decimals()` is 18; a missing or different live read rejects a token amount. Native MON uses wei. There is no `decimals()` call for MON.

The contract requires every cap to be greater than zero and at most `uint128` max, with per-transaction less than or equal to per-citizen less than or equal to aggregate. The window is from 1 hour through 30 days. The authorization lifetime is from 15 minutes through the window. A human chooses those integers at broadcast, including a positive `$CHOG` ceiling. The application will still refuse `$CHOG` while its own caps are zero. The model cannot change either set of numbers.

Zero value, an unsupported asset, an empty wallet, insufficient balance, a duplicate id, and a failed transfer all revert. Overlapping reviews keep the first decision id. The contract's stored id is the on-chain lock.

## What the public page checks

For a configured address on chain 143, the loader reads code, the pinned Genesis and token, the authorizer, the six caps, the EIP-1967 implementation slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, and the admin slot `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`. It also makes read-only calls to `owner()`, `admin()`, `implementation()`, and `upgradeTo(address)`. Funding is shown only when code exists, the pinned assets match, the slots are zero, those calls revert, and the caps were read. Source verification stays "not checked". The deployment transaction stays "Not recorded" until `CHOG_BANK_DEPLOYMENT_TX` is a successful receipt that created the checked contract. Balances come from `eth_getBalance` and `$CHOG` `balanceOf` on the official token.

The address is rejected when it is the NFT holder, the Genesis contract, the token contract, the zero address, or the gas-paying address.

## Known limits

The cap table above was the pre-broadcast application review, including a `$CHOG` review cap of 0. The live contract cap on `$CHOG` is 1 wei, and the live application review cap is also 1 wei. The Economy page is the current pair of numbers. The contract MON caps are 0.01 per transaction and 0.05 per citizen and in aggregate.

- The contract is deployed. It has not had an independent audit. Source verification on Monadscan was not recorded by the app.
- `WalletFrozen` is gone. `distribute` reverts with `WalletNotDeployed` when the wallet has no code, and with `InvalidRecipient` when the deployed code is not this citizen's V3 wallet. An unsafe `transferFrom` of the NFT into the wallet does not freeze MON. It can trap the NFT, because the wallet will not call Genesis.
- No authorizer key and no agent key exist in this repository. Creating one and putting it in Vercel would be a mistake. The loader refuses `CHOG_BANK_AUTHORIZER_PRIVATE_KEY`, `CHOG_WALLET_AGENT_KEY`, and `CHOG_WALLET_AGENT_PRIVATE_KEY`.
- Some citizens have a confirmed `CitizenAccountV3` wallet. A payout still reverts when that citizen's wallet has no code. An empty predicted address is not a destination.
- Caps are immutable after deployment. A wrong `$CHOG` integer cannot be patched.
- A direct `$CHOG` transfer is visible on the token contract, not as a ChogBank `Funded` event.
- The local Foundry fork test cannot create a Monad fork from an Ethereum EVM, so `testOfficialChogDecimalsOnMonad` skips. A separate read-only `decimals()` call on the official token returned 18. The application still rejects token amounts when a live read is missing or not 18.
- This page's log window is about 100 blocks. It is not an archive, and a reorg can move a very recent receipt.
- Database rows are reviews. A transaction hash on a proposed row is not rendered as a payment.

## Deployment

The broadcast already happened. Addresses, caps, and who signs are in [README.md](../README.md). Do not deploy a second ChogBank. The website still has no switch that signs. A manual GitHub Actions workflow broadcasts one stored MON allocation. The NFT holder does not withdraw. Monadscan source verification was not recorded by the app.
