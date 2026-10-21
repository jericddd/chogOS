# Hackathon mainnet launch

Nothing in this repository has been broadcast. ChogBank is not deployed. No citizen wallet is deployed. There is no funding address. Do not send MON or `$CHOG` anywhere because of this document.

This file is the operator checklist for one native-MON demo: deploy one V3 wallet, deploy ChogBank, fund it with 0.02 MON, then broadcast one 0.01 MON payout from an actual AI allocation proposal. A proposal is not a payment. The Next.js app does not sign or broadcast.

## What is void

Do not deploy `CitizenAccountV2`. These predictions are not funding addresses:

| Void address | What it was |
| --- | --- |
| `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` | V2 implementation |
| `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` | V2 factory |
| `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` | V2 token 104 wallet |
| `0x492905adbc786264f0195FAE4516F5275BB3b960` | V2 token 129 wallet |
| `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` | V1 factory |
| `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` | V1.1 factory |

Do not send funds to the ChogTreasury NFT holder `0x84113421A8a564b594ee9ae78c875310332d7023`, the Genesis contract `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`, or the `$CHOG` token `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`.

V3 addresses depend on the agent public key. Publish one only after a chain-143 receipt, code at that address, and the checks below. A console line from a script that was not broadcast is not an address to fund.

## Keys

Three separate keys. None go in git, Vercel, Supabase, `.env.local`, the database, or an AI prompt.

1. Gas key. Foundry keystore `--account chog-gas`. It pays gas. It is not the agent and not the authorizer.
2. Wallet agent key. `CHOG_WALLET_AGENT_KEY` is read only by `contracts/script/DeployCitizenWallets.s.sol`. The matching public address is `CHOG_WALLET_AGENT`. This key can later spend every V3 wallet that uses that implementation. There is no numeric wallet cap and no rotation.
3. Bank authorizer key. A file outside the repository, mode `600`, one line, `0x` plus 64 hex characters. `CHOG_BANK_AUTHORIZER_KEYFILE` points at it. The public address is `CHOG_BANK_AUTHORIZER`. It can sign allocations inside the contract caps and only to a deployed V3 wallet. It cannot change caps, upgrade the bank, or choose an arbitrary recipient.

The app refuses `CHOG_BANK_AUTHORIZER_PRIVATE_KEY`, `CHOG_WALLET_AGENT_KEY`, and `CHOG_WALLET_AGENT_PRIVATE_KEY`. Leave `CHOG_BANK_RELAYER_ENABLED` unset. Setting it does not enable broadcasting.

## Contract caps for this demo

These are fixed in the constructor. A wrong value means a new deployment, not an edit.

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
| `CHOG_BANK_DEMO_TOKEN_ID` | one enrolled token, such as `104` |

`$CHOG` application caps stay 0. Do not send `$CHOG`. The 1 wei contract caps exist so the constructor can deploy. They are not permission to pay the token.

## Production Vercel variables

Set only these on Production, after the cast checks pass:

| Name | Value |
| --- | --- |
| `CHOG_BANK_CONTRACT_ADDRESS` | Bank address from the deployment receipt |
| `CHOG_BANK_DEPLOYMENT_TX` | Deployment transaction hash whose receipt created that bank |

Do not set a private key, `CHOG_BANK_RELAYER_ENABLED`, `CHOG_WALLET_AGENT_KEY`, or `CHOG_BANK_AUTHORIZER_PRIVATE_KEY`.

`MONAD_RPC_URL` is optional and is not a signing key. When it is unset, the bank read uses `https://rpc.monad.xyz`. Set it only to an `https` Monad mainnet endpoint if that public read fails.

Without `CHOG_BANK_DEPLOYMENT_TX`, `/economy` has no scan start block. That page must say the logs were not read. It must not be treated as an empty bank.

## What the website will show

`/economy` reads `Funded` and `Distributed` from the verified deployment receipt block through the latest block. The public RPC rejects `eth_getLogs` when `toBlock - fromBlock` is greater than 100, so the read is paginated inside that limit.

- A finished scan with no events says no successful `Funded` or `Distributed` event was found.
- A finished scan with events lists those successful receipts.
- A missing deployment block, RPC error, timeout, or unfinished range says the logs were not read through the latest block. That is not a claim that no event exists. Receipts from blocks that were read can still be listed.

Source verification stays "not checked" until Monadscan shows a match. Payout execution stays disabled.

## Command sequence

Run the tests first. A pass is not a mainnet transaction.

```bash
npx vitest run
npx tsc --noEmit
npx eslint
forge test --root contracts
```

`testOfficialChogDecimalsOnMonad` and the Genesis fork tests skip when Foundry cannot open a Monad fork. A skip is not mainnet proof. Do not add `--broadcast` while rehearsing.

