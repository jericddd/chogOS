# Hackathon showcase runbook

Record against https://chogos.vercel.app. The treasury contract is not deployed unless `/economy` shows a checked address and a Monadscan contract link. A review row is not a payment. A `$CHOG` transfer on the token contract is not a ChogBank payout.

Aim for two and a half minutes. One take. If a page is slow, read the sentence and move on.

## Before you press record

1. Open these tabs in order: the home page, one citizen, Economy, and the GitHub file `contracts/src/ChogBank.sol` on the production branch.
2. Confirm Economy says the funding address is not ready. The mainnet decision in `docs/hackathon-mainnet-launch.md` is NO-GO, so the recording does not show a funded treasury. Do not refresh into a half-loaded panel.
3. Set the browser to a 1280-wide window. Hide bookmarks. Do not show `.env`, Vercel, or a terminal that contains a key.
4. If you already broadcast a payout, open that Monadscan transaction in a last tab. If you have not, do not open an old `$CHOG` transfer and do not call it a payout.

## Spoken track

### 0:00 Civilization

Open https://chogos.vercel.app/

Say: "chogOS is one shared civilization for Chog Genesis citizens on Monad. Each token id is a citizen. The world keeps running from the recorded simulation, and the AI mind writes decisions for those citizens."

Show the world moving and the navigation. Click one citizen if a portrait is visible. If the world is still loading, go to https://chogos.vercel.app/citizens and open the first citizen instead.

### 0:35 The citizen

On the citizen page, show the token id, name, and any recorded goal or standing.

Say: "Identity stays with the token id. Selling the NFT does not reset the biography. The permanent wallet, once it exists, is also for that token id, not for whichever person holds the NFT today."

### 1:05 The decision and the limit

Open https://chogos.vercel.app/economy

Say: "The AI can propose an allocation: who, which asset, how much, and why. The server checks the cap. The model cannot raise the cap, and this website does not sign or broadcast. A proposal is not a payment until a ChogBank Distributed event exists on Monad mainnet, chain 143."

Point at the spending policy. Read the MON limits and the line that `$CHOG` application caps are 0. Point at "Not ready" if there is no funding address.

If a decision row is visible, read its reason and point at "No payout transaction." If the list is empty, say: "No treasury payment has been recorded. An empty list is not a fake receipt."

### 1:40 Ownerless bank

Show `contracts/src/ChogBank.sol` on GitHub.

Say: "ChogBank has no owner, no upgrade, and no emergency withdraw. An authorizer can sign a capped allocation, and the contract still checks the asset, the expiry, the replay id, and the recipient. The recipient is only that citizen's wallet. If the wallet is missing, the payment reverts. If the NFT is pushed in with transferFrom, MON already in the wallet can become unreachable, and that is why I have not funded it. The authorizer cannot pay an arbitrary address and cannot change the rules."

### 2:10 What is real today

Say: "What you can verify today is the living civilization, the citizen identity, and this policy. What is not done is a funded mainnet treasury and an automatic payout. I will not show an old token transfer as if the bank sent it."

If, and only if, `/economy` shows a checked bank and a payout link, open that Monadscan transaction and read the contract address, the `Distributed` event, and the success status. Otherwise stop. Do not visit the Genesis contract or the `$CHOG` token and describe their activity as treasury payouts.

### 2:30 Stop

End on the Economy page. The last sentence is: "The payment path is tested locally. It is not funded, because an NFT transferFrom into the citizen wallet can trap the MON, and the Genesis contract does not let us reject that transfer."

## Backup if the live site or the AI is down

Record the same sentences over stills. Label each still out loud.

1. A screenshot of https://chogos.vercel.app/ saved before the outage. Say "this is the production site."
2. A screenshot of `/economy` showing "Not ready" and "Not read." Say "this is the treasury page with no contract deployed. It is not a zero balance."
3. The passing local test name `testHolderWithdrawsThePayoutAndANewHolderControlsWhatRemains`. Say "this is a local proof that a signed allocation can pay a deployed wallet and the holder can withdraw. It is not a mainnet transaction."

Do not use a discovered `$CHOG` transfer, a predicted address, or a screenshot that shows a transaction hash, as evidence of a ChogBank payout.

## After a real payout exists

Add ten seconds. From `/economy`, click "View payout receipt." Read the decision id, the citizen token id, the amount, and the word Confirmed. Then say the replay rule: running the same decision again cannot pay twice. Skip this segment until that link exists.
