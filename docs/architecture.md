# Architecture

The live record is [README.md](../README.md). This page is how the running system is split. It replaces the Phase 0 description of this same filename.

## World

`world_tick()` in Postgres is the simulation writer. Hosted `pg_cron` calls it, so the clock moves when no browser is open. The Next.js server reads that state and serves `GET /api/world/live` and `GET /api/world/events`. The browser draws the canvas from those reads. Realtime, when the anon key is set, is only a signal to refetch.

Citizens, movement, work, and construction are simulated. Map resources are simulated counts. They are not token balances.

## Identity

A citizen is a Chog Genesis token id on Monad mainnet (chain 143). Founding citizens come from the ChogTreasury NFT roster. A community citizen is enrolled by the wallet that currently holds that NFT, after that wallet signs the enrollment confirmation. The NFT holder is the owner shown on the citizen page. That address is not the citizen wallet.

## Mind

The homepage does not call the model. GitHub Actions job `run` calls `POST /api/ai/run` with a bearer secret. The provider has no tools and no wallet client. The server validates the model's JSON and stores a decision only when the database rules accept it. AI rows in History include the stored reason.

The model can propose town growth, one wallet issuance, or one MON allocation review. It cannot sign.

## Wallets

`CitizenAccountFactoryV3` at `0xE1236D88f64206555c7E9FCfC3c742B2BAa2fc6A` creates one permanent wallet per enrolled citizen. The implementation is `CitizenAccountV3`. The NFT holder cannot call it. One agent address, `0x18229E45A24FB96f3c2d551adb406Db2F7d14358`, authorizes wallet calls. GitHub Actions job `issue` uses that key, which stays in Actions secrets.

`CitizenAccountV2` and the earlier predicted factories are unused. Their addresses are listed in the README so they are not funded by mistake.

## ChogBank

ChogBank at `0xB2494538433B2FA3167A723d32329cc22c3A59C1` holds MON and `$CHOG`. It has no owner, no administrator, no proxy, and no upgrade. An immutable authorizer signs an EIP-712 allocation. The contract still checks the asset, the caps, the expiry, the nonce, and the recipient. The recipient has to be the deployed citizen wallet for that token id.

The website does not sign. A scheduled AI mind run stores a proposal and does not pay it. A person starts `.github/workflows/chogbank-payout.yml` with one stored decision id. That workflow signs with the authorizer and submits `distribute` with the gas key. The agent key is not used for that workflow. The mind proposes and explains. The contract enforces the caps. A Monad receipt is the execution record.

The treasury review runs before ordinary citizen decisions, with the live balance, the contract caps, the remaining spending capacity, and the goals of citizens whose wallets are deployed. The roster rotates. If those chain reads fail, the review is stored as failed and the model is not asked to allocate. `$CHOG` is not available for a payout while its contract cap is 1 wei. MON is the payout asset. The Economy page lists application review thresholds separately from the caps read off the contract, and it labels a row as a proposed allocation, a submitted transaction, or a confirmed payout. A confirmed payout links the Monad transaction only after the receipt and the `Distributed` event are stored.

## Verify

`/verify` recomputes a SHA-256 over the canonical stored event in the browser. A match can be labeled `log_integrity_verified`. That is evidence about stored bytes. EventAnchor is not deployed. No Merkle root from this app is published on Monad.

`POST /api/transactions` returns 403. Signing for issuance and payouts happens in GitHub Actions, not in the Next.js process.
