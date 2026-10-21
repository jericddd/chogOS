# Hackathon mainnet launch

Nothing in this sequence has been broadcast. ChogBank is not deployed. No citizen wallet is deployed. There is no funding address. Do not send MON or `$CHOG` anywhere because of this document.

## Five states

| State | Where it stands |
| --- | --- |
| 1. Code tested locally | Foundry and the application tests exercise V3 issuance, wallet authorization, and ChogBank. A passing test is not a mainnet transaction. |
| 2. Contracts deployed | No. No factory, implementation, citizen wallet, or ChogBank receipt exists from this work. |
| 3. Treasury funded | No. There is no address to fund. |
| 4. Confirmed payout | No. A database row is not a `Distributed` event. |
| 5. AI manual versus autonomous | The mind can propose an allocation and a wallet issuance. Signing and broadcasting stay disabled. That is not autonomous execution. |

## What is void

These V2 predictions are not the product and are not funding addresses. They match the V2 bytecode still in this repository. Do not deploy that contract. `CitizenAccountV3` replaces it.

| Void address | What it was |
| --- | --- |
| `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` | V2 implementation |
| `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` | V2 factory |
| `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` | V2 token 104 wallet |
| `0x492905adbc786264f0195FAE4516F5275BB3b960` | V2 token 129 wallet |
| `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` | V1 factory |
| `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` | V1.1 factory |

V3 addresses are not printed here. The implementation constructor takes the agent public key, so the factory and every citizen wallet move when that key changes. Publish an address only after a chain-143 receipt, code at that address, and a check of the constructor arguments.

Also do not send funds to the ChogTreasury NFT holder `0x84113421A8a564b594ee9ae78c875310332d7023`, the Genesis contract `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`, or the `$CHOG` token `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`.

## What a payout can and cannot do

A confirmed payout is a `Distributed` event from ChogBank on chain 143. An `ai_decisions` row is a review. It is not a payment.

The contract pays only the V3 wallet for one Genesis token id, and only after that address has code whose `token()` matches the citizen and whose `codeVersion()` is 3. The NFT holder can change. The wallet address does not. The holder cannot call a public execute. The agent signature is the only spend path.

`distribute` reverts with `WalletNotDeployed` when the wallet has no code. It does not send MON to the empty prediction. `distributeWithIssuance` creates the wallet with a separate agent issuance signature and then pays it. If creation fails, the transaction reverts and the allocation is not paid.

A prior read-only check of Genesis found that `transferFrom` does not call the recipient, while `safeTransferFrom` does when the recipient has code. V3 reverts in `onERC721Received`, so a safe transfer into a deployed wallet fails. A raw `transferFrom` can still put the NFT inside the wallet. The wallet refuses to call the Genesis contract, so that NFT cannot be moved back out. MON in the wallet can still be spent by the agent. That is an NFT-trapping hazard. It is not the V2 fund freeze, and it is not a reason to require custody.

The wallet signs one exact call. It does not copy ChogBank's demo caps. It rejects the zero address, itself, its implementation, and the Genesis contract. It does not `delegatecall`. It does not have an upgrade or a rescue key. An approval is possible only as exact signed calldata. A compromised agent key can spend the wallet. On-chain evidence can show that the agent public key signed. It cannot show that no human ever held that key.

`$CHOG` application caps are 0. Leave them there. The contract still needs a positive cap to deploy; use 1 wei so a leaked authorizer cannot move a meaningful token balance. No `$CHOG` payout is enabled unless both layers allow it. A prior `decimals()` read on the official token returned 18. The application still rejects token amounts when a live read is missing or not 18.

The authorizer key can sign allocations inside the caps and only to a deployed V3 citizen wallet. It cannot change caps, upgrade the contract, or choose an arbitrary recipient. The Next.js app refuses to load it, and it refuses `CHOG_WALLET_AGENT_KEY` and `CHOG_WALLET_AGENT_PRIVATE_KEY`.

## Keys, later

Use separate keys. None go in git, Vercel, `.env.local`, the database, or an AI prompt. This coding task does not create them.

