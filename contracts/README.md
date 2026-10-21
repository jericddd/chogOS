# Contracts

Local Foundry package. Nothing in this directory is a confirmed Mainnet deployment. Predicted CREATE2 addresses are not live contracts.

## ChogBank

`src/ChogBank.sol` is an ownerless MON and `$CHOG` treasury. It is not deployed. `forge script script/DeployChogBank.s.sol --root contracts` reverts unless the chain id is 143, `CHOG_BANK_AUTHORIZE_BROADCAST` is the exact phrase in that script, and the pinned citizen-wallet path already has code. Do not add `--broadcast` until that authorization is explicit. The factory, the implementation, and a citizen wallet are not funding addresses. See [docs/hackathon-mainnet-launch.md](../docs/hackathon-mainnet-launch.md).

## EventAnchor

Minimal Monad commitment contract for chogOS Merkle batch roots. It does not hold funds, mint tokens, or judge whether simulation events were truthful.

Tree format: `openzeppelin-standard-v1` (`keccak256("openzeppelin-standard-v1")` onchain). Leaves are `chogos-event-v1` SHA-256 hashes, encoded as `bytes32` values in an OpenZeppelin Standard Merkle Tree with `sortLeaves: false`.

Compiler: Solidity `0.8.28`, Cancun, optimizer 200 runs.

No address in this repository is a deployed EventAnchor. Do not invent one.

The onchain batch id is the bytes32 passed to `submitBatch` and indexed in `BatchAnchored`. The database id in `event_integrity_batches` is a UUID and is not that bytes32. A live check reads `batchId` from the receipt log, then calls `getBatch`. It does not hash the UUID. The contract stores the root, range, count, and tree format. It does not verify an inclusion proof.

## Local tests

```bash
# from repo root, after Foundry is installed
cd contracts && forge install foundry-rs/forge-std --no-git --no-commit
forge test --root contracts
```

`contracts/lib` is gitignored. Local `forge test` needs forge-std installed once. These tests are a local EVM. They are not a Monad Testnet verification.

## Testnet procedure (authorization required)

Official Monad Testnet facts (do not substitute):

- Chain id `10143`
- RPC `https://testnet-rpc.monad.xyz`
- Explorers `https://testnet.monadscan.com` and `https://testnet.monadvision.com`

Source: https://docs.monad.xyz/developer-essentials/testnet

1. Review this contract. Do not deploy from an application wallet key stored in the repo (there is none).
2. Deploy with Foundry to Monad Testnet only after explicit authorization:
   `forge create --root contracts src/EventAnchor.sol:EventAnchor --rpc-url https://testnet-rpc.monad.xyz --constructor-args <owner> --broadcast`
3. Verify bytecode on the explorer. Record the address in `EVENT_ANCHOR_ADDRESS` and `EVENT_ANCHOR_CHAIN_ID=10143`.
4. Offchain: `npm run verify:cutover`, `npm run verify:snapshot`, `npm run verify:batch`.
5. Submit a batch with `submitBatch(batchId, merkleRoot, fromSeq, toSeq, eventCount)` from the owner account. Wait for confirmation.
6. Read `getBatch(batchId)` and confirm `merkleRoot` matches the offchain tree.
7. Generate an inclusion proof with `npm run verify:batch` output already stored in `event_integrity_proofs`.
8. Independently: recompute `hashEvent` from the JSON export, then `StandardMerkleTree.verify(root, ["bytes32"], [hash], proof)`, then compare `root` to `getBatch`.
9. Tamper the payload or proof; verification must fail.
10. Record the receipt with `VERIFY_BROADCAST` unset: `VERIFY_BATCH_ID=... VERIFY_ANCHOR_STATUS=confirmed EVENT_ANCHOR_CHAIN_ID=10143 EVENT_ANCHOR_ADDRESS=0x... VERIFY_ANCHOR_TX=0x... VERIFY_ANCHOR_BLOCK=... npm run verify:anchor`

`scripts/verify-anchor.ts` refuses to send a transaction even if `VERIFY_BROADCAST=yes`.

Mainnet deployment is out of scope.

## CitizenAccount (Phase 6a / 6b, Mainnet-first)

NFT-bound account plus CREATE2 factory. Root authority is `ownerOf` at execution time. Delegated grant/execute entrypoints revert `DelegationDisabled` because an `ownerAtGrant` snapshot revives after A→B→A. V1.1 adds one owner-opened executor session; `syncOwner` latches it dead when a different owner is observed. The AI model never holds a key.

V1 predicted factory `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` (salt `chogOS.CitizenAccountFactory.v1`) is empty and **must not be deployed** after the session bytecode change.

V1.1 predicted factory: `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` on chain 143 via Arachnid `0x4e59…` and salt `keccak256("chogOS.CitizenAccountFactory.v1.1")`. That address is empty and must stay unused. Its session cannot see an ownership round trip. Do not deploy `MockGenesisNFT` on Mainnet.

V2 is a separate implementation, an immutable proxy, and a factory. The proxy is the permanent wallet. Nobody can upgrade it. `executeSession` is allowed only while the wallet holds the NFT and the session epoch matches. Predicted factory: `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD`. Predicted implementation: `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632`. Token 104 predicts `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502`. Token 129 predicts `0x492905adbc786264f0195FAE4516F5275BB3b960`. None of these are deployed. Earlier upgradeable-draft predictions are void. `script/DeployCitizenAccountFactoryV2.s.sol` reverts and cannot broadcast. See `docs/permanent-wallet-auth.md`.

```bash
# local EVM (fork tests skip)
forge test --root contracts

# Mainnet fork, RPC from env, chain 143. This is not a live deployment.
forge test --root contracts --fork-url "$MONAD_RPC_URL" --match-contract GenesisMainnetFork

# V1.1 factory script refuses every chain except 143. Do not add --broadcast.
# V2 script cannot broadcast on any chain.
cd contracts
forge script script/DeployCitizenAccountFactory.s.sol:DeployCitizenAccountFactory \
  --rpc-url "$MONAD_RPC_URL" \
  --sender <authorized-deployer-address>
```

Never store a deployer private key in this repo, in `.env` files, or in Supabase. Prefer `forge script --account <keystore>`. The script does not read `PRIVATE_KEY`.
