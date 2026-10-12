# chogOS

One shared civilization for Chog Genesis citizens on Monad. A participating token id is one citizen. Founding citizens are the NFTs held by the ChogTreasury wallet. Community owners can enroll NFTs they currently control. Phase 2 records citizen wallet assignments and a separate Civilization Treasury. No citizen smart account is deployed, no treasury address is configured, and the AI mind cannot spend.

## Stack

- Next.js 16 App Router, React 19, and TypeScript
- Tailwind CSS 4
- Supabase Postgres, through `@supabase/supabase-js` and `@supabase/ssr`
- viem for read-only Monad access
- A server-side AI provider interface with `none`, `openai`, `anthropic`, and `ajax`

The world renders without Supabase. Founding records and enrollment are stored only after Supabase is configured. The dashboard does not call the AI provider.

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
```

`verify:contracts` checks the public Monad RPCs and does not print holder balances. `discover:treasury` reads ChogTreasury NFT holdings from the collection contract and confirms each id with `ownerOf`.

## Environment

Copy `.env.example` to `.env.local`. Do not commit `.env.local`. The service role key, indexer key, sync secret, and AI key are server-only. There is no place to put a private key or a seed phrase.

Setup for the database, the optional indexer, and enrollment is in [docs/phase-1.md](docs/phase-1.md).

## What the world shows

The home scene, citizen gallery, Genesis Treasury, and history read Monad when the RPC is reachable. Treasury NFT counts are Chog Genesis holdings, not `$CHOG` balances. If the verified count is not the expected comparison figure, the page says so. Missing metadata uses local artwork. The activity feed lists stored events only.

`POST /api/transactions` still returns 403. The AI provider has no tools and no wallet authority. `AI_PROVIDER=ajax` refuses before any network call.

## Documents

- [Phase 1 setup](docs/phase-1.md)
- [Phase 2 wallets and treasury](docs/phase-2.md)
- [Architecture](docs/architecture.md)
- [Database plan](docs/database.md)
- [Wallet system](docs/wallet-system.md)
- [Contract evidence](docs/contracts.md)

## Phase 2

Citizen identity stays `(chain id, NFT contract, token id)`. A wallet row is an assignment for that citizen, not a new identity. The only scheme stored in this phase is `unassigned`, and the only status the app writes is `not_configured`. No address is predicted, and no smart account is deployed.

The Civilization Treasury is a different record from the ChogTreasury NFT wallet. It starts with no address. An administrator can later submit an address and a funding hash through server routes that check Monad. Those routes do not send transactions.

Setup, the hash-checked Safe infrastructure, and the remaining blockers are in [docs/phase-2.md](docs/phase-2.md).
