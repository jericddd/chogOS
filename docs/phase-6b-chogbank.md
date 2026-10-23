# Phase 6b — AI-driven wallet activation and ChogBank gas sponsorship

Date: 17 October 2026.
Base: production `cursor/phase-1-genesis-world-155c`.
Status on 17 October 2026: **implementation and review only**. That day's note recorded no Mainnet broadcast and no factory deploy. `CitizenAccountFactoryV3` and ChogBank were deployed later. The live record is [README.md](../README.md). The V1 factory prediction in this file is still empty and stays unused.

## What already existed (Phase 6a)

- CREATE2 `CitizenAccountFactory` + NFT-bound `CitizenAccount` with immutable `(boundChainId, nftContract, tokenId)`.
- Root authority is live `ownerOf`. `grantDelegation` / `executeDelegated` revert `DelegationDisabled` because `ownerAtGrant == currentOwner()` revives after A→B→A.
- Production registry writes stay `unassigned` / `not_configured`. Enrollment does not predict or deploy an account.
- `/api/transactions` still calls `assertExecutionDisabled` (403).
- The AI runner proposes world actions and construction. It does not sign. World tick does not call RPC.
- V1 factory prediction `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` is empty on live Monad 143 and **must stay unused**. Session bytecode is a different init code hash.

## What changed

V1.1 account sessions (smallest on-chain AI path that does not reuse the revival hole):

- The NFT owner may `openSession` for one executor, one target, one selector, per-call and cumulative value caps, and a TTL ≤ 30 days.
- `syncOwner()` latches `session.dead` when `ownerOf` differs from `lastSeenOwner` and increments `ownerEpoch`.
- `invalidateSession` is callable by the executor or current owner. The relayer must call it after any `Transfer` log after `openedBlock`.
- A→B→A with **no** account call is still invisible on-chain (Genesis has no epoch or callback). Tests document that residual. A backend gas payer does not replace this check.
- Factory salt is now `keccak256("chogOS.CitizenAccountFactory.v1.1")`. Predicted factory: `0xA2edAC990B30A488D61fc4607D4365b22e41e39c`. Predicted ≠ deployed.

ChogBank (TypeScript policy + additive, unapplied SQL):

- AI action `request_wallet_activation` is optional. Ordinary citizens keep living without a wallet.
- The bank approves, rejects, or defers. It reserves deployment gas and sponsored tx gas separately from business capital.
- On 17 October 2026 the Next.js runtime was fail-closed: treasury source `unset`, factory flag unset, relayer disabled, no signer in the web process. The website still does not sign. The factory on Monad is the one in the README.
- Jobs are persisted intents. Nothing in this PR broadcasts.

## AI-driven activation

1. The model may return `request_wallet_activation` with motive, goal, proposed onchain actions, revenue hypothesis, and integer wei estimates.
2. The model cannot set spending limits, approve funding, or mark a transaction confirmed.
3. The runner records the intent on `ai_decisions` and evaluates ChogBank with the fail-closed production runtime. It does not call RPC and does not wait for a receipt.
4. Rejected or deferred citizens may request again later. In-flight identities cannot get a second account.

## ChogBank decisions

Inspected before approval: configured treasury observation, available − held, request purpose, estimated costs, daily gas, exposure cap, factory code-verified flag, relayer enabled flag.

| Condition | Result |
| --- | --- |
| No treasury source, zero available MON, missing cost estimate, factory not deployed, relayer disabled, daily gas exhausted, insufficient MON | `deferred` |
| Fabricated / vague purpose, existing in-flight or active account, over per-citizen or exposure limits | `rejected` |
| All checks pass | `approve` and hold reservations |

Available capital is only an injected or later-observed balance. This milestone never writes a live treasury observation.

## Sponsored gas

Intended path: AI proposes → policy → reservation → relayer pays network fees from a bank reserve → receipt reconciled.

This PR ships a **disabled** relayer and a scripted test double. `loadProtectedSigner` refuses `CHOG_BANK_*` private-key env vars and never copies them into a signer. `/api/transactions` remains 403.

Gas spend is ledger bucket `sponsored_gas_spent` or `deployment_spent`. It is not `business_capital`. Unused holds are released. Failed or reverted jobs do not count as spend.

The relayer may only queue `factory.create`, `account.executeSession`, and `account.invalidateSession`. Paying gas does not grant `execute` (owner-only) or treasury control.

## AI execution authorization

On-chain, not prompt-only:

- Owner `execute` still follows live `ownerOf`.
- Restricted AI path is `executeSession` after `openSession`.
- Relayer (executor) cannot open the session. The NFT owner must.
- Transfer logs after `openedBlock` force `invalidateSession` even if `ownerOf` currently matches `ownerAtOpen`.
- An account is `deployed` only when bytecode is observed. It is `active` only after a live session is recorded.

Bytecode change: V1 predicted factory `0x2d8c32…` is incompatible with V1.1 and must not be deployed. V1.1 predicted `0xA2edAC99…` is also empty until an authorized broadcast.

## Mocked versus real

| Item | State |
| --- | --- |
| CitizenAccount / factory source | In repo. Not deployed on 143. |
| V1.1 factory `0xA2edAC99…` | Predicted only. |
| Relayer / treasury signer | Disabled. Test script only. |
| Hosted `chogbank_*` tables | Migration file only. Not applied. |
| Production registry | Still `unassigned` / `not_configured`. |
| AI activation in the runner | Records intent; production bank always defers. |
| World simulation | Unchanged; tick has no RPC. |

## Mainnet enablement prerequisites (do not do these in this PR)

1. Written authorization of a factory deployer. Broadcast V1.1 only, never V1 `0x2d8c32…`.
2. Confirm `cast codesize` / runtime keccak of the factory on chain 143.
3. Paste-apply `20261017220000_phase6b_chogbank.sql` on hosted Supabase (operator, not this agent).
4. Configure a real economic treasury. Observe its MON balance. Do not invent it.
5. A protected signer backend that is not an env private key in git, the browser, or the model.
6. NFT owners `openSession` for the relayer executor with tight target/selector/value/TTL.
7. An indexer that feeds Transfer logs into `invalidateSession`.
8. Keep `/api/transactions` closed until those exist. Keep world tick free of RPC.

## Residual risks

- A→B→A with no account call and no Transfer-log watcher still leaves `executeSession` valid until something calls the account.
- Owner `execute` is unrestricted for the current holder.
- No third-party audit.
- Zero observed treasury means every live activation stays deferred. That is required, not a bug.
