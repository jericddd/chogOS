# Architecture

Chog Civilization is one shared society for participating Chog Genesis NFTs on Monad. One eligible token id is one citizen. Citizens share a government, an economy, and a history. Each citizen will later have a unique smart-contract wallet. The civilization treasury is a different wallet. The AI reasons off-chain and may only cause a chain action that a wallet policy already allows.

Phase 0 builds the application boundary for that system. It does not deploy contracts, connect a signer, or present database rows as balances.

## Frontend

The Next.js App Router renders a small dashboard: overview, citizens, economy and treasury, businesses, and activity. Pages are server components. The navigation is the only client component, and it exists to mark the current page.

Placeholder sections are labeled in the page and in the data module `src/lib/placeholder`. Recorded contract facts come from `src/lib/blockchain/recorded-check.ts`, which is a dated observation, not a live balance query.

The interface does not connect a browser wallet.

## Backend

Server modules live under `src/lib`. There is no enrollment API yet.

- `src/lib/config/env.ts` reads deployment settings and refuses malformed addresses and URLs. Error text names the variable, not the secret.
- `src/lib/db/client.ts` can open a Supabase service-role client or a cookie-backed anon client. Pages do not call either one. The service role bypasses row level security and is imported behind `server-only`.
- `POST /api/transactions` returns 403 from `TransactionExecutionDisabledError`. It ignores any request body.

## Database

Supabase Postgres holds civilization state that is not itself a token balance: enrollment, life, skills, jobs, relationships, businesses, AI memory, decisions, proposals, and receipts. The schema is `supabase/migrations/20261010180000_initial_schema.sql`, explained in [database.md](database.md).

A balance observation stores a raw integer and the block it was read at. Spending code must read Monad again. A business ledger line is marked verified only when it points at a receipt row.

## AI decision-making

`AiProvider` can complete a text request through OpenAI-compatible chat completions or the Anthropic messages API. The default provider is `none`, and calling it throws. The interface has no tool list, no wallet client, and no route.

Later, a decision is written to `ai_decisions` before anyone prepares a proposal. Acceptance of a decision is still not permission to move funds. The wallet has to accept the call.

## Blockchain reading

viem supplies the Monad chain objects. Their chain ids are 143 and 10143, and their default HTTP RPCs are `https://rpc.monad.xyz` and `https://testnet-rpc.monad.xyz`, matching Monad's network documentation. Explorer URLs in this repo follow that documentation.

`createChainClient` builds a public client. It has no account. `src/lib/blockchain/reads.ts` exposes NFT and token metadata reads for later server code. The dashboard does not call it, so a page render does not depend on the RPC.

The Chog Genesis read ABI is a subset of the verified ABI stored in `src/lib/blockchain/abi/chog-genesis.json`. The $CHOG ABI lists only view functions that returned data. Details and limits are in [contracts.md](contracts.md).

`npm run verify:contracts` repeats the chain checks.

## Transaction execution

No module imports a private key, a mnemonic, or a wallet client. `assertExecutionDisabled` throws if a future caller tries to pass through the Phase 0 guard. The public HTTP path is the 403 route above.

Real economic activity, when it exists, has to be a Monad transaction with a stored receipt. A proposal row is only an intention.

## Citizen wallets and the treasury

The recommended design is a dedicated smart-wallet factory, not a token-bound account as the whole system. Citizen accounts are created per Chog Genesis token id. Business accounts are created without consuming one of the 1,969 genesis tokens. The shared treasury is a separate Safe. The comparison is in [wallet-system.md](wallet-system.md).

Nothing in that design is deployed.

The NFT contract's `treasury()` address is the collection's mint receiver. It is not the civilization treasury.

## Security boundary

| Concern | Phase 0 rule |
| --- | --- |
| Private keys and seed phrases | Not requested, not stored, not accepted in configuration |
| AI process | Can draft text only. It cannot sign |
| Service role key | Server environment only |
| Anon Supabase key | No table grants and no policies |
| Database balances | Historical RPC readings, never spendable truth |
| Treasury funding | A later manual transfer by the administrator into a deployed treasury wallet |
| Contract deployment | Out of scope |
| Legal and spending limits | Must be enforced by the wallet before autonomous trading exists |

The administrator funds the treasury manually after that wallet exists. The AI does not receive the administrator key.

## Living world (Phase 3)

The simulation is a single PL/pgSQL function, `world_tick()`, scheduled by `pg_cron`. No browser or Next.js request drives it, so the world advances whether anyone is watching or not. The Next.js server reads world state with the service role and serves it through `GET /api/world/live` and `GET /api/world/events`. The browser renders a canvas map from that data. It joins a Realtime broadcast channel only as a signal to refetch. Rules, the time model, and the Phase 4 intent table are in [phase-3.md](phase-3.md).

## Intentionally absent

Enrollment, authentication, live balance display, contract deployment, swaps, DeFi adapters, and autonomous operation are later phases. The schema and the provider interface are here so those phases have a place to land without turning the project into a chatbot or a simulated economy.
