# Phase 11 — Ownerless ChogBank

Status: **implemented and tested in source. Not deployed.** There is no funding address. Production signing and broadcasting stay disabled. This work did not change production environment variables, did not write the production database, and did not broadcast a transaction.

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
| Application server | Reject a proposal, or record an accepted review with `executed: false`. | Sign or broadcast in this phase. `evaluateProductionTreasuryAllocation` forces execution off and wallet bytecode unseen. |
| Authorizer key | After deployment, sign an EIP-712 allocation. The contract still enforces the asset, caps, expiry, nonce, and recipient. | Change caps, upgrade the contract, or pay an arbitrary address. |
| Transaction submitter | Pay gas for a valid signed allocation. | Change policy or bypass `distribute`. |
| NFT holder | Transfer the NFT. Ownership is tracked apart from citizen identity. | Redirect an allocation. The recipient is the wallet for the token id, not `ownerOf`. |
| Anyone | Send MON to `receive` or transfer `$CHOG` to the contract. | Withdraw except through a valid allocation to a deployed citizen wallet. |

A leaked authorizer key is a real spending authority inside the caps. This system does not claim to have no privileged key.

## How the AI decides

The existing mind runner, `runAiMind`, makes one treasury pass per run after the growth pass, including a run that finds no citizen ready for a growth turn. It does not replace the growth prompt. That prompt still forbids `propose_economy` and `request_wallet_activation`.

The treasury prompt lists enrolled citizens by token id, name, and an optional goal. It asks for JSON. Forbidden fields are `recipient`, `to`, `target`, `address`, `wallet`, and `owner`. `amountRaw` must be a digit string, so a JSON number such as `1e18` is rejected. `allocate: false` is recorded as a rejection, not a payment.

The server then runs the policy below. The model is not asked again to approve its own limits. A passing production review is stored in `ai_decisions` with `purpose = treasury_allocation`, `executed: false`, `onchain: false`, and `txHash: null`. The decision id is `keccak256("chogos.treasury.v1:{tokenId}:{asset}:{windowId}")`. The same citizen and asset cannot be admitted twice in one window, even if the reason is rewritten.

If earlier rows cannot be read, the model is not called. A provider quota error halts the scheduler. Any other treasury failure leaves the growth result in place. A completion is counted in the existing budget. The runner does not call an RPC and does not retry a payout, because it never creates one.

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

The page lists recent successful funding receipts only after the address has passed the ownerless checks. An empty log window is not displayed as a zero balance. This phase has no such address, so it lists none.

`CHOG_BANK_DEPLOYMENT_TX` is optional and stays unset. The page links it only when the contract checks pass and a successful receipt has `contractAddress` equal to that contract. Any other hash stays "Not recorded".

## How a citizen would receive funds

Citizen identity is the NFT token id. Personality, goals, biography, history, and economic records stay with that id when the NFT moves.

The only payout destination in the contract is the CREATE2 citizen wallet for that token id, using the pinned factory, `CitizenWalletProxy`, and `CitizenAccountV2.initialize(chainId, genesis, tokenId)`. The contract does not read `ownerOf`. If the wallet has no code, the transfer reverts with `WalletNotDeployed`. An empty predicted address is never paid.

Those wallets are not deployed. V2 fixed the old session round-trip by requiring custody, and that fix is not a reason to send funds. The remaining hazards are unchanged:

- An unsafe `transferFrom` of the NFT into the wallet can freeze it with no recovery.
- A non-standard approval can outlive a transfer.
- A session budget trusts the token's `balanceOf`.
- The wallet bytecode has not had an independent audit.
- One logic bug would affect every wallet, and this treasury has no admin path to retarget a wallet after deployment.

The current NFT owner could later operate a deployed wallet and move its contents. A former owner could not. This phase does not pay the current holder's account, and it does not display predicted wallet addresses as destinations. Until wallet bytecode is deployed and the hazards above are accepted, every on-chain distribution reverts and every production review stops at `accepted_not_executed`.

