# chogOS hackathon demo — scene plan

Runtime target: 175 seconds. Resolution: 1920×1080, 30 fps, H.264, silent AAC. Captions are burned in because this machine has no speech synthesizer.

Recorded from production `https://chogos.vercel.app/` on 22 October 2026, morning Philippine time (UTC+8). No contract was deployed, funded, or called. No database row was written.

## Capability matrix

| Capability | In code | On production | Executed | Independently onchain |
| --- | --- | --- | --- | --- |
| Live world of 60 Genesis citizens, buildings, roads, clock | Yes | Yes | Yes. Day 478 was live during the recording. | No. World time is application state. |
| Citizen identity for token 104 | Yes | Yes. Page reads `ownerOf` on the request. | Yes | Yes. `ownerOf(104)` = `0xef6fdfe87081da6acc6e4755d095b8c23568577f` |
| ChogTreasury NFT holdings | Yes | Yes. Page showed 53 verified at block 115452443. | Yes | Yes. `balanceOf` of `0x84113421A8a564b594ee9Ae78c875310332d7023` returned 53. |
| AI construction decisions with stored reasons | Yes | Yes. History filter `source=ai`. | Yes. Workshop E and the rows under it. | No. Chain status on that event is offchain. |
| Browser hash recompute | Yes | Yes. Verify page for event `0668f30b-d956-4dac-a90a-4014e8b6c955`. | Yes. Stored and recomputed hashes match. | No Merkle batch and no anchor. |
| Scheduled mind | Yes. `.github/workflows/ai-mind.yml` | The stored decisions are on production. | Recent scheduled runs on `main` succeeded. The video shows the stored result, not the Action log. | No |
| Genesis transfer watcher | Yes | Yes. History filter `source=onchain`. | Yes. Token 1021 row is stored. | Yes, for that one receipt. See below. |
| ChogBank | Yes. `contracts/src/ChogBank.sol` | The economy page refuses a funding address. | Not deployed. No balance. Signing is off. | No address, no code, no transaction. |
| Citizen wallet | V3 is in source. V2 predictions are labeled undeployed. | Token 104: no wallet assigned. | Not deployed. | Predicted token-104 wallet `0xD3c8e7fAfF0750bd202F72EBaBDD46D197B47502` has empty code. |
| Civilization MON treasury | Settings exist | Not configured. Balances not read. | No funding transaction. | No |
| Event anchor | `EventAnchor.sol` is in source | Verify page: no anchor configured for these events. | Not published. | No |

## Strongest real path

NFT identity on Monad, persistent world, a stored AI decision with a recomputed hash, and one watcher transfer whose receipt matches. ChogBank is the designed next step, shown as source and as a refusal, not as a live treasury.

## Timeline

| Time | Picture | What it proves |
| --- | --- | --- |
| 0:00–0:06 | Title card | The claim, including the limit: the model cannot sign or spend. |
| 0:06–0:22 | Production world | Day 478, 60 founding citizens, six road spurs, live clock. Storehouse tooltip says simulated. |
| 0:22–0:34 | Close-up of town growth and activity | Workshop E is labeled AI, with the model's reason. The next column is labeled Simulation. |
| 0:34–0:42 | `/citizens/104` | CHOG #1565, token 104, `ownerOf` on this request, NFT no longer in the treasury holdings. |
| 0:42–0:50 | Same citizen, history | No AI decision is stored for this citizen. Shifts are simulation. |
| 0:50–1:02 | `/activity?source=ai` | Stored construction decisions and their reasons. |
| 1:02–1:18 | Verify event `0668f30b-d956-4dac-a90a-4014e8b6c955` | Browser recomputes the hash. Source AI. Chain status offchain. No Merkle proof. Not an anchor. |
| 1:18–1:30 | Architecture card | Lit steps are the ones exercised. Execution is marked not live. |
| 1:30–1:48 | `/economy` | ChogBank is not deployed. No funding address. Signing off. MON and $CHOG not read. $CHOG caps are 0. |
| 1:48–2:00 | Source card | NatSpec from `ChogBank.sol`. An authorizer would still be a privileged key, bounded by caps and a deployed wallet. The contract is not deployed. |
| 2:00–2:06 | `/activity?source=onchain` | Watcher rows. The checked row is token 1021, block 113457077. Other rows are shown as the site lists them and were not each re-read. |
| 2:06–2:22 | Verify event `8b163c7e-b50f-430f-923c-29b07d59c62b` | The page says the application has not independently verified the transaction. Receipt check: not read. |
| 2:22–2:34 | Receipt card | `eth_getTransactionReceipt` on `https://rpc.monad.xyz` matches that row. Labeled as this recording's read, not a Monadscan screenshot. |
| 2:34–2:40 | `/treasury` | 53 NFTs verified in ChogTreasury at block 115452443. Civilization MON treasury has no address. |
| 2:40–2:55 | Close | What runs, what does not, and the operator next step. |

## Receipt that was actually read

Transaction `0x8f97aafbfa595db04cb0e629d9e820da6108ef4e839d190449c8b9dc02c4536b`

- Status success (`0x1`)
- Block `113457077`
- Block hash `0x1b694edfe9157ff0fa0117080e0b796454de425646d4612f619a190e33228713`
- Log index 82 on Chog Genesis `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763`
- Transfer of token 1021
- From `0x0c13D51f3d52Bb74E4EB131a2ED6978A99a417cf`
- To `0xBF3AAe135034452987490d6587b42704E617CF79`

World event `8b163c7e-b50f-430f-923c-29b07d59c62b` stores the same values. Monadscan presented a Cloudflare challenge to the recorder, so the video does not include an explorer page.

## AI event that was shown

Event `0668f30b-d956-4dac-a90a-4014e8b6c955`, sequence 571171, kind `construction.started`, source `ai`, decision `4cf0f0dc-3c20-43f8-a2c6-24bfbf2c8348`, building `workshop-06`.

Stored and recomputed hash: `0xe15a85e8d41782f7b35cc119836ee5bbcedecd5661266a570d54fcb56ef18c73`

Occurred `2026-10-21T11:10:36Z` (21 October 2026, 7:10 PM Philippine time).

## Reproduce

```bash
node demo/scripts/record-scenes.mjs
python3 demo/scripts/render-demo.py
```

Recording needs a display on `:1`, Chrome, ffmpeg, and xdotool. Rendering needs Pillow and the footage in `demo/raw/`. `demo/raw/` is local capture output and is not part of the commit.