Export the RPC only in the operator shell. The scripts revert unless chain id is 143 and the phrase is exact. Do not delete or weaken those checks.

```bash
export MONAD_RPC_URL="https://rpc.monad.xyz"
```

### 1. Citizen wallet

`CHOG_WALLET_AGENT_KEY` and `CHOG_WALLET_AGENT` must be the same key. The script signs an issuance for the predicted factory, broadcasts with the gas keystore, and reverts if the deployed wallet does not match the prediction or has no code. The logged wallet is not a funding address.

```bash
export CHOG_BANK_AUTHORIZE_WALLETS="yes-deploy-citizen-wallets-on-monad-mainnet"
export CHOG_BANK_DEMO_TOKEN_ID="104"
export CHOG_WALLET_AGENT="<agent address>"
export CHOG_WALLET_AGENT_KEY="<agent private key, this shell only>"
forge script contracts/script/DeployCitizenWallets.s.sol:DeployCitizenWallets \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
unset CHOG_WALLET_AGENT_KEY CHOG_BANK_AUTHORIZE_WALLETS
```

Copy the wallet from `contracts/broadcast/DeployCitizenWallets.s.sol/143/run-latest.json`, then prove it on chain:

```bash
cast code <wallet> --rpc-url "$MONAD_RPC_URL"
cast call <wallet> "codeVersion()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <wallet> "token()(uint256,address,uint256)" --rpc-url "$MONAD_RPC_URL"
```

Require non-empty code, `codeVersion` 3, and `token()` equal to chain 143, `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`, and token 104. Stop if any check fails.

### 2. ChogBank

The script reverts before broadcast when Genesis or `$CHOG` has no code, the factory or implementation is missing, `codeVersion` is not 3, or the demo wallet has no code. Caps are the constructor values above.

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
unset CHOG_BANK_AUTHORIZE_BROADCAST
```

If the script reverts after `vm.stopBroadcast`, read `contracts/broadcast/DeployChogBank.s.sol/143/run-latest.json` before sending another transaction. A second run creates a second bank. Fund only one address, and only after the checks below.

```bash
cast receipt <deployTx> status --rpc-url "$MONAD_RPC_URL"
cast receipt <deployTx> contractAddress --rpc-url "$MONAD_RPC_URL"
cast receipt <deployTx> blockNumber --rpc-url "$MONAD_RPC_URL"
cast code <bank> --rpc-url "$MONAD_RPC_URL"
cast call <bank> "configuredChainId()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "genesis()(address)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "chogToken()(address)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "authorizer()(address)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "walletFactory()(address)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "walletImplementation()(address)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "windowSeconds()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxAuthorizationTtl()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxPerTxMon()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxCitizenWindowMon()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxAggregateWindowMon()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxPerTxChog()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxCitizenWindowChog()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "maxAggregateWindowChog()(uint256)" --rpc-url "$MONAD_RPC_URL"
cast call <bank> "owner()" --rpc-url "$MONAD_RPC_URL"
cast storage <bank> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$MONAD_RPC_URL"
cast storage <bank> 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --rpc-url "$MONAD_RPC_URL"
```

Require receipt status 1, `contractAddress` equal to the bank, non-empty code, chain 143, official Genesis and `$CHOG`, the authorizer (not the bank), the factory and implementation from the wallet deployment, the cap table above, `owner()` reverting, and both storage slots zero. `configuredChainId`, `genesis`, `chogToken`, `walletFactory`, `walletImplementation`, and `authorizer` are immutable. The cap fields are written once in the constructor.

### 3. Source verification

From `contracts/`, after the receipt exists. This does not flip the website flag.

```bash
ARGS=$(cast abi-encode "constructor((address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" "(0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763,0x350035555E10d9AfAF1566AaebfCeD5BA6C27777,<factory>,<implementation>,<authorizer>,86400,3600,10000000000000000,50000000000000000,50000000000000000,1,1,1)")
forge verify-contract <bank> src/ChogBank.sol:ChogBank \
  --root . \
  --chain 143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args "$ARGS" \
  --rpc-url "$MONAD_RPC_URL"
```

Verify `CitizenAccountV3` with `constructor(address)` encoded as the agent address, and `CitizenAccountFactoryV3` with `constructor(address)` encoded as the implementation. Compiler settings are solc 0.8.28, optimizer 200, Cancun, `via_ir` off. `via_ir` must stay off. Until Monadscan shows a match, `/economy` keeps saying source verification is not checked.

### 4. Show the checked bank

Set the two Production variables above. Reload https://chogos.vercel.app/economy. The funding address appears only when the owner, proxy, chain, and asset checks pass. Payout execution stays disabled. The deployment transaction link appears only when the receipt created that contract.

### 5. Fund 0.02 MON

Send `20000000000000000` wei of native MON to the funding address shown on `/economy`. No token approval. Do not send `$CHOG`. Stop if that page does not show the address.

Then, using the deployment block from the receipt:

```bash
cast receipt <fundTx> status --rpc-url "$MONAD_RPC_URL"
cast logs --from-block <deploymentBlock> --to-block latest \
  --address <bank> \
  "Funded(address,address,uint256)" \
  --rpc-url "$MONAD_RPC_URL"
