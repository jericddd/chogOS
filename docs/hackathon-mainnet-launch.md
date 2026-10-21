# Hackathon mainnet launch

**Decision: NO-GO.** Do not deploy citizen wallets, do not deploy ChogBank, and do not send MON. A small mainnet payout can still lose the demo funds, and the merged code cannot remove that loss.

This is a limitation of the live Chog Genesis NFT. It is not a gap that a new wallet function can close without letting a previous holder take the NFT from its new holder. No recovery function was added. No alternative payout to the current holder was added. The citizen-wallet design is unchanged.

Nothing in this repository has been broadcast. No wallet was created. No treasury was funded. There is no funding address.

## Where the project actually is

| State | Status on 21 October 2026 |
| --- | --- |
| 1. Code tested locally | Yes. Foundry covers the ownerless bank, the capped EIP-712 allocation, replay, expiry, and the freeze. The Next.js app still refuses to sign or broadcast. |
| 2. Contracts deployed on mainnet | No. The implementation, factory, token-104 wallet, and ChogBank all have empty code. |
| 3. Treasury funded | No. Do not send MON or `$CHOG` anywhere listed in this document. |
| 4. Confirmed real payout | No. A payout exists only after a successful chain-143 receipt and a `Distributed` event. Neither exists. |
| 5. AI execution | Manual only, and not authorized. The website cannot sign. No cron or world tick can broadcast. Turning that on is a separate decision after a real payout, not part of this one. |

Read those five rows before any command below. The commands are the sequence that would be used after a later, explicit decision to accept permanent loss. They are not permission to start.

## What the live NFT contract does

Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` is verified on the Monad Sourcify instance. The match id is `1556885`. Creation bytecode and runtime bytecode are exact matches for `ChogMint`. That contract inherits OpenZeppelin ERC-721 and does not replace `transferFrom`, `safeTransferFrom`, or `_update`.

`transferFrom` changes the owner. Its only use of `ERC721InvalidReceiver` is a transfer to the zero address. It does not call the recipient.

`safeTransferFrom` calls `transferFrom` and then `ERC721Utils.checkOnERC721Received`. The hook runs only when the recipient already has code. An empty address is treated as an ordinary account and the hook is skipped. A contract that reverts, or returns the wrong selector, reverts the safe transfer with `ERC721InvalidReceiver`.

Read-only `eth_call` simulations against `https://rpc.monad.xyz` at block 115,367,889, using the current owner of token 104 as `from`, behaved that way. They were not transactions. After them, `ownerOf(104)` was unchanged and the predicted wallet still had no code.

- `transferFrom` to the `$CHOG` token contract succeeded. `safeTransferFrom` to that same contract reverted `ERC721InvalidReceiver`.
- With throwaway revert code written over the predicted wallet for that one call only, `transferFrom` still succeeded and `safeTransferFrom` reverted `ERC721InvalidReceiver` for the wallet address.
- `safeTransferFrom` to the predicted wallet as it exists today, with no code, succeeded. Genesis will deliver the NFT to an empty predicted address.

The citizen wallet rejects `safeTransferFrom` unless `deposit()` is in progress. That rejection is real, and it is only reached when Genesis calls the hook. `transferFrom` never calls it. Once the NFT is inside the wallet without `deposit()`, `authority()` is nobody. `execute` reverts `UntrackedCustody`. ChogBank's `payoutRecipient` reverts `WalletFrozen`, so a later payout is refused. MON already in the wallet stays there. There is no owner, admin, or upgrade that can retrieve it.

A function that returns the NFT to the last person the wallet saw would steal it. Alice can be the last caller, transfer the NFT to Bob, and Bob can `transferFrom` it into the wallet before any sync. Alice's recovery would take Bob's NFT. The wallet cannot see that history: Genesis does not tell the recipient, and it does not store the previous owner for the wallet to read. Checking `ownerOf` at payout time does not close the race either. The payout can land while the holder is the real owner, and the NFT can be pushed in afterwards.

## The two alternatives

**A. Keep the permanent token-id wallet.** This is still the product. The wallet address does not follow the NFT. The current holder can withdraw with `execute` while the wallet does not hold the NFT. After a normal transfer, the new holder can withdraw what remains and the previous holder cannot. The residual risk is the unsafe push above. It can be reduced only by procedure: the holder controls the NFT, token approval is clear, the MON is withdrawn in the same sitting, and nobody transfers the NFT to the wallet address. It cannot be reduced to zero. This review does not accept that residual. Accepting it would be a new decision by the project owner, and it would still be an accepted chance of permanent loss, not a repaired contract.

