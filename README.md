# Chog Civilization

Phase 0 foundation for one shared AI civilization on Monad. A participating Chog Genesis token id is one citizen. Citizens share one government, one economy, and one history. This repository is the application shell, the data model, and the security boundary. It does not deploy contracts, sign transactions, or invent balances.

## Stack

- Next.js 16 App Router, React 19, and TypeScript
- Tailwind CSS 4
- Supabase Postgres, through `@supabase/supabase-js` and `@supabase/ssr`
- viem for read-only Monad access
- A server-side AI provider interface with `none`, `openai`, and `anthropic`

The dashboard runs without Supabase or an AI key. Those services stay empty until you add them.

## Scripts

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
npm run verify:contracts
```

`verify:contracts` calls the public Monad RPCs. It checks chain ids, the Chog Genesis NFT, the $CHOG proxy, and the presence of bytecode at the wallet-infrastructure addresses recorded in [docs/contracts.md](docs/contracts.md). It does not print holder addresses or wallet balances.

## Environment

Copy `.env.example` to `.env.local` when you have values to add. Do not commit `.env.local`. The service role key and the AI key are server-only. This phase has no place to put a private key or a seed phrase, and it should not gain one.

## Layout

```text
src/app/                  dashboard routes and the disabled transaction route
src/components/           shell and page components
src/lib/ai/               provider interface, not called by the dashboard
src/lib/blockchain/       chains, recorded addresses, read helpers
src/lib/config/env.ts     environment parsing
src/lib/db/               Supabase clients and row types
src/lib/placeholder/      sample dashboard data
supabase/migrations/      initial Postgres schema
docs/                     architecture, database, wallets, contract evidence
scripts/verify-contracts.ts
```

## What is real on the dashboard

The overview states that enrollment is closed, the treasury is not deployed, and no balance is shown. Contract rows repeat a check made on 10 October 2026. They are labeled as a recorded check, not a live wallet reading.

Sample citizens, the sample workshop, and the sample history are marked placeholder. They are not token holders and they are not transactions.

`POST /api/transactions` always returns 403. The AI provider has no tools and is not attached to a route.

## Documents

- [Architecture](docs/architecture.md)
- [Database plan](docs/database.md)
- [Wallet system](docs/wallet-system.md)
- [Contract evidence](docs/contracts.md)

## Phase 1

1. Create a Supabase project and run `supabase/migrations/20261010180000_initial_schema.sql` in the SQL editor. Confirm the anon key cannot select from `citizens`. Row level security is on, there are no policies, and the anon and authenticated grants are revoked.
2. Add a read-only ownership check for a Chog Genesis token id on Monad mainnet (chain 143). These contracts have no code on testnet, so testnet cannot prove ownership of this collection.
3. Insert a citizen only after the current `ownerOf` result signs an enrollment message. Store the block number of that read. A typed token id is not enrollment.
4. Replace the placeholder citizen, business, and activity panels with database reads. When a balance is shown, read it from Monad at a stated block. A `balance_observations` row may appear only as a labeled past reading.
5. Write the wallet design down to specific audited bytecode before any deployment. Hash-check the Safe singleton, the Safe proxy factory, and the chosen ERC-4337 EntryPoint against published artifacts. The design is in [docs/wallet-system.md](docs/wallet-system.md). Do not deploy it in that step.
6. Keep AI output in `ai_memories` and `ai_decisions`. Do not add spending tools. Leave `POST /api/transactions` as a refusal until a wallet can enforce the permission itself.
7. Before any trade, swap, business wallet, or contract deployment, write the legal and spending limits into the wallet policy. The model prompt is not the control.
