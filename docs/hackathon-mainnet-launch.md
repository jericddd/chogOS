# Hackathon mainnet launch

Nothing in this sequence has been broadcast. ChogBank is not deployed. There is no funding address. Do not send MON or `$CHOG` to a predicted wallet, the predicted factory, the ChogTreasury NFT holder `0x84113421A8a564b594ee9ae78c875310332d7023`, the Genesis contract, or the `$CHOG` token.

The local rehearsal of the pinned factory deployed a simulated wallet for token 104 at `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` and a simulated factory at `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD`. Those addresses are predictions. They are not contracts on Monad mainnet until the wallet broadcast below succeeds, and they are not places to send funds.

## What a payout can and cannot do

A confirmed payout is a `Distributed` event from ChogBank on chain 143. An AI row in `ai_decisions` is a review. It is not a payment.

The contract pays only the permanent wallet for one Genesis token id. The NFT holder can change. The wallet address does not. The current holder can withdraw MON that is still in the wallet with `execute`. After the NFT moves, the new holder can withdraw what remains, and the previous holder cannot. That is the tested custody rule.

`distribute` reverts if that wallet has no code, or if the wallet holds the NFT without `deposit()` (`WalletFrozen`). A freeze does not refund MON already in the wallet. Nobody can spend that balance, and there is no admin rescue. Do not `transferFrom` the NFT into its wallet. Use `deposit()` only if you intend custody, and `release(to)` before you transfer the NFT onward.

These wallet limits are still open. They are why this document does not turn on a server signer:

- A non-standard approval made through human `execute` can outlive an NFT transfer.
- A session budget trusts the spend token's `balanceOf`. The demo payout does not use `executeSession`.
- The wallet bytecode has not had an independent audit. After the factory is deployed, that bytecode is permanent.
- `$CHOG` application caps are 0. Leave them there. The contract still needs a positive cap to deploy; use 1 wei so a leaked authorizer cannot move a meaningful token balance.

The authorizer key can sign allocations inside the caps and only to a deployed, unfrozen citizen wallet. It cannot change caps, upgrade the contract, or choose an arbitrary recipient. It is a spending authority. The Next.js app refuses to load it.

## Keys

Use two keys. Neither goes in git, Vercel, `.env.local`, the database, or an AI prompt.

1. Gas key. Import it into a Foundry keystore on your machine: `cast wallet import chog-gas --interactive`. Fund that address with a small amount of MON for gas only, after you decide to broadcast. This key is not the treasury.
2. Authorizer key. Generate it offline. Put one line, the hex private key, in a file outside the repository, for example `~/chog-authorizer.key`, mode `600`. The payout script reads that file. Delete the file after the demo signature. Do not name it `CHOG_BANK_AUTHORIZER_PRIVATE_KEY` in the app environment. The app treats that name as a refusal.

The authorizer address is `cast wallet address --account` after you import the same key into a second keystore named `chog-authorizer`, or the address printed when you created the key. You need the address before deploying the bank. You need the key file only for the one payout.

## Caps to type

These are the immutable contract numbers for a small demo. They cannot be changed later.

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

The application review still allows at most 0.1 MON per transaction, 1 MON per citizen, and 2 MON aggregate, and it allows 0 `$CHOG`. A 0.01 MON proposal fits. A `$CHOG` proposal does not.

## Order

Run the tests first. From the repository root:

```bash
forge test --root contracts --match-contract ChogBank
```

`testOfficialChogDecimalsOnMonad` skips when Foundry cannot open a Monad fork. A separate read of official `$CHOG` `decimals()` returned 18. The application still rejects token amounts when a live read is missing or not 18.

Local `distribute` in `testHolderWithdrawsThePayoutAndANewHolderControlsWhatRemains` used about 148,000 gas. That is a local EVM measurement, not a Monad fee. Read the wallet prompt before you confirm a mainnet transaction.

### 1. Citizen wallet

Do not broadcast until you accept the freeze and the permanent bytecode.

```bash
export MONAD_RPC_URL="<your monad mainnet rpc>"
export CHOG_BANK_AUTHORIZE_WALLETS="yes-deploy-citizen-wallets-on-monad-mainnet"
export CHOG_BANK_DEMO_TOKEN_ID="104"
forge script contracts/script/DeployCitizenWallets.s.sol:DeployCitizenWallets \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
```

