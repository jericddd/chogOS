# Contracts

Local Foundry package. Nothing in this directory is a Mainnet deployment.

## EventAnchor

Minimal Monad commitment contract for chogOS Merkle batch roots. It does not hold funds, mint tokens, or judge whether simulation events were truthful.

Tree format: `openzeppelin-standard-v1` (`keccak256("openzeppelin-standard-v1")` onchain). Leaves are `chogos-event-v1` SHA-256 hashes, encoded as `bytes32` values in an OpenZeppelin Standard Merkle Tree with `sortLeaves: false`.

Compiler: Solidity `0.8.28`, Cancun, optimizer 200 runs.

No address in this repository is a deployed EventAnchor. Do not invent one.

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

## CitizenAccount (Phase 6a)

NFT-bound account plus CREATE2 factory. Root authority is `ownerOf` at execution time. Delegated executors are limited to one target and selector and die when the NFT transfers.

These contracts have not been deployed. Predicted factory addresses are not accounts. Do not pass `--broadcast` until Testnet is explicitly approved. See `docs/phase-6a-wallet-architecture.md`.

```bash
forge test --root contracts --match-contract CitizenAccountTest
# simulate only; this still starts a local broadcast context and must not be pointed at Mainnet
forge script --root contracts script/DeployCitizenAccountFactory.s.sol:DeployCitizenAccountFactory
```