1. Gas key. A Foundry keystore on your machine, funded only when you decide to broadcast. It pays gas. It does not control the wallet or the bank.
2. Wallet agent key. The public address is an argument to the V3 implementation. The private key signs issuance and later wallet calls. It is not a treasury key. If a human can read or replace it, say so. The contract cannot prove otherwise.
3. Bank authorizer key. It signs ChogBank allocations only. It should be a different key from the agent. One machine holding both keys is a custody choice, not ownerlessness.

The app must not receive any of those private keys. A relayer may submit a valid agent signature. That relayer does not become the wallet owner.

## Caps for a later native-MON test

These are the immutable contract numbers for a small demo. They cannot be changed later. They are not wallet rules.

| Variable | Value |
| --- | --- |
| `CHOG_BANK_WINDOW_SECONDS` | `86400` |
| `CHOG_BANK_MAX_AUTHORIZATION_TTL` | `3600` |
| `CHOG_BANK_MAX_PER_TX_MON` | `10000000000000000` (0.01 MON) |
| `CHOG_BANK_MAX_CITIZEN_WINDOW_MON` | `50000000000000000` (0.05 MON) |
| `CHOG_BANK_MAX_AGGREGATE_WINDOW_MON` | `50000000000000000` (0.05 MON) |
| `CHOG_BANK_MAX_PER_TX_CHOG` | `1` |
| `CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG` | `1` |
| `CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG` | `1` |
| `CHOG_BANK_DEMO_TOKEN_ID` | one real enrolled token id, such as `104` |

The application review still allows at most 0.1 MON per transaction, 1 MON per citizen, and 2 MON aggregate, and it allows 0 `$CHOG`. A 0.01 MON proposal fits. A `$CHOG` proposal does not. Maximum contract exposure under the table is 0.05 MON per 24 hour window, repeating while the authorizer key exists and the balance remains. A later fund of 0.02 MON is the suggested amount, and only to the address `/economy` shows after the checks. Exposure today is zero.

## Order, after review

Run the tests first. From the repository root:

```bash
npx vitest run
npx tsc --noEmit
npx eslint
forge test --root contracts
```

`testOfficialChogDecimalsOnMonad` and the Genesis fork tests skip when Foundry cannot open a Monad fork from an Ethereum EVM. Do not treat a skip as a mainnet proof. Do not add `--broadcast` while following this file as a rehearsal.

### 1. Choose the agent public key, then the citizen wallet

The script reads `CHOG_WALLET_AGENT_KEY` and `CHOG_WALLET_AGENT`. They must describe the same key. It signs an issuance digest for the predicted factory before broadcast. The decision id is `keccak256(abi.encode("chogos.wallet.issue.v3", chainid, genesis, tokenId))`. Anyone could relay that signature. The script's gas key is the relayer for this one deployment. It does not own the wallet.

```bash
export MONAD_RPC_URL="<your monad mainnet rpc>"
export CHOG_BANK_AUTHORIZE_WALLETS="yes-deploy-citizen-wallets-on-monad-mainnet"
export CHOG_BANK_DEMO_TOKEN_ID="104"
export CHOG_WALLET_AGENT="<agent address>"
export CHOG_WALLET_AGENT_KEY="<agent private key, script environment only>"
forge script contracts/script/DeployCitizenWallets.s.sol:DeployCitizenWallets \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
```

Unset both wallet variables after it returns. Read the logged wallet on https://monadscan.com and confirm it has code, `token()` matches chain 143, Genesis, and the token id, and `codeVersion()` is 3. That wallet is still not a funding address. The bank does not exist yet. Do not send the payout to it directly.

### 2. ChogBank

```bash
export CHOG_BANK_AUTHORIZE_BROADCAST="yes-deploy-chogbank-on-monad-mainnet"
export CHOG_BANK_AUTHORIZER="<authorizer address>"
export CHOG_WALLET_AGENT="<the same agent address>"
export CHOG_BANK_WINDOW_SECONDS="86400"
export CHOG_BANK_MAX_AUTHORIZATION_TTL="3600"
export CHOG_BANK_MAX_PER_TX_MON="10000000000000000"
export CHOG_BANK_MAX_CITIZEN_WINDOW_MON="50000000000000000"
export CHOG_BANK_MAX_AGGREGATE_WINDOW_MON="50000000000000000"
export CHOG_BANK_MAX_PER_TX_CHOG="1"
export CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG="1"
export CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG="1"
export CHOG_BANK_DEMO_TOKEN_ID="104"
forge script contracts/script/DeployChogBank.s.sol:DeployChogBank \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
```

