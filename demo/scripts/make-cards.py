#!/usr/bin/env python3
"""Still cards for the chogOS demo. Facts are the reads already checked against Monad mainnet."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "raw" / "cards"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1920, 1080
BG = (18, 24, 43)
CARD = (27, 36, 56)
GOLD = (240, 193, 74)
CREAM = (246, 231, 193)
MUTED = (183, 196, 168)
VIOLET = (215, 179, 255)
WARN = (255, 177, 90)
LINE = (107, 78, 46)
OK = (154, 196, 126)

SANS = "/usr/share/fonts/truetype/macos/Inter-Regular.ttf"
SANS_B = "/usr/share/fonts/truetype/macos/Inter-Bold.ttf"
MONO = "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf"
if not Path(MONO).exists():
    MONO = "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"


def font(path, size):
    return ImageFont.truetype(path, size)


def canvas():
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, W, 8), fill=GOLD)
    return image, draw


def wrap(draw, text, face, width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if draw.textlength(trial, font=face) <= width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def save(image, name):
    path = OUT / name
    image.save(path, "PNG")
    print(path)


def hook():
    image, draw = canvas()
    draw.text((96, 250), "chogOS", font=font(SANS_B, 92), fill=GOLD)
    draw.text((96, 370), "An NFT-backed civilization on Monad.", font=font(SANS, 48), fill=CREAM)
    lines = [
        "Citizens keep a persistent record.",
        "A model can decide what happens next.",
        "It cannot sign, and it cannot spend.",
    ]
    y = 500
    for line in lines:
        draw.text((96, y), line, font=font(SANS, 36), fill=MUTED)
        y += 58
    draw.text((96, 900), "chogos.vercel.app   ·   chain 143   ·   recorded from production", font=font(SANS, 24), fill=LINE)
    save(image, "hook.png")


def architecture():
    image, draw = canvas()
    draw.text((80, 70), "What actually runs", font=font(SANS_B, 54), fill=GOLD)
    draw.text((80, 145), "Only the lit steps were exercised. Amber steps are designed and not live.", font=font(SANS, 28), fill=MUTED)
    steps = [
        ("NFT identity", "Genesis ownerOf\non this request", OK),
        ("World state", "60 citizens,\npersisted", OK),
        ("AI decision", "Stored reason\nand event", OK),
        ("Server policy", "Signing and\nbroadcast off", OK),
        ("Execution", "No bank.\nNo payout.", WARN),
        ("Chain check", "One transfer\nreceipt matches", OK),
        ("Activity log", "Hash chain.\nNo anchor.", OK),
    ]
    x = 70
    for title, body, color in steps:
        draw.rounded_rectangle((x, 280, x + 240, 760), radius=16, fill=CARD, outline=color, width=3)
        draw.rectangle((x, 280, x + 240, 292), fill=color)
        draw.text((x + 18, 330), title, font=font(SANS_B, 26), fill=CREAM)
        draw.multiline_text((x + 18, 430), body, font=font(SANS, 24), fill=MUTED, spacing=8)
        x += 262
    draw.text((80, 840), "ChogBank has no owner in source. It is not deployed, so that ownership model is not onchain yet.", font=font(SANS, 26), fill=CREAM)
    draw.text((80, 900), "An authorizer key, if the contract were deployed, could spend only inside caps to a wallet that already has code.", font=font(SANS, 26), fill=MUTED)
    draw.text((80, 980), "Production refuses that key. This recording did not deploy, fund, or broadcast.", font=font(SANS, 24), fill=WARN)
    save(image, "architecture.png")


def source_card():
    image, draw = canvas()
    draw.text((80, 60), "ChogBank source, not a deployment", font=font(SANS_B, 46), fill=GOLD)
    draw.text((80, 130), "contracts/src/ChogBank.sol on the production branch. No contract address is configured.", font=font(SANS, 24), fill=MUTED)
    quote = [
        "There is no owner, administrator, proxy, upgrade path, rescue, or delegatecall.",
        "The immutable authorizer can sign an allocation. The signature is not enough:",
        "the contract still enforces the asset, the caps, the expiry, the nonce, and the recipient.",
        "The recipient is only the permanent citizen wallet for one Chog Genesis token id.",
        "If that wallet has no code, the transfer reverts. An empty predicted address is never paid.",
        "A leaked authorizer key can spend only inside these caps, and only to those wallets.",
        "It cannot change this contract or withdraw to an arbitrary address.",
        "This contract is not deployed.",
    ]
    y = 210
    draw.rounded_rectangle((70, 190, 1850, 860), radius=16, fill=CARD, outline=LINE, width=2)
    for line in quote:
        face = font(SANS_B, 28) if line.startswith("This contract") else font(MONO, 24)
        color = WARN if line.startswith("This contract") else CREAM
        draw.text((100, y), line, font=face, fill=color)
        y += 70
    draw.text((80, 920), "The authorizer is a privileged key. The design limits it. Nothing here removes that key, because the bank is not deployed.", font=font(SANS, 24), fill=MUTED)
    draw.text((80, 980), "Do not send MON or $CHOG to a predicted wallet, the NFT treasury, or the Genesis contract.", font=font(SANS, 24), fill=WARN)
    save(image, "source.png")


def receipt_card():
    image, draw = canvas()
    draw.text((80, 48), "Receipt read, not an explorer screenshot", font=font(SANS_B, 46), fill=GOLD)
    draw.text((80, 118), "eth_getTransactionReceipt on https://rpc.monad.xyz. Monadscan served a Cloudflare challenge to this recorder.", font=font(SANS, 22), fill=MUTED)
    rows = [
        ("Transaction", "0x8f97aafbfa595db04cb0e629d9e820da6108ef4e839d190449c8b9dc02c4536b"),
        ("Status", "success (0x1)"),
        ("Block", "113457077"),
        ("Block hash", "0x1b694edfe9157ff0fa0117080e0b796454de425646d4612f619a190e33228713"),
        ("Log index 82", "Chog Genesis Transfer"),
        ("Contract", "0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763"),
        ("Token", "1021"),
        ("From", "0x0c13D51f3d52Bb74E4EB131a2ED6978A99a417cf"),
        ("To", "0xBF3AAe135034452987490d6587b42704E617CF79"),
    ]
    y = 180
    for label, value in rows:
        draw.text((90, y), label, font=font(SANS, 22), fill=MUTED)
        draw.text((320, y), value, font=font(MONO, 22), fill=CREAM)
        y += 46
    draw.text((90, 640), "Same hash, block, block hash, log index, token, sender, and receiver as world event", font=font(SANS, 24), fill=OK)
    draw.text((90, 680), "8b163c7e-b50f-430f-923c-29b07d59c62b.", font=font(MONO, 24), fill=OK)
    draw.text((90, 760), "The verify page says the application did not re-read this receipt.", font=font(SANS, 26), fill=WARN)
    draw.text((90, 810), "The match above is this recording's own RPC read.", font=font(SANS, 26), fill=CREAM)
    draw.text((90, 900), "ownerOf(104) = 0xef6fdfe87081da6acc6e4755d095b8c23568577f", font=font(MONO, 22), fill=MUTED)
    draw.text((90, 945), "ChogTreasury balanceOf = 53. Predicted token-104 wallet code is empty. Not a funding address.", font=font(MONO, 22), fill=MUTED)
    save(image, "receipt.png")


def close():
    image, draw = canvas()
    draw.text((90, 80), "Running today", font=font(SANS_B, 48), fill=GOLD)
    running = [
        "A live world of 60 Genesis citizens, with memory, work, and history.",
        "A scheduled mind that stores decisions, including the reason it gives.",
        "A hash-chained event log you can recompute in the browser.",
        "A watcher row whose Monad receipt matches the stored transfer.",
    ]
    y = 170
    for line in running:
        draw.text((110, y), line, font=font(SANS, 30), fill=CREAM)
        y += 52
    draw.text((90, 430), "Not running", font=font(SANS_B, 48), fill=WARN)
    missing = [
        "No ChogBank on mainnet. No funding address. No balance.",
        "No citizen wallet. Predicted addresses have no code.",
        "No onchain event anchor. No payout.",
    ]
    y = 520
    for line in missing:
        draw.text((110, y), line, font=font(SANS, 30), fill=CREAM)
        y += 52
    draw.text((90, 760), "Next", font=font(SANS_B, 48), fill=GOLD)
    draw.text((110, 840), "An operator deploys the wallet and the bank, then sends one capped payout.", font=font(SANS, 30), fill=CREAM)
    draw.text((110, 890), "The model still does not get a key.", font=font(SANS, 30), fill=CREAM)
    draw.text((90, 990), "chogOS  ·  Monad mainnet  ·  chain 143", font=font(SANS, 24), fill=MUTED)
    save(image, "close.png")


if __name__ == "__main__":
    hook()
    architecture()
    source_card()
    receipt_card()
    close()
