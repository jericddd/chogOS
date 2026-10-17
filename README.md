# chogOS

One shared, persistent AI civilization for Chog Genesis NFT participants on Monad.

A participating Chog Genesis token is one citizen. Citizens live in one town, share one history, and are moved by one simulation that keeps running when nobody has the site open. An AI mind can choose real actions for those citizens. It cannot spend, sign, or invent token balances.

**Live demo:** [https://chogos.vercel.app/](https://chogos.vercel.app/)

## 60-second walkthrough

1. Open the [living world](https://chogos.vercel.app/). The map is the shared town: houses, workplaces, roads, and citizens.
2. Click a citizen or building, or open [Citizens](https://chogos.vercel.app/citizens) and [Treasury](https://chogos.vercel.app/treasury). Founding citizens are the Chog Genesis NFTs held by the ChogTreasury wallet, checked on Monad.
3. Open [History](https://chogos.vercel.app/activity) and choose **AI decisions**, or go straight to [History filtered to AI](https://chogos.vercel.app/activity?source=ai). Those rows are stored `source=ai` events, not placeholders.
4. Open a **road construction** row (kind `road.placed`) and follow **Verify**, or start from [Verify](https://chogos.vercel.app/verify), which features the latest AI construction event when one exists.
5. On the event page, hashes and the live hash-chain are recomputed in the browser from exported bytes.

Event verification is **offchain**. A matching hash is evidence about stored bytes (`log_integrity_verified` when the hash-chain neighbors match). It is not an onchain proof and not a claim that the simulation told the truth. No event-anchor contract is deployed, and no Merkle root has been published on Monad.

## What works today

Verified against the live site and the production branch `cursor/phase-1-genesis-world-155c` (including the History/Verify discoverability merge from PR #23).

- **Persistent world.** The home page is a pixel-art town. `world_tick()` in Postgres advances citizens, work, movement, and construction whether or not a browser is open. Layout `genesis-v1.1`.
- **NFT identity.** Each citizen is a Chog Genesis token id on Monad mainnet (chain 143). Founding citizens come from the ChogTreasury NFT roster. Owners can [enroll](https://chogos.vercel.app/enroll) a token they currently own; the server checks `ownerOf` and a signature before writing a community citizen.
- **AI decisions.** A hosted runner builds a bounded citizen context, calls the configured model, validates JSON, and inserts an intent only after database rules pass. Rule-based activity stays `source=simulation`. Model-backed outcomes are `source=ai`. Opening the homepage does not call the model.
- **Construction and roads.** The model may propose `build` with a kind (`house`, `farm`, `workshop`, `road`). The server picks the plot or a catalog road stub. The model never writes coordinates. Completed catalog roads are visible on the map and in History.
- **Town facts, not slogans.** Storehouse stock drives town needs. Persistent town projects advance only from those facts and from completed buildings or roads.
- **Recorded history.** [History](https://chogos.vercel.app/activity) lists stored world events. Category **AI** is an alias for `source=ai`. [Verify](https://chogos.vercel.app/verify) exposes SHA-256 event hashes, a live hash-chain, and optional Merkle batches.

## Architecture

| Piece | Role |
| --- | --- |
| **Next.js 16** (App Router, React 19) | Public UI and read APIs (`GET /api/world/live`, `GET /api/world/events`, verify exports). Deployed at [chogos.vercel.app](https://chogos.vercel.app/). |
| **Supabase / Postgres** | Civilization and world state. Row-level security keeps the anon key from reading tables. The service role is server-only. |
| **World engine** | `world_tick()` is a SQL function. Hosted `pg_cron` calls it on a short interval so the clock is not a page view. |
| **AI runner** | Separate from the tick. `POST /api/ai/run` is bearer-protected and disabled until `AI_RUNNER_ENABLED=true`. A [GitHub Action on `main`](.github/workflows/ai-mind.yml) pokes the live URL every 30 minutes. It does not tick the world. |
| **Browser** | Renders the canvas from server reads. Optional Realtime is a refetch nudge only. Visitors observe; they do not steer citizens. |

Application source for the live site lives on [`cursor/phase-1-genesis-world-155c`](https://github.com/jericddd/chogOS/tree/cursor/phase-1-genesis-world-155c), not on this default branch. This `main` branch is the GitHub default so the AI mind schedule can run. It still contains the earlier Phase 0 application tree.

## Simulated vs onchain

| Thing | What it is |
| --- | --- |
| Food, wood, stone, tools | Simulation counts in the Storehouse. **Not** token balances, **not** `$CHOG`, **not** MON. |
| Walking, work, sleep, social visits | Rule-based simulation (`source=simulation`). |
| AI-labeled History rows | Persisted outcomes of a validated model decision (`source=ai`). |
| Citizen identity | Chog Genesis NFT token ids; founding roster and enrollment check Monad. |
| Event hashes / Verify | Offchain commitment to stored bytes. **Not** onchain anchoring. |
| Civilization Treasury | A separate record from the ChogTreasury NFT wallet. No spending address is configured. |
| Citizen smart accounts | Designed, **not deployed**. |
| `POST /api/transactions` | Always **403**. No module holds a private key or seed phrase. |

The AI cannot spend. A model sentence does not move tokens, complete a building, or place a road by itself.

## Stack and local development

Live-app stack, from the production `package.json`:

- Next.js 16.4.0, React 19.3.0, TypeScript
- Tailwind CSS 4
- `@supabase/supabase-js` and `@supabase/ssr`
- viem (read-only Monad access)
- zod
- `@openzeppelin/merkle-tree` (event batches)
- Vitest for tests

To run **the living world** locally, check out the production branch first. `npm run dev` on this default `main` branch still starts the Phase 0 shell, not the live civilization.

```bash
git clone https://github.com/jericddd/chogOS.git
cd chogOS
git checkout cursor/phase-1-genesis-world-155c
npm install
cp .env.example .env.local   # add your own values; never commit this file
npm run dev
```

Commands on that branch:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm start
npm run verify:contracts
```

`verify:contracts` hits public Monad RPCs. It does not print holder addresses or balances.

Do not run `world:init`, `world:runner`, `ai:runner`, or other operator scripts against production. They need secrets and they write world or AI state. There is no place in `.env.example` for a private key or a seed phrase.

## Limitations

These are still true:

- GitHub’s default branch is `main`. It is not the living-world application tree. Do not treat a clone of `main` as the live product.
- Event-chain verification is offchain. The EventAnchor contract is not deployed. No Merkle root is on Monad.
- No citizen smart account, no autonomous wallet, no treasury spending, no onchain event anchoring.
- [Economy](https://chogos.vercel.app/economy) and [Businesses](https://chogos.vercel.app/businesses) are leftover routes. The Civilization Treasury has no configured spending address. No business has been recorded.
- Simulated goods are capped Storehouse counts, not an onchain economy.
- The AI runner is rate-limited and separate from the world clock. A Gemini quota or timeout does not stop `world_tick()`.

Completed work (living world, NFT roster, AI intents, catalog roads, hashed history) is live. It is not “planned.”
