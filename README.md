# chogOS

An AI mind on Gemini runs this civilization and decides what it does.

One shared civilization for Chog Genesis NFTs on Monad mainnet. The token id is the citizen. The portrait on the map is that NFT. Gemini decides growth, which citizen receives a wallet, and whether MON is allocated. The world clock still moves people by the town's rules. The model does not sign.

Live app: [https://chogos.vercel.app/](https://chogos.vercel.app/)

This branch, `cursor/phase-1-genesis-world-155c`, is the application source. GitHub's default branch `main` exists so the Actions schedule can run. The files on `main` outside that workflow are an older Phase 0 shell. This README is the deployment record.

The facts below were read from the live app and from Monad mainnet on 23 October 2026 at 10:38 AM Asia/Manila. Balances and the citizen count move. The World and Economy pages are the live numbers.

## What a visitor can do

The app has six tabs: World, Citizens, Economy, History, Verify, and Enroll. `/treasury` redirects to `/economy`.

The World page is a pixel-art town. Citizens are in houses, fields, the market, and public places such as Commons Hall. Clicking a figure opens that Chog's life. A visit on the map stays on the map. Money moves only when a Monad receipt is stored.

The clock runs at 60×. One world hour is one real minute, so one world day is 24 real minutes. `world_tick()` in Postgres advances the world when no browser is open. At the check above, the town had 61 citizens: 60 founding citizens from the ChogTreasury roster, and 1 community citizen enrolled by the wallet that held that NFT.

Enroll connects a wallet that currently holds a Chog Genesis NFT, asks that wallet to sign a confirmation, and lets the holder choose one token. Treasury-held Chogs are already founding citizens.

History lists stored events. Simulation rows are rule-based. System rows include each Chog that joined. AI rows show the mind's stored reason. Onchain rows link Monadscan when a receipt, citizen wallet, factory, or Genesis token was stored.

Verify recomputes the SHA-256 of the stored event in the browser. `log_integrity_verified` means that hash check passed. It is a check of stored bytes. EventAnchor is not deployed, and this app has not published a Merkle root on Monad.

## Who signs

The model does not hold a key and does not sign. It can record a town-growth decision, a wallet-issuance decision, or a MON allocation review. A review is not a transfer.

The website does not sign or broadcast. `POST /api/transactions` returns 403. The Next.js process refuses `CHOG_BANK_AUTHORIZER_PRIVATE_KEY`, `CHOG_WALLET_AGENT_KEY`, `CHOG_WALLET_AGENT_PRIVATE_KEY`, and `CHOG_BANK_AUTHORIZER_KEY`.

GitHub Actions on `main` runs `.github/workflows/ai-mind.yml` on the schedule `*/10 * * * *`, and when someone starts it by hand. GitHub may start that schedule later than the expression. The workflow has three jobs:

1. `run` calls the production mind. The poke waits up to 290 seconds and retries once. If work is still open at 250 seconds of function time, the route returns the decisions already saved and the next poke continues.
2. `issue` uses the wallet agent key to create a citizen wallet from an accepted issuance decision. The gas key pays that transaction. This job still runs when the mind poke fails, so a timeout does not leave an accepted wallet uncreated.
3. `pay` uses the ChogBank authorizer key to sign an accepted MON allocation, and the gas key to submit `distribute`. The agent key is not used for payouts. This job still runs after a failed poke when wallet issuance succeeds.

Those keys are GitHub Actions secrets. They are not in this repository, and the website does not receive them. The agent key can move MON out of a citizen wallet, because `CitizenAccountV3` authorizes calls with that one key. The NFT holder does not control the citizen wallet.

## Monad mainnet (chain 143)

| What | Address | What it is |
| --- | --- | --- |
| Chog Genesis | `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` | Pre-existing NFT. One token id is one citizen. |
| $CHOG | `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777` | Pre-existing token. 18 decimals. |
| ChogTreasury | `0x84113421A8a564b594ee9Ae78c875310332d7023` | Holds founding Chogs. This is the NFT holder, not the economic treasury, and not a citizen wallet. |
| ChogBank | `0xB2494538433B2FA3167A723d32329cc22c3A59C1` | Deployed treasury contract. Creation tx `0x665d3b3c0e9a37e6c54242aa29e5d6efb65d536e9bf777901f006d05abb8c0d4`, block `115672361`. |
| Authorizer | `0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04` | Public address of the spending signer. It has no contract code. |
| Gas payer | `0x40C20bF79Eed165D8Ac4970ccE7e257B63D2A806` | Public address that pays gas. It has no contract code. It is not the authorizer and not the wallet agent. |
| Wallet factory | `0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A` | `CitizenAccountFactoryV3`. It has code. `agent()` returns `0x18229E45A24FB96f3c2d551adb406Db2F7d14358`. |
| Wallet agent | `0x18229E45A24FB96f3c2d551adb406Db2F7d14358` | Public address only. The key is not in this repo. |

ChogBank has no `owner`, no administrator, no proxy, and no upgrade function. That describes this contract. The authorizer remains a privileged signer inside the caps below. It cannot change the caps, upgrade the contract, or pay an arbitrary address. The recipient of a payment has to be the deployed citizen wallet for that token id.

At the check above, ChogBank held **30 MON** and **369.97132121875218252 $CHOG**.

The contract caps are immutable: **0.01 MON** per transaction, **0.05 MON** per citizen, **0.05 MON** aggregate, a **86400**-second window, and an authorization lifetime of at most **3600** seconds. The contract cap on **$CHOG is 1 wei** per transaction, per citizen, and for the whole bank in each window. The Economy page also shows higher application review limits. A broadcast is reduced to the contract caps. A payout above those caps reverts.

Confirmed wallet issuances are Monad transactions. Token 91 is one of them. A Proposed issuance has not been broadcast. Not every citizen has a wallet yet.

The economy rows returned at that check were wallet issuances. A MON distribution is a separate stored receipt. `$CHOG` stays at the 1 wei cap until a confirmed MON distribution receipt is stored.

These addresses have code and are not chogOS deployments. Do not fund them:

| Address | What it is |
| --- | --- |
| `0x2d8c32B8Df4E57a18A96fa2830DE036A781B472c` | Unused V1 factory prediction |
| `0xA2edAC990B30A488D61fc4607D4365b22e41e39c` | Unused V1.1 factory prediction |
| `0x8a74Ea74EB0674EF4DC178263E4583FB502B77AD` | Unused V2 factory prediction |
| `0x8035CA34410c19B1Bf0673Ad973Fe1cf91a7b632` | Unused V2 implementation prediction |

`CitizenAccountV2` is not the citizen wallet. Do not deploy it.

## What stays simulated

Food, wood, stone, and tools on the map are counts in the simulated storehouse. They are not MON and they are not `$CHOG`. Walking, work, and sleep come from simulation rules. An AI reason is the text the mind stored. It becomes an onchain fact only when a receipt is stored beside it.

## Source comments

`contracts/src/ChogBank.sol`, `CitizenAccountFactoryV3.sol`, and `CitizenAccountV3.sol` were compiled with a NatSpec line that said they were not deployed. That line is corrected in this tree. A fresh compile embeds a different metadata suffix, so the bytecode already on Monad will not hash-match a rebuild of these files. The creation transaction above is the ChogBank deployment. Monadscan source verification for ChogBank was not recorded by the app.

Files in `docs/` are phase journals. Where a journal disagrees with this README about what is deployed, this README is the record.

## Stack

- Next.js 16.4.2, React 19, TypeScript, Tailwind CSS 4
- Supabase Postgres
- viem, read-only in the website
- Solidity and Foundry for ChogBank and the citizen wallets
- Gemini, called by the Actions runner, not by a page view

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.example` has public addresses and empty secrets. Do not put a private key, mnemonic, or seed phrase in it or in git.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:contracts
```

`verify:contracts` reads the public Monad RPCs and does not print holder balances.

Chog Genesis and `$CHOG` existed before this repository. chogOS is the town, the citizen wallets, ChogBank, and the public record around them.
