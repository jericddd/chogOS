# Hackathon showcase runbook

Record against https://chogos.vercel.app. Keep it between two and three minutes. One take. If a page is slow, read the sentence and move on.

The treasury contract is not deployed unless `/economy` shows a checked address and a Monadscan contract link. A review row is not a payment. A wallet-issuance row is not a deployed wallet. A `$CHOG` transfer on the token contract is not a ChogBank payout. Local tests are not mainnet proof.

## Before you press record

1. Open these tabs in order: the home page, one enrolled citizen, Economy, and the GitHub file `contracts/src/CitizenAccountV3.sol` on the branch that contains this runbook.
2. Confirm Economy says the funding address is not ready. If a later deploy has actually passed the checks, the page shows one address with a Monadscan link. Do not refresh into a half-loaded panel and do not invent the other case.
3. Set the browser to a 1280-wide window. Hide bookmarks. Do not show `.env`, Vercel, a private key, or a terminal.
4. If you have not broadcast a payout, do not open an old `$CHOG` transfer and do not call it a payout.

## Spoken track

### 0:00 The shared civilization

Open https://chogos.vercel.app/

Say: "chogOS is one shared civilization for Chog Genesis citizens on Monad. Each enrolled token id is a citizen. The world keeps that citizen's life, goals, and history. The AI mind writes decisions for those citizens."

Show the world moving. If it is still loading, open https://chogos.vercel.app/citizens and choose the first enrolled citizen.

### 0:30 A citizen without a wallet

On the citizen page, show the token id and the current owner.

Say: "This token id is the permanent identity. The current owner is metadata. Selling the NFT updates that line and does not reset the citizen, and it does not hand the owner a wallet."

Point at the citizen wallet section.

Say: "A citizen is valid with no wallet. The AI can propose one, defer it, or decide it is unnecessary. A proposal is not a deployed account. No address on this page is a place to send funds unless the page says the account has code."

If the section says no issuance is recorded, say that. Do not imply a decision you cannot see.

### 1:10 The treasury proposal

Open https://chogos.vercel.app/economy

Say: "The AI can propose an allocation: which citizen, which asset, how much, and why. The server checks the cap. The model cannot raise the cap, and this website does not sign or broadcast. A proposal is a payment only when a ChogBank Distributed event exists on Monad mainnet, chain 143."

Point at the spending policy. Read that `$CHOG` application caps are 0, and that an empty prediction is not paid. Point at "Not ready" if there is no funding address.

If a decision row is visible, read its reason and whether it says no payout transaction. If the list is empty, say: "No treasury payment has been recorded. An empty list is not a fake receipt."

### 1:45 Ownerless bank and the wallet rule

Show `contracts/src/ChogBank.sol`, then `contracts/src/CitizenAccountV3.sol`.

Say: "ChogBank has no owner, no upgrade, and no emergency withdraw. An authorizer can sign a capped allocation. The contract still checks the asset, the expiry, the replay id, and the recipient. The recipient is that citizen's deployed wallet, not the NFT holder."

Say: "The wallet's signer is an agent key fixed in the contract. The NFT holder cannot execute it. A factory transaction can be submitted by a relayer. The sender of that transaction is not the decision-maker, and the signature is what ties the action to the agent public key. A signature does not prove that no human can reach the key."

### 2:20 What is real today

Say: "What you can verify today is the living civilization, the permanent citizen, the wallet decision on the citizen page, and this policy. What is not done is a deployed factory, a funded treasury, and an automatic payout. I will not show an old token transfer as if the bank sent it, and I will not call a local test a mainnet receipt."

If, and only if, `/economy` shows a checked bank and a payout link, open that Monadscan transaction and read the contract address, the `Distributed` event, and the success status. Otherwise stop.

### 2:40 Stop

End on the Economy page. The last sentence is: "The payment path is tested locally. It stays off until a reviewed deployment puts code on chain 143, the site shows that checked address, and one small manual payout is confirmed."

## Backup if the live site is down

Record the same sentences over stills. Label each still out loud.

1. A screenshot of https://chogos.vercel.app/ saved before the outage. Say "this is the production site."
2. A screenshot of `/economy` showing "Not ready" and "Not read." Say "this is the treasury page with no contract deployed. It is not a zero balance."
3. The local test name `testHolderCannotSpendAndTheAgentCanAfterAnNftTransfer`. Say "this is a local proof that the NFT holder cannot spend the wallet and the agent still can after a transfer. It is not a mainnet transaction."

Do not use a discovered `$CHOG` transfer, a predicted address, or a screenshot that shows a transaction hash, as evidence of a ChogBank payout.

## After a real payout exists

Add ten seconds. From `/economy`, click "View payout receipt." Read the decision id, the citizen token id, the amount, and the word Confirmed. Then say the replay rule: running the same decision again cannot pay twice. Skip this segment until that link exists. Do not say the NFT holder withdrew the funds.
