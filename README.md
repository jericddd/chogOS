# chogOS

One shared civilization for Chog Genesis citizens on Monad. A participating token id is one citizen. Founding citizens are the NFTs held by the ChogTreasury wallet. Community owners can enroll NFTs they currently control. Phase 2 records citizen wallet assignments and a separate Civilization Treasury. Phase 3 puts every citizen into a persistent pixel-art world on the home page, run by one simulation inside the database. No citizen smart account is deployed, no treasury address is configured, and the AI mind cannot spend.

## Stack

- Next.js 16 App Router, React 19, and TypeScript
- Tailwind CSS 4
- Supabase Postgres, through `@supabase/supabase-js` and `@supabase/ssr`
- viem for read-only Monad access
- A server-side AI provider interface with `none`, `gemini`, `openai`, `anthropic`, and `ajax`

The world renders without Supabase. Founding records and enrollment are stored only after Supabase is configured. The dashboard does not call the AI provider. The optional mind runner is a separate server route and stays off until `AI_RUNNER_ENABLED=true`. GitHub Actions can poke it every 30 real minutes so Hobby Vercel Cron is not the only timer.

## Scripts

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:contracts
npm run discover:treasury
npm run world:init
npm run world:expand
npm run world:admin -- status
npm run world:runner
npm run ai:runner
npm run ai:smoke
npm run world:speed-report
npm run verify:cutover
npm run verify:snapshot
npm run verify:batch
npm run verify:contracts-local
```

`verify:contracts` checks the public Monad RPCs and does not print holder balances. `discover:treasury` reads ChogTreasury NFT holdings from the collection contract and confirms each id with `ownerOf`. The `world:*` commands found, inspect, and tick the Phase 3 world with the service role key from a trusted machine. They are described in [docs/phase-3.md](docs/phase-3.md).

## Environment

Copy `.env.example` to `.env.local`. Do not commit `.env.local`. The service role key, indexer key, sync secret, world runner secret, and AI key are server-only. The anon key is optional and only joins the world's Realtime broadcast. There is no place to put a private key or a seed phrase.

Setup for the database, the optional indexer, and enrollment is in [docs/phase-1.md](docs/phase-1.md).

## What the world shows

The home page is the living world: a canvas map of homes, workplaces, and citizens, with inspectors and a history feed below it. Activities, movement, production, and construction are simulated by fixed rules and labeled `simulation`. The resources are simulated counts, not tokens. Visitors can watch and inspect but cannot control anything.

The citizen gallery, Genesis Treasury, and history read Monad when the RPC is reachable. Treasury NFT counts are Chog Genesis holdings, not `$CHOG` balances. If the verified count is not the expected comparison figure, the page says so. Missing metadata uses local artwork. The activity feed lists stored events only.

`POST /api/transactions` still returns 403. The AI provider has no tools and no wallet authority. `AI_PROVIDER=ajax` refuses before any network call. Gemini is the Phase 4 adapter. Production still needs the SQL paste, API key, and Vercel env in [docs/activate-ai.md](docs/activate-ai.md) before the mind runs with your PC off.

## Documents

- [Phase 1 setup](docs/phase-1.md)
- [Phase 2 wallets and treasury](docs/phase-2.md)
- [Phase 3 living civilization](docs/phase-3.md)
- [Phase 3.75 verifiable history](docs/phase-3.75.md)
- [Phase 4 AI mind](docs/phase-4.md)
- [Phase 5 civil works](docs/phase-5.md)
- [Turn the AI mind on](docs/activate-ai.md)
- [Architecture](docs/architecture.md)
- [Database plan](docs/database.md)
- [Wallet system](docs/wallet-system.md)
- [Contract evidence](docs/contracts.md)

## Phase 2

Citizen identity stays `(chain id, NFT contract, token id)`. A wallet row is an assignment for that citizen, not a new identity. The only scheme stored in this phase is `unassigned`, and the only status the app writes is `not_configured`. No address is predicted, and no smart account is deployed.

The Civilization Treasury is a different record from the ChogTreasury NFT wallet. It starts with no address. An administrator can later submit an address and a funding hash through server routes that check Monad. Those routes do not send transactions.

Setup, the hash-checked Safe infrastructure, and the remaining blockers are in [docs/phase-2.md](docs/phase-2.md).

## Phase 3

`20261013040000_phase3_world.sql` adds the world tables and a `world_tick()` function that `pg_cron` runs every few seconds. The world moves at 60× (one world day is 24 real minutes). This speed was chosen from measured runs of the real engine. The browser reads only through `GET /api/world/live` and `GET /api/world/events`. The optional anon key is used only for a Realtime nudge. Nothing in the world is labeled `ai` or `onchain`, because neither source exists yet.

Setup, the time model, the rules, the downtime behavior, and the Phase 4 action interface are in [docs/phase-3.md](docs/phase-3.md). The mind itself is in [docs/phase-4.md](docs/phase-4.md). Do not claim it is live until Gemini, the runner, and a persisted `source=ai` outcome have been verified.

## Phase 3.75

History can be sealed with a canonical SHA-256, a live hash chain, and OpenZeppelin Merkle batches. `/verify` is read-only. The EventAnchor contract is not deployed. No root has been verified on Monad. Setup is in [docs/phase-3.75.md](docs/phase-3.75.md).

## Phase 5a

The mind may propose `build` with `buildKind` `house`, `farm`, `workshop`, or `road`. Houses, farms, and workshops still land on a vacant road-served lot chosen by the server. A road must name a catalog stub such as `east-y2-64`; coordinates come only from that catalog. Completed overlay tiles merge into pathfinding and can serve the reserved east `y=2` lots when a door actually touches the new road. Phase 5c town needs are unchanged. Setup is in [docs/phase-5.md](docs/phase-5.md). Additive SQL is not live on hosted Supabase until an operator pastes it.
