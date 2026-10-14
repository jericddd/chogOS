# Phase 3.75: verifiable civilization foundation

This phase adds a public verification layer on the existing world. It does not implement the AI mind, move the map, reset citizens, or broadcast chain transactions.

## Applied state

| Item | State |
| --- | --- |
| Code | In the repository on `cursor/phase-3-75-verifiability-155c` |
| `20261014120000_phase375_verify.sql` | Applied on hosted |
| `20261014133000_phase375_pgcrypto_path.sql` | Applied on hosted |
| Cutover | Hosted cutover at seq 31657 on 2026-10-14 |
| Historical snapshot | Hashed and batched offchain. `snapshot_committed_at` is the batch time, not original `occurred_at` |
| EventAnchor | Compiled locally. **Not deployed** to Monad Testnet or Mainnet |
| Any Merkle root onchain | **None** |

A file in git is not a migration that has run. Do not claim testnet anchoring works because the contract compiles.

## What a hash actually means

`chogos-event-v1` SHA-256 commits to the canonical document for that row. It is evidence about stored bytes. It is not evidence that the simulation was truthful, that a model vendor produced a decision, or that a token moved.

A live hash chain detects edits to a row when neighbors still point at the old hash. A privileged Postgres operator can still rewrite the whole chain and recompute hashes. Detecting that requires an external commitment published earlier.

A Merkle root is a commitment to a set of event hashes. `onchain_anchor_verified` is only honest after an independent read of `EventAnchor.getBatch` on the recorded chain returns that root.

## Canonical event (`chogos-event-v1`)

UTF-8 text, one field per line, trailing newline. Field order is fixed (`src/lib/verify/canonical.ts` and `verify_event_document` in SQL). Missing scalars are empty. `payload` and `stateTransition` use sorted-key JSON without whitespace. Numbers must be safe integers. Timestamps are UTC with millisecond precision and `Z`. UUIDs are lowercase. `txHash` is lowercase `0x` + 64 hex. Newlines in `summary` become spaces. Hash: SHA-256 of the UTF-8 document, hex with `0x`.

`event_hash` is stored beside the original columns. It does not replace them.

## Cutover and history

Existing rows keep their original timestamps and bodies. Applying the SQL does not hash them. They stay unhashed until `npm run verify:cutover` then `npm run verify:snapshot`. Inserts that happen after the migration file is applied but before cutover also stay unhashed and are eligible for the snapshot. The snapshot is labeled with `snapshot_committed_at` equal to the actual batch time. That is not proof the original `occurred_at` values are true.

New inserts after cutover are sealed as `integrity_class = live` with `prev_event_hash` of the previous live event. Retries use `dedupe_key` and do not insert a second row.

Corrections insert `verification.correction`. They never update the original row. History fields cannot be updated or deleted; triggers enforce that. A superuser can drop triggers. That trust boundary is real.

## Merkle batches

OpenZeppelin `StandardMerkleTree` format `openzeppelin-standard-v1`, leaf type `bytes32` (the event hash), `sortLeaves: false` so sequence order is in the tree shape. Leaf hash is `keccak256(bytes.concat(keccak256(abi.encode(eventHash))))`. Internal nodes use commutative keccak (sorted pairs), matching OpenZeppelin `MerkleProof.sol`. Operator: `npm run verify:batch`. Proofs are stored at batch time so visitors do not trigger unbounded tree builds. The commitment contract stores roots; it does not verify inclusion onchain.

## Public interface

- `/verify` explains statuses and whether a contract address is configured.
- `/verify/events/[id]` recomputes the hash and proof in the browser from the export fields.
- `GET /api/verify/events/[id]` and `?export=1` are read-only and rate-limited. There is no public POST.

Statuses: `unverified`, `event_hash_verified`, `log_integrity_verified`, `merkle_proof_verified`, `onchain_anchor_verified`, `verification_failed`.

## Phase 4 seam

`ai_decisions` gained `citizen_id`, `input_commitment`, `proposed_action`, `validation_result`, `intent_id`, `outcome_event_id`, `event_hash`. `world_intents.decision_id` already exists. Nothing is labeled `source=ai` until a genuine model decision exists. A stored provider or model name is not a provider attestation.

Onchain activity stays `source=onchain` and `chain_status=confirmed` only with a receipt. Simulated trades stay `simulation`.

## Operator commands

```bash
npm run verify:cutover
npm run verify:snapshot
npm run verify:batch
# verify:anchor records a receipt. It never sends a transaction.
```

Testnet deploy steps: [contracts/README.md](../contracts/README.md). Requires explicit authorization. Mainnet is out of scope.