Changing `CitizenAccountV2` or the factory after ChogBank is deployed strands the payout path. Funds already in the bank would have no admin rescue. Freeze that bytecode before broadcast, or accept that the funds can sit.

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

- The contract is not deployed and has not had an independent audit.
- No authorizer key exists in this repository. Creating one and putting it in Vercel would be a mistake. The loader refuses that shape of secret, and it still would not sign.
- Citizen wallets are not a safe payout destination today.
- Caps are immutable after deployment. A wrong `$CHOG` integer cannot be patched.
- A direct `$CHOG` transfer is visible on the token contract, not as a ChogBank `Funded` event.
- The local Foundry fork test cannot create a Monad fork from an Ethereum EVM, so `testOfficialChogDecimalsOnMonad` skips. A separate read-only `decimals()` call on the official token returned 18. The application still rejects token amounts when a live read is missing or not 18.
- This page's log window is about 100 blocks. It is not an archive, and a reorg can move a very recent receipt.
- Database rows are reviews. A transaction hash on a proposed row is not rendered as a payment.

## Deployment procedure

Do not run the broadcast form until the actions below are accepted.

1. Review `contracts/src/ChogBank.sol`, `contracts/test/ChogBank.t.sol`, and this document.
2. From the repository root, with Foundry installed:

```bash
forge test --root contracts --match-contract ChogBank
```

3. Confirm chain 143 and that the official Genesis and `$CHOG` contracts have code. The script reverts with `CodeMissing` when they do not.
4. Choose the authorizer address and the eight numeric parameters. Suggested MON caps, in wei, match the application review: per transaction `100000000000000000`, per citizen `1000000000000000000`, aggregate `2000000000000000000`. Choose `$CHOG` caps as raw 18-decimal integers. Suggested window `86400` and authorization lifetime `3600`.
5. The script reads `CHOG_BANK_AUTHORIZER`, `CHOG_BANK_WINDOW_SECONDS`, `CHOG_BANK_MAX_AUTHORIZATION_TTL`, `CHOG_BANK_MAX_PER_TX_MON`, `CHOG_BANK_MAX_CITIZEN_WINDOW_MON`, `CHOG_BANK_MAX_AGGREGATE_WINDOW_MON`, `CHOG_BANK_MAX_PER_TX_CHOG`, `CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG`, and `CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG`.
6. A simulation without a broadcast still reverts until `CHOG_BANK_AUTHORIZE_BROADCAST` equals the phrase in `DeployChogBank`. That phrase is the explicit authorization. After it is set, the broadcast command is:

```bash
forge script contracts/script/DeployChogBank.s.sol:DeployChogBank \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast \
  --slow
```

Use a keystore or hardware signer for gas. Do not put that key, or the authorizer key, in the application environment.

7. The script checks the immutables and that both EIP-1967 slots are zero. Copy the logged address only after a separate read shows code there.
8. Verify the source on Monadscan. This repository does not mark that step done in advance.
9. Set `CHOG_BANK_CONTRACT_ADDRESS` to that deployed address. Set `CHOG_BANK_DEPLOYMENT_TX` only after the receipt's `contractAddress` is that same address. Reload `/economy`. The funding address appears only if the checks pass. Then send MON or `$CHOG` to that address, not to a wallet prediction and not to the NFT holder.
10. Leave payout execution disabled until the wallet hazards are resolved and a reviewed signer, outside an environment private key, is intentionally enabled. This phase has no switch that turns it on.

## Actions required before funds

1. Review and accept this contract.
2. Choose authorizer custody that is not an application environment variable.
3. Choose the immutable caps, especially the `$CHOG` raw integers.
4. Freeze the citizen-wallet bytecode, or accept that later wallet changes strand the payout path.
5. Authorize the broadcast explicitly and record the real address, deployment transaction, and source-verification result.
6. Set `CHOG_BANK_CONTRACT_ADDRESS` only after code is visible on chain 143.
7. Fund that checked address.
8. Obtain an independent review before leaving a material balance there.
9. Deploy citizen wallets only under a separate decision. Do not deploy them merely to make a payout succeed.
10. Enable signing only in a later change. This one does not.
