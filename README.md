# chogOS

An AI mind on Gemini runs this civilization and decides what it does.

One shared civilization for Chog Genesis NFTs on Monad mainnet. The token id is the citizen. The portrait on the map is that NFT. Gemini decides growth, which citizen receives a wallet, and whether MON is allocated. The world clock still moves people by the town's rules. The model does not sign.

Live app: [https://chogos.vercel.app/](https://chogos.vercel.app/)

This default branch exists so GitHub Actions can run the schedule in [`.github/workflows/ai-mind.yml`](.github/workflows/ai-mind.yml). The application source is [`cursor/phase-1-genesis-world-155c`](https://github.com/jericddd/chogOS/tree/cursor/phase-1-genesis-world-155c). The other files on `main` are an older Phase 0 shell. They are not the live app. `npm run dev` on `main` does not start the town.

The facts below were read from the live app and from Monad mainnet on 23 October 2026 at 10:38 AM Asia/Manila. Balances and the citizen count move. The World and Economy pages are the live numbers. The longer record is the README on the application branch.

## What is live

The app has six tabs: World, Citizens, Economy, History, Verify, and Enroll. `/treasury` redirects to `/economy`.

The world runs at 60×. One world hour is one real minute, so one world day is 24 real minutes. `world_tick()` in Postgres advances it when no browser is open. At the check above, the town had 61 citizens: 60 founding citizens from the ChogTreasury roster, and 1 community citizen enrolled by the wallet that held that NFT. Enrollment asks that wallet to sign a confirmation.

Food, wood, stone, and tools on the map are simulated counts. They are not MON and they are not `$CHOG`. Verify recomputes a SHA-256 of the stored event in the browser. `log_integrity_verified` is that check. EventAnchor is not deployed, and this app has not published a Merkle root on Monad.

The model does not hold a key and does not sign. A review is not a transfer. The website does not sign or broadcast. `POST /api/transactions` returns 403.

## Who signs

The workflow on this branch is scheduled `*/10 * * * *`, and it can be started by hand. GitHub may start that schedule later than the expression. It checks out the application branch and has three jobs:

1. `run` calls the production mind. The poke waits up to 290 seconds and retries once.
2. `issue` uses the wallet agent key to create a citizen wallet. The gas key pays that transaction. This job still runs when the mind poke fails, so a timeout does not leave an accepted wallet uncreated.
3. `pay` uses the ChogBank authorizer key to sign an accepted MON allocation, and the gas key to submit `distribute`. The agent key is not used for payouts. This job still runs after a failed poke when wallet issuance succeeds.

Those keys are GitHub Actions secrets. They are not in this repository, and the website does not receive them. The agent key can move MON out of a citizen wallet. The NFT holder does not control the citizen wallet.

## Monad mainnet (chain 143)

| What | Address |
| --- | --- |
| Chog Genesis | `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` |
| $CHOG | `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777` |
| ChogTreasury, the NFT holder | `0x84113421A8a564b594ee9Ae78c875310332d7023` |
| ChogBank | `0xB2494538433B2FA3167A723d32329cc22c3A59C1` |
| ChogBank creation | `0x665d3b3c0e9a37e6c54242aa29e5d6efb65d536e9bf777901f006d05abb8c0d4`, block `115672361` |
| Authorizer | `0x485f614a9Bd37421cfe6fe53e89294C2a19C8b04` |
| Gas payer | `0x40C20bF79Eed165D8Ac4970ccE7e257B63D2A806` |
| Wallet factory | `0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A` |
| Wallet agent | `0x18229E45A24FB96f3c2d551adb406Db2F7d14358` |

ChogBank has code, and it has no owner, no administrator, no proxy, and no upgrade. The authorizer is still a privileged signer. It can sign allocations only inside the contract caps, and only to a deployed citizen wallet. It cannot change the caps or pay an arbitrary address. The authorizer and gas addresses have no contract code.

At the check above, ChogBank held **30 MON** and **369.97132121875218252 $CHOG**.

Contract caps, immutable: **0.01 MON** per transaction, **0.05 MON** per citizen, **0.05 MON** aggregate, window **86400** seconds, authorization lifetime at most **3600** seconds. The contract cap on **$CHOG is 1 wei**. The Economy page also shows higher application review limits. A broadcast is reduced to the contract caps.

Confirmed wallet issuances are Monad transactions. Token 91 is one of them. Not every citizen has a wallet yet. The economy rows returned at that check were wallet issuances. A MON distribution is a separate stored receipt. `$CHOG` stays at 1 wei until a confirmed MON distribution receipt is stored.

Chog Genesis and `$CHOG` existed before this repository. The live application is Next.js 16.4.2 on the production branch. This branch's `package.json` is the older shell.

## Run the living world

```bash
git clone https://github.com/jericddd/chogOS.git
cd chogOS
git checkout cursor/phase-1-genesis-world-155c
npm install
cp .env.example .env.local
npm run dev
```

Do not put a private key in `.env.local` or in git.

## Files on this branch

`docs/` here describes the Phase 0 shell in this tree. It is not the deployment record. Where it disagrees with this README, this README is the record.
