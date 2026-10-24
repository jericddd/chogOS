# chogOS

One shared civilization for Chog Genesis NFTs on Monad mainnet. The token id is the citizen. The portrait on the map is that NFT.

Live app: [https://chogos.vercel.app/](https://chogos.vercel.app/)

This default branch exists so GitHub Actions can run the schedule in [`.github/workflows/ai-mind.yml`](.github/workflows/ai-mind.yml). The application source is [`cursor/phase-1-genesis-world-155c`](https://github.com/jericddd/chogOS/tree/cursor/phase-1-genesis-world-155c). The other files on `main` are an older Phase 0 shell. They are not the live app. `npm run dev` on `main` does not start the town.

The facts below were read from the live app and from Monad mainnet on 23 October 2026 at 10:38 AM Asia/Manila. Balances and the citizen count move. The World and Economy pages are the live numbers. The longer record is the README on the application branch.

## What is live

The app has six tabs: World, Citizens, Economy, History, Verify, and Enroll. `/treasury` redirects to `/economy`.

The world runs at 60×. One world hour is one real minute, so one world day is 24 real minutes. `world_tick()` in Postgres advances it when no browser is open. At the check above, the town had 61 citizens: 60 founding citizens from the ChogTreasury roster, and 1 community citizen enrolled by the wallet that held that NFT. Enrollment asks that wallet to sign a confirmation.

Food, wood, stone, and tools on the map are simulated counts. They are not MON and they are not `$CHOG`. Verify recomputes a SHA-256 of the stored event in the browser. `log_integrity_verified` is that check. EventAnchor is not deployed, and this app has not published a Merkle root on Monad.

The model does not hold a key and does not sign. A review is not a transfer. The website does not sign or broadcast. `POST /api/transactions` returns 403.

## Who signs

The scheduled workflow on this branch is `*/10 * * * *`, and it can be started by hand. GitHub may start that schedule later than the expression. It checks out the application branch and has two jobs:

1. `run` calls the production mind and can store a proposal. It does not pay ChogBank.
2. `issue` uses the wallet agent key to create a citizen wallet from an accepted issuance decision. The gas key pays that transaction.

`.github/workflows/chogbank-payout.yml` has no schedule. A person starts it and enters one stored decision id. The workflow checks out the application branch, refuses to run unless that checkout contains the decision-id gate, and then signs only that allocation. It does not call the mind. A missing decision id, a missing gate, or a missing required secret exits before signing.

Those keys are GitHub Actions secrets. They are not in this repository, and the website does not receive them. The agent key can move MON out of a citizen wallet. The NFT holder does not control the citizen wallet.

The schedule used to contain a third job, `pay`, which could sign an allocation when the secrets were present. Pull request #77 removed that job. The scheduled run at 2:17 AM Asia/Manila on 25 October 2026, after that merge, had jobs `run` and `issue` only.

A proposal is not a payment. A confirmed ChogBank payout is a Monad receipt with a `Distributed` log. These five receipts were read from Monad on 25 October 2026. Each paid 0.01 MON from ChogBank. The Economy page is the current list, because later payouts can be added by the manual workflow.

| Citizen | When (Asia/Manila) | Transaction |
| --- | --- | --- |
| Chog #135 | 12:54 AM, 24 Oct 2026 | [`0xceda27ddc3aa500ed49ba550e2d6c38194262196b6af0782129c96652b30dc3a`](https://monadscan.com/tx/0xceda27ddc3aa500ed49ba550e2d6c38194262196b6af0782129c96652b30dc3a) |
| Chog #118 | 1:34 AM, 24 Oct 2026 | [`0xee2d8b10f9b7ab3044cf10ebedf2b405d5d750884155ec3f0e2c194a97c2164f`](https://monadscan.com/tx/0xee2d8b10f9b7ab3044cf10ebedf2b405d5d750884155ec3f0e2c194a97c2164f) |
| Chog #124 | 7:33 AM, 24 Oct 2026 | [`0x8df79c5005b4845d3de8f71c85be589f45af0259898c59131822235b1930bcad`](https://monadscan.com/tx/0x8df79c5005b4845d3de8f71c85be589f45af0259898c59131822235b1930bcad) |
| Chog #137 | 7:54 PM, 24 Oct 2026 | [`0x88ab9d75c75e81feacd92465483ad16d7905adc7164db9413d03f63c40d35508`](https://monadscan.com/tx/0x88ab9d75c75e81feacd92465483ad16d7905adc7164db9413d03f63c40d35508) |
| Chog #140 | 11:27 PM, 24 Oct 2026 | [`0x8ad4e05e9b8a7a19e00a76438872b07b7d4c114e72875ed605ff9cedffe10885`](https://monadscan.com/tx/0x8ad4e05e9b8a7a19e00a76438872b07b7d4c114e72875ed605ff9cedffe10885) |

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

At the check above, ChogBank held **30 MON** and **369.97132121875218252 $CHOG**. A later public read at block `116276410`, 4:16 AM Asia/Manila on 25 October 2026, showed **29.95 MON** and the same `$CHOG` balance. The 0.05 MON difference matches the five 0.01 MON receipts above.

Contract caps, immutable: **0.01 MON** per transaction, **0.05 MON** per citizen, **0.05 MON** aggregate, window **86400** seconds, authorization lifetime at most **3600** seconds. The contract cap on **$CHOG is 1 wei**. The Economy page also shows higher application review limits. A broadcast is reduced to the contract caps.

Confirmed wallet issuances are Monad transactions. Token 91 is one of them. Not every citizen has a wallet yet. The economy rows returned at that check were wallet issuances. A MON distribution is a separate stored receipt. The contract cap on `$CHOG` is 1 wei. A confirmed MON distribution does not raise it.

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