Unset `CHOG_BANK_AUTHORIZE_WALLETS` after it returns. Read the logged wallet on https://monadscan.com and confirm it has code. That wallet is still not a funding address. The bank does not exist yet.

### 2. ChogBank

```bash
export CHOG_BANK_AUTHORIZE_BROADCAST="yes-deploy-chogbank-on-monad-mainnet"
export CHOG_BANK_AUTHORIZER="<authorizer address>"
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

The script reverts on a chain other than 143, without the phrase, without official Genesis and `$CHOG` code, without the wallet path, or without code at the demo wallet. Unset `CHOG_BANK_AUTHORIZE_BROADCAST` after it returns.

Copy the address only from the transaction receipt. Then, from a separate read:

- `cast code <bank> --rpc-url "$MONAD_RPC_URL"` is not empty
- `cast call <bank> "configuredChainId()(uint256)"` is 143
- `cast call <bank> "genesis()(address)"` is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`
- `cast call <bank> "chogToken()(address)"` is `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`
- `cast call <bank> "authorizer()(address)"` is the authorizer address, not the bank
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

Monadscan also accepts an Etherscan-compatible verify if you have an explorer API key. Compiler settings are the repo's Foundry profile: solc 0.8.28, optimizer 200, Cancun, `via_ir` off. Until the explorer shows a match, the site must keep saying source verification is not checked.

### 4. Show the address on the site

In Vercel, set only:

- `CHOG_BANK_CONTRACT_ADDRESS` to the checked bank
- `CHOG_BANK_DEPLOYMENT_TX` to the deployment hash, and only if that receipt's created contract is the bank

Do not set a private key. Reload https://chogos.vercel.app/economy. The funding address appears only when the owner, proxy, chain, and asset checks pass. Payout execution on the server stays disabled.

### 5. Fund only after that page shows the checked address

Send a small amount of native MON to the bank address shown on `/economy`. No token approval. Do not send `$CHOG` for the demo. 0.02 MON is enough for one 0.01 MON payout and leaves the rest locked under the same rules. Stop if the page does not show that address.

### 6. One manual payout

The server will not sign this. Pick the decision id from a treasury review, or compute the same id the app uses: `keccak256` of the UTF-8 string `chogos.treasury.v1:<tokenId>:MON:<windowId>`, where `windowId` is `floor(unixSeconds / 86400)`. The reason hash is `keccak256` of the exact reason string.

Write `~/chog-authorizer.key` with the authorizer private key and no extra text. Then:

```bash
export CHOG_BANK_CONTRACT_ADDRESS="<checked bank>"
export CHOG_BANK_DECISION_ID="<0x decision id>"
export CHOG_BANK_TOKEN_ID="104"
export CHOG_BANK_ASSET="MON"
export CHOG_BANK_AMOUNT_WEI="10000000000000000"
export CHOG_BANK_DEADLINE="<unix seconds, at most 3600 from now>"
export CHOG_BANK_REASON_HASH="<keccak256 of the reason>"
forge script contracts/script/ChogBankPayout.s.sol:ChogBankPayout \
  --root contracts \
  --sig "digest()" \
  --rpc-url "$MONAD_RPC_URL"
```

`digest()` prints the 32-byte EIP-712 digest and calls `payoutRecipient`. If that call reverts, do not broadcast. The wallet is missing or frozen.

```bash
export CHOG_BANK_AUTHORIZE_PAYOUT="yes-broadcast-one-chogbank-payout"
export CHOG_BANK_AUTHORIZER_KEYFILE="$HOME/chog-authorizer.key"
forge script contracts/script/ChogBankPayout.s.sol:ChogBankPayout \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
unset CHOG_BANK_AUTHORIZE_PAYOUT
rm -f "$HOME/chog-authorizer.key"
```

A payment exists only after the receipt status is success on chain 143 and the log contains `Distributed` for that decision id. Run the same decision again and the contract reverts `Replay`. If the database does not record the receipt, `/economy` still shows the chain event. Do not insert a successful payout by hand for a reverted transaction.

### 7. Withdraw on camera, or accept the lock

The current NFT holder withdraws with `execute` on the citizen wallet, sending the MON to their own address. Do that before any NFT transfer if you want the demo funds back in a normal wallet. Do not `transferFrom` the NFT into the citizen wallet.

## Still not automatic

No Vercel cron, world tick, or AI run can sign or broadcast this payout. Turning that on would put the authorizer key where the application can see it. That is the remaining autonomy gap.