**B. Pay `ownerOf(tokenId)` in the same transaction.** That would send the MON to whatever address holds the NFT at the moment of the payout. The money would not sit in the citizen wallet, so this particular freeze would not trap it. It is a different economic design. The permanent wallet would no longer custody the payout. A later sale would leave the MON with the seller. Citizens whose NFT is still in the shared ChogTreasury holder `0x84113421A8a564b594ee9ae78c875310332d7023` would all pay that one address. Token 104 is not in that holder today. Its `ownerOf` at block 115,367,889 is `0xef6fdfe87081da6acc6e4755d095b8c23568577f`, an account with a 23-byte EIP-7702 delegation, not an empty key. A plain MON transfer would execute that delegated code. This path was not built, and that address is not a funding address.

The recommendation is to record the showcase from the live site and the local tests, and to leave mainnet untouched. Option A is the design to keep. It is not safe enough to fund for the recording.

## Chosen caps, if a later decision funds the bank

These are the immutable numbers for a first MON test. They are not deployed. The application review is wider (0.1 MON per transaction, 1 MON per citizen, 2 MON aggregate) and is not what the contract should be given. `$CHOG` application caps stay 0.

| Variable | Value |
| --- | --- |
| `CHOG_BANK_WINDOW_SECONDS` | `86400` |
| `CHOG_BANK_MAX_AUTHORIZATION_TTL` | `3600` |
| `CHOG_BANK_MAX_PER_TX_MON` | `10000000000000000` (0.01 MON) |
| `CHOG_BANK_MAX_CITIZEN_WINDOW_MON` | `50000000000000000` (0.05 MON) |
| `CHOG_BANK_MAX_AGGREGATE_WINDOW_MON` | `50000000000000000` (0.05 MON) |
| `CHOG_BANK_MAX_PER_TX_CHOG` | `1` wei |
| `CHOG_BANK_MAX_CITIZEN_WINDOW_CHOG` | `1` wei |
| `CHOG_BANK_MAX_AGGREGATE_WINDOW_CHOG` | `1` wei |
| `CHOG_BANK_DEMO_TOKEN_ID` | one real token id, the documented example is `104` |

The contract cap is 0.05 MON per 24-hour window for every citizen combined. It resets each window. It is not a lifetime ceiling. A leaked authorizer key can sign up to that cap without the website. The key cannot change the caps, upgrade the bank, or choose an arbitrary recipient.

The practical ceiling is the MON actually sent to the bank. The balance check reverts above it. The suggested funding, after a later decision, is 0.02 MON, which covers one 0.01 MON payout and leaves the rest under the same rules. Funding more than 0.05 MON does not let one window pay more than 0.05 MON, but the next window can pay again while the key still exists and the balance remains.

The constructor also requires a positive `$CHOG` cap. One wei is the smallest value that deploys. Do not send `$CHOG` to the bank. The application will not propose a `$CHOG` payout while its cap is 0.

## Contracts that have to exist before any funding

Already on Monad mainnet, checked by code size on the public RPC:

- Chog Genesis, above. Dependency of the wallet and the bank. Not a funding address.
- `$CHOG` `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`. The constructor pins it. Not a funding address, and not the demo asset.
- The Arachnid CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, 69 bytes of code. chogOS did not deploy it. It is how the wallet implementation and factory would be placed. Not a funding address.

Empty at that same read. These are predictions from the pinned salts. They are not contracts, and they are not funding addresses:

| Contract | Predicted address | Code |
| --- | --- | --- |
| `CitizenAccountV2` implementation, salt `chogOS.CitizenAccountV2.v1` | `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` | none |
| `CitizenAccountFactoryV2`, salt `chogOS.CitizenAccountFactory.v2` | `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` | none |
| Token 104 citizen wallet | `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` | none |

ChogBank has no predicted address. It is created with normal `CREATE` only inside the bank script. Copy an address only from a deployment receipt, then check the code.

Order of dependence: Genesis code, then the implementation, then the factory (its bytecode contains the implementation address), then `factory.create` for the chosen token id, then ChogBank. The bank script reverts unless that wallet has code and the factory's `implementation()` and `codeVersion()` match. Funding comes after the bank address is on `/economy` and the checks there pass. The token-104 holder above is the NFT owner, not the bank and not the wallet.

`getApproved(104)` was the zero address at that block. That does not list every `setApprovalForAll` operator. An operator, or the holder, can still `transferFrom` the NFT.

## Approximate gas

These are local Foundry measurements, converted at the public RPC `eth_gasPrice` of 102 gwei at block 115,367,889. Monad's fee schedule can differ. They are a budget for the gas key, not a quote and not a reason to fund the treasury. The gas key and the treasury are different addresses.