```

Require status 1 and a `Funded` log for asset `0x0000000000000000000000000000000000000000` and amount `20000000000000000`. Reload `/economy`. The row is "ChogBank Funded event" only after this scan is deployed and the two variables are set. A page that says the logs were not read is not an empty bank; use the `cast logs` result.

### 6. One manual payout from a real proposal

The server will not sign this. On `/economy`, copy one `proposed` treasury allocation whose output has a `decisionId`, `tokenId` of the deployed citizen, `asset` `MON`, and `amountRaw`. If that row is missing, wait for the mind to record one. Do not insert a database row. Do not invent a decision id. A rejected row has no decision id.

Broadcast amount:

- `10000000000000000` when `amountRaw` is at least that value. The contract cap rejects more.
- the proposal's `amountRaw` when it is smaller. Do not increase it.

```bash
export CHOG_BANK_CONTRACT_ADDRESS="<bank>"
export CHOG_BANK_DECISION_ID="<output.decisionId>"
export CHOG_BANK_TOKEN_ID="104"
export CHOG_BANK_ASSET="MON"
export CHOG_BANK_AMOUNT_WEI="10000000000000000"
export CHOG_BANK_DEADLINE="$(( $(date +%s) + 600 ))"
export CHOG_BANK_REASON_HASH="$(cast keccak "<output.reason, exact UTF-8>")"
export CHOG_BANK_AUTHORIZER_KEYFILE="<path outside the repo>"
forge script contracts/script/ChogBankPayout.s.sol:ChogBankPayout \
  --sig "digest()" \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL"
```

`digest()` does not broadcast. If `payoutRecipient` reverts, the wallet is missing or is not this citizen. Stop. The deadline must be in the future and at most 3600 seconds ahead. `cast keccak` must hash the exact `output.reason` string.

Then:

```bash
export CHOG_BANK_AUTHORIZE_PAYOUT="yes-broadcast-one-chogbank-payout"
forge script contracts/script/ChogBankPayout.s.sol:ChogBankPayout \
  --root contracts \
  --rpc-url "$MONAD_RPC_URL" \
  --account chog-gas \
  --broadcast \
  --slow
unset CHOG_BANK_AUTHORIZE_PAYOUT
rm -f "$CHOG_BANK_AUTHORIZER_KEYFILE"
unset CHOG_BANK_AUTHORIZER_KEYFILE
```

The gas keystore signs the transaction. The authorizer file signs the allocation. Confirm before calling it a payment:

```bash
cast receipt <payoutTx> status --rpc-url "$MONAD_RPC_URL"
cast logs --from-block <deploymentBlock> --to-block latest \
  --address <bank> \
  "Distributed(bytes32,uint256,address,address,uint256,uint256,bytes32)" \
  --rpc-url "$MONAD_RPC_URL"
```

Require status 1 and one `Distributed` log for that decision id, token 104, the V3 wallet, asset `address(0)`, and the signed amount. Reload `/economy`. The payment is the "Confirmed" row and "View payout receipt". The proposal line without a receipt is still not a payment. Do not insert a successful database row. A second broadcast of the same decision id reverts `Replay`.

The 0.01 MON then sits in the citizen wallet. The agent key can sign one `execute` that sends it onward. The NFT holder cannot. Leave the remaining bank balance under the same caps. There is no admin withdrawal.

## Automatic versus operator-controlled

Automatic, already running, and unchanged by a broadcast:

- The daily mind can record a treasury allocation proposal and a wallet-issuance proposal. Both are database rows. Neither is a signature, a deployment, or a payment.
- `/economy` reads chain state. It does not sign.

Operator-controlled, and the only path that moves mainnet MON:

- Creating the three keys and funding the gas key.
- `DeployCitizenWallets.s.sol` with the wallet phrase and `--broadcast`.
- `DeployChogBank.s.sol` with the bank phrase and `--broadcast`.
- The two Vercel variables, with no signing keys.
- The 0.02 MON transfer to the address `/economy` shows.
- `ChogBankPayout.s.sol` with the payout phrase, the authorizer file, and the gas keystore.

No Vercel cron, world tick, or AI run can sign or broadcast this payout. `CHOG_BANK_RELAYER_ENABLED` does not turn that on.
