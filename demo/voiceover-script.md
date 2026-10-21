# chogOS hackathon demo — caption script

No speech synthesizer is installed here (`espeak`, `piper`, and similar tools were absent). The video is captioned. These are the lines on screen, in order. A person can read them as a voiceover without changing the picture.

Card text is part of the picture, not a second caption.

## 0:00–0:06 — title card

chogOS. An NFT-backed civilization on Monad.

Citizens keep a persistent record. A model can decide what happens next. It cannot sign, and it cannot spend.

## 0:06–0:22 — the world

Day 478 on chogos.vercel.app. Sixty founding citizens. The clock is live.

Six completed road spurs. No critical shortage. The map's storehouse is labeled simulated.

## 0:22–0:34 — AI next to simulation

Workshop E is an AI decision. The sentence under it is the model's own reason.

The column beside it says Simulation. A simulated food batch is not a balance.

## 0:34–0:50 — one citizen

Token 104 is CHOG #1565. ownerOf on this request is 0xEf6f…577F.

No AI decision is stored for this citizen. These shifts are simulation. The record stays with the token.

## 0:50–1:18 — the decision and its hash

History, filtered to AI. These construction rows are stored model decisions.

Workshop E, House 18, and South Meadows Plot. Each line keeps the reason the model gave.

The browser recomputes the hash. This page says the event is not a blockchain transaction.

Source AI. Chain status offchain. Both hashes start 0xe15a85e8. No Merkle batch, and no anchor.

## 1:18–1:30 — architecture card

What actually runs. Only the lit steps were exercised. Amber steps are designed and not live.

NFT identity. World state. AI decision. Server policy, with signing off. Execution: no bank and no payout. One transfer receipt matches. The activity log is a hash chain with no anchor.

ChogBank has no owner in source. It is not deployed, so that ownership model is not onchain yet. An authorizer key, if the contract were deployed, could spend only inside caps to a wallet that already has code. Production refuses that key.

## 1:30–2:00 — the bank that is not there

ChogBank is not deployed. No funding address. This server does not sign or broadcast.

MON and $CHOG were not read. These limits are application rules, not a live contract. $CHOG is closed.

Source card, from `contracts/src/ChogBank.sol`: there is no owner, administrator, proxy, upgrade path, rescue, or delegatecall. The authorizer signature is not enough. An empty predicted address is never paid. This contract is not deployed.

## 2:00–2:34 — one real transfer

Watcher rows for Genesis transfers. The row we checked is token 1021, block 113457077.

The page says the application has not independently verified this transaction.

Token 1021 moved in block 113457077. The hash chain matches. This is not an onchain anchor.

Receipt check: not read. Hash 0x8f97aafb…02c4536b. Log 82. Token 1021.

Receipt card: a read of `eth_getTransactionReceipt` on `https://rpc.monad.xyz` matches that stored row. The verify page says the application did not re-read the receipt. The match is this recording's own read. Monadscan served a Cloudflare challenge, so this is not an explorer screenshot.

## 2:34–2:40 — the NFT treasury, with no caption over the number

The picture shows 53 Chog NFTs verified in ChogTreasury, and a civilization treasury with no address and no balance.

## 2:40–2:55 — close

Running today: a live world, a mind that stores decisions, a hash you can recompute, and a watcher row whose receipt matches.

Not running: no ChogBank, no citizen wallet, no event anchor, no payout.

Next: an operator deploys the wallet and the bank, then sends one capped payout. The model still does not get a key.