| Step | Local gas | About this much MON at 102 gwei |
| --- | --- | --- |
| Wallet script `run()` deploying the implementation, factory, and one wallet | 5,926,819 | 0.60 |
| Bank script `run()` after that wallet exists | 3,112,789 | 0.32 |
| `factory.create` alone | 281,051 | 0.029 |
| The tested MON `distribute` | 148,302 | 0.015 |
| Holder `execute` in the suite, upper measurement | 82,444 | 0.008 |

Have more than 1 MON on the gas key before any later broadcast. Do not send that gas MON to a predicted wallet or to Genesis.

## What each transaction would do

No transaction is authorized.

If the decision changed, the first broadcast would be the wallet script. It would deploy `CitizenAccountV2`, deploy the factory, and create the wallet for the chosen token id. It would not move treasury MON and it would not pay anyone.

The bank script would then create ChogBank with the caps above, the official Genesis and `$CHOG` addresses, the factory, the implementation, and the authorizer address. It would not fund itself.

The payout transaction would call `distribute` for one EIP-712 allocation: native MON, 0.01 MON, one token id, a deadline inside 3,600 seconds, and a decision id that has not been used. The recipient would be that token's deployed wallet, and only if the wallet has code and is not holding its NFT. A reverted call is not a payout. The same decision id cannot be used twice.

The holder would then call `execute` on the wallet and send the MON to an address they control, before any NFT transfer.

## Keys

Use two keys. Neither goes in git, Vercel, `.env.local`, the database, or an AI prompt. Do not create them for this no-go.

1. Gas key. Import it into a Foundry keystore on your machine: `cast wallet import chog-gas --interactive`. Fund that address only when a later decision says to broadcast. This key is not the treasury.
2. Authorizer key. Generate it offline. Put one line, the hex private key, in a file outside the repository, for example `~/chog-authorizer.key`, mode `600`. The payout script reads that file. Delete the file after the one signature. Do not name it `CHOG_BANK_AUTHORIZER_PRIVATE_KEY` in the app environment. The app treats that name as a refusal.

The authorizer address has to be known before the bank deploy. The key file is needed only for the one payout.

## Blocked sequence

Stop here while the decision remains NO-GO. The steps are written so a later acceptance does not have to invent them.

### 1. Tests

From the repository root:

```bash
forge test --root contracts --match-contract ChogBank
```

`testOfficialChogDecimalsOnMonad` skips when Foundry cannot open a Monad fork. A separate read of official `$CHOG` `decimals()` returned 18. The application still rejects token amounts when a live read is missing or not 18.

### 2. Citizen wallet

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

Unset `CHOG_BANK_AUTHORIZE_WALLETS` after it returns. Read the logged wallet on https://monadscan.com and confirm it has code. That wallet is still not a funding address. The bank does not exist yet. Do not `transferFrom` or `safeTransferFrom` the NFT to the predicted address before this code exists. A safe transfer to an empty address succeeds, and deploying the wallet afterwards starts it frozen.

### 3. ChogBank

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
- `cast call <bank> "maxAggregateWindowMon()(uint256)"` is `50000000000000000`
- `cast call <bank> "owner()"` reverts
- `cast storage <bank> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` is zero
- `cast storage <bank> 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` is zero

### 4. Verify source

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

### 5. Show the address on the site

In Vercel, set only:

- `CHOG_BANK_CONTRACT_ADDRESS` to the checked bank
- `CHOG_BANK_DEPLOYMENT_TX` to the deployment hash, and only if that receipt's created contract is the bank

Do not set a private key. Reload https://chogos.vercel.app/economy. The funding address appears only when the owner, proxy, chain, and asset checks pass. Payout execution on the server stays disabled.

### 6. Fund only after that page shows the checked address

Send native MON to the bank address shown on `/economy`. No token approval. Do not send `$CHOG`. 0.02 MON is the suggested amount. Stop if the page does not show that address.

### 7. One manual payout

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

A payment exists only after the receipt status is success on chain 143 and the log contains `Distributed` for that decision id. On Monadscan, open that transaction and read the status, the ChogBank address, and the `Distributed` event. Run the same decision again and the contract reverts `Replay`. If the database does not record the receipt, `/economy` still shows the chain event. Do not insert a successful payout by hand for a reverted transaction.

### 8. Withdraw before touching the NFT

The current NFT holder withdraws with `execute` on the citizen wallet, sending the MON to an address they control. Do that before any NFT transfer. Do not `transferFrom` the NFT into the citizen wallet. `deposit()` is a separate custody action, not the demo.

## Still not automatic

No Vercel cron, world tick, or AI run can sign or broadcast this payout. The first payout, if it ever happens, stays a separate manual test. The showcase can be recorded without it. Say that the chain payment has not happened.
