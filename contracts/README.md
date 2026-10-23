# Contracts

Local Foundry package. The live deployment record is [../README.md](../README.md). Predicted CREATE2 addresses below are not live contracts.

## What is deployed

On Monad mainnet (chain 143):

- ChogBank `0xB2494538433B2FA3167A723d32329cc22c3A59C1`, created in `0x665d3b3c0e9a37e6c54242aa29e5d6efb65d536e9bf777901f006d05abb8c0d4` at block `115672361`.
- CitizenAccountFactoryV3 `0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A`. `agent()` returns `0x18229E45A24FB96f3c2d551adb406Db2F7d14358`.

`src/ChogBank.sol` pays a deployed `CitizenAccountV3` wallet for one token id. It does not read `ownerOf`, and it does not pay an empty predicted address. The contract has no owner, no administrator, no proxy, and no upgrade. The authorizer can sign an allocation only inside the immutable caps, and only to that citizen wallet.

NatSpec in `ChogBank.sol`, `CitizenAccountFactoryV3.sol`, and `CitizenAccountV3.sol` used to say those contracts were not deployed. That sentence is corrected in this tree. A fresh compile's metadata suffix will not match the bytecode already on Monad. The creation transaction is the deployment record. Monadscan source verification was not recorded by the app.

`CitizenAccountV3` is not an NFT custodian. Its signer is the agent key fixed in the implementation. The NFT holder has no `execute`. `CitizenAccountV2` remains in the repository as the old model. It is not deployed. Do not deploy it.

Do not broadcast another ChogBank. `forge script script/DeployChogBank.s.sol --root contracts` reverts unless the chain id is 143, `CHOG_BANK_AUTHORIZE_BROADCAST` is the exact phrase in that script, and the V3 wallet path already has code. The factory, the implementation, and a citizen wallet are not funding addresses.

## EventAnchor

Minimal Monad commitment contract for chogOS Merkle batch roots. It does not hold funds, mint tokens, or judge whether simulation events were truthful. It is not deployed. No address in this repository is a deployed EventAnchor.

Tree format: `openzeppelin-standard-v1` (`keccak256("openzeppelin-standard-v1")` onchain). Leaves are `chogos-event-v1` SHA-256 hashes, encoded as `bytes32` values in an OpenZeppelin Standard Merkle Tree with `sortLeaves: false`.

Compiler for this package: Solidity `0.8.28`, Cancun, optimizer 200 runs.

The onchain batch id is the bytes32 passed to `submitBatch` and indexed in `BatchAnchored`. The database id in `event_integrity_batches` is a UUID and is not that bytes32. A live check reads `batchId` from the receipt log, then calls `getBatch`. It does not hash the UUID. The contract stores the root, range, count, and tree format. It does not verify an inclusion proof.

## Local tests

```bash
cd contracts && forge install foundry-rs/forge-std --no-git --no-commit
forge test --root contracts
```

`contracts/lib` is gitignored. These tests are a local EVM. They are not a Monad deployment.

## Unused predictions

V1 predicted factory `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` is empty.

V1.1 predicted factory `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` is empty. Do not deploy `MockGenesisNFT` on mainnet.

V2 factory `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` and V2 implementation `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` are empty. `script/DeployCitizenAccountFactoryV2.s.sol` reverts and cannot broadcast.

```bash
forge test --root contracts
forge test --root contracts --fork-url "$MONAD_RPC_URL" --match-contract GenesisMainnetFork
```

Never store a deployer private key in this repo, in `.env` files, or in Supabase. The deploy scripts do not read `PRIVATE_KEY` from the application.
