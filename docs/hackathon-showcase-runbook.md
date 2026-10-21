# Hackathon showcase runbook

Record against https://chogos.vercel.app. Keep it between two and three minutes. One take. If a page is slow, read the sentence and move on.

Checked on production on 21 October 2026: the world was live, citizen 104 had no wallet, and Economy said the funding address was not ready. The clock and the activity feed move. Read what is on the screen. Do not invent a later deployment.

The treasury contract is not deployed unless `/economy` shows a checked address and a Monadscan contract link. A review row is not a payment. A wallet-issuance row is not a deployed wallet. A `$CHOG` transfer on the token contract is not a ChogBank payout. Local tests are not mainnet proof. Source code is not deployed bytecode.

## Before you press record

1. Open these tabs, in this order:
   - https://chogos.vercel.app/
   - https://chogos.vercel.app/citizens/104
   - https://chogos.vercel.app/economy
   - https://github.com/jericddd/chogOS/blob/cursor/phase-1-genesis-world-155c/contracts/src/ChogBank.sol
   - https://github.com/jericddd/chogOS/blob/cursor/phase-1-genesis-world-155c/contracts/src/CitizenAccountV3.sol
2. On Economy, the funding address must say **Not ready**, the deployment transaction must say **Not recorded**, and payout execution must say it is disabled. If a later deploy has actually passed the checks, stop and do not use this script.
3. On citizen 104, scroll to **Citizen wallet**. It should say no wallet is assigned and no issuance decision is recorded. If a proposal has appeared, say it is a proposal and not a deployed account. If the line says the decisions were not loaded, say that instead.
4. Set the browser to a 1280-wide window. Hide bookmarks. Do not show `.env`, Vercel, Supabase, a private key, or a terminal.
5. Do not open an old `$CHOG` transfer. `main` does not contain these contract files. Use the two links above.

## Spoken track

### 0:00 The shared civilization

Open https://chogos.vercel.app/

Say: "chogOS is one shared civilization for Chog Genesis citizens on Monad. Each enrolled token id is a citizen. The world on this page is live. Citizens are moving, and the clock is advancing. The page says this activity is not a balance, a trade, or an on-chain action."

Point at the live clock and one line in the activity feed. The feed marks those lines Simulation.

### 0:25 Citizen 104

Open https://chogos.vercel.app/citizens/104

Say: "This is token 104. The NFT name is CHOG #1565. Token 104 is the permanent citizen. The current owner is metadata from ownerOf. Selling the NFT changes that line. It does not reset the citizen, and it does not give the new holder a wallet."

Scroll until the heading **Citizen wallet** is on screen.

Say: "The page says no wallet is assigned, no address has been predicted or deployed, and no issuance decision is recorded. This citizen is active without a wallet. There is no address here to send funds to. A proposal, if one shows up later, is not a deployed account."

### 1:15 Economy

Open https://chogos.vercel.app/economy

Say: "The funding address says Not ready. The deployment transaction is not recorded. Payout execution is disabled. The $CHOG application caps are 0. These are application limits, not caps of a deployed contract."

Point at the allocation list.

Say: "There is a rejected treasury review, and it says no payout transaction. That row is not a payment. This page does not show a Distributed event or a payout receipt."

### 1:50 Source, not a deployment

Show `ChogBank.sol`, then `CitizenAccountV3.sol`, from the production branch.

Say: "These files are source code. They are not deployed, so a judge cannot check them against live bytecode. ChogBank's source has no owner, no administrator, no upgrade, and no emergency withdrawal. The wallet source uses one agent key for every citizen wallet. That key can authorize a transfer or an approval, and the wallet has no numeric spending cap. The NFT holder cannot execute it. A signature would prove the public key signed. It would not prove that no person can reach the private key. This website refuses the signing keys, and it does not broadcast."

### 2:25 Stop

Return to Economy.

Say: "What is real today is the living simulation, citizen 104 with no wallet, and a treasury page that is not ready. What is not real is a deployed factory, a funded bank, or a mainnet payout. I will not show an old token transfer, a predicted address, or a local test as a receipt."

Stop. Do not open Monadscan.

## Backup if the live site is down

Do not record until you have looked at the three production URLs yourself. If they fail to load, say the site was down and do not fill the gap with a local test or an old transfer.

## After a real payout exists

Do not use that ending unless `/economy` shows a checked bank address and a payout link. From that page, open the receipt, and read the decision id, the citizen token id, the amount, and the word Confirmed. Then say the same decision cannot pay twice. Do not say the NFT holder withdrew the funds.