The script reverts on a chain other than 143, without the phrase, without official Genesis and `$CHOG` code, without the V3 wallet path, or without code at the demo wallet. Unset `CHOG_BANK_AUTHORIZE_BROADCAST` after it returns.

Copy the address only from the transaction receipt. Then, from a separate read:

- `cast code <bank> --rpc-url "$MONAD_RPC_URL"` is not empty
- `cast call <bank> "configuredChainId()(uint256)"` is 143
- `cast call <bank> "genesis()(address)"` is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`
- `cast call <bank> "chogToken()(address)"` is `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`
- `cast call <bank> "authorizer()(address)"` is the authorizer address, not the bank
- `cast call <bank> "walletFactory()(address)"` is the factory from the receipt
- `cast call <bank> "owner()"` reverts
- `cast storage <bank> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` is zero
- `cast storage <bank> 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` is zero

### 3. Verify source

From `contracts/`, after the receipt exists. Replace `<bank>` with the deployed address. This does not mark verification done by itself.

```bash
forge verify-contract <bank> src/ChogBank.sol:ChogBank \
  --root . \
  --chain 143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --rpc-url "$MONAD_RPC_URL"
```

Verify the implementation and factory the same way. Compiler settings are solc 0.8.28, optimizer 200, Cancun, `via_ir` off. `via_ir` must stay off. Until the explorer shows a match, the site must keep saying source verification is not checked.

### 4. Show the checked address

In Vercel, set only:

- `CHOG_BANK_CONTRACT_ADDRESS` to the checked bank
- `CHOG_BANK_DEPLOYMENT_TX` to the deployment hash, and only if that receipt's created contract is the bank

Do not set a private key. Reload https://chogos.vercel.app/economy. The funding address appears only when the owner, proxy, chain, and asset checks pass. Payout execution on the server stays disabled.

### 5. Fund only the address that page shows

Send 0.02 MON of native MON to the bank address shown on `/economy`. No token approval. Do not send `$CHOG`. Stop if the page does not show that address. Do not send it to a predicted wallet.

### 6. One manual native-MON payout

The server will not sign this. Pick the decision id from a treasury review, or compute the same id the app uses: `keccak256` of the UTF-8 string `chogos.treasury.v1:<tokenId>:MON:<windowId>`, where `windowId` is `floor(unixSeconds / 86400)`. The reason hash is `keccak256` of the exact reason string. The amount is `10000000000000000` wei. The deadline is at most 3600 seconds ahead.

The wallet from step 1 must already have code. `payoutRecipient` reverts otherwise. Do not broadcast a payout to an empty address.

Write the authorizer private key to a file outside the repo, mode `600`, and point `CHOG_BANK_AUTHORIZER_KEYFILE` at it. Run `contracts/script/ChogBankPayout.s.sol` `digest()` first. If `payoutRecipient` reverts, stop. Then set `CHOG_BANK_AUTHORIZE_PAYOUT` to `yes-broadcast-one-chogbank-payout` and broadcast with the gas keystore. Unset the phrase and delete the key file.

A payment exists only after the receipt status is success on chain 143 and the log contains `Distributed` for that decision id, the citizen token id, the wallet address, asset `address(0)`, and the amount. Run the same decision again and the contract reverts `Replay`. If the database does not record the receipt, `/economy` still shows the chain event. Do not insert a successful payout by hand for a reverted transaction.

Final custody of that 0.01 MON is the citizen wallet. The agent key can sign one `execute` that sends it to a chosen address. The NFT holder cannot. Leave the remaining bank balance under the same caps. There is no admin withdrawal.

### 7. What not to do on camera

Do not ask the NFT holder to call `execute`. That path does not exist on V3. Do not `transferFrom` the NFT into the citizen wallet.

## Still not automatic

No Vercel cron, world tick, or AI run can sign or broadcast this payout. Turning that on would put a private key where the application can see it. The mind records proposals. A human runs the gated script. That is the remaining gap between a proposal and an on-chain action.
