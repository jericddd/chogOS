#!/usr/bin/env python3
"""Assemble demo/chogos-hackathon-demo.mp4 from recorded production footage and fact cards."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw"
BUILD = ROOT / "raw" / "build"
BUILD.mkdir(parents=True, exist_ok=True)
OUT = ROOT / "chogos-hackathon-demo.mp4"
ASS = ROOT / "captions.ass"
FONTS = "/usr/share/fonts/truetype/macos"

# (kind, source, ss, duration, zoom)
# Times are seconds. Image sources are png paths under raw/.
SEGMENTS = [
    ("image", "cards/hook.png", 0, 6, False),
    ("video", "world.mp4", 1.0, 16, False),
    ("video", "world.mp4", 8.0, 12, True),
    ("video", "citizen-104.mp4", 0.5, 8, False),
    ("video", "citizen-104.mp4", 9.0, 8, False),
    ("video", "ai-feed.mp4", 1.0, 12, False),
    ("video", "ai-verify.mp4", 0.4, 8, False),
    ("video", "ai-verify.mp4", 8.0, 8, False),
    ("image", "cards/architecture.png", 0, 12, False),
    ("video", "economy.mp4", 0.6, 10, False),
    ("video", "economy.mp4", 9.0, 8, False),
    ("image", "cards/source.png", 0, 12, False),
    ("video", "onchain-feed.mp4", 4.0, 6, False),
    ("video", "transfer-verify.mp4", 0.5, 8, False),
    ("video", "transfer-verify.mp4", 8.0, 8, False),
    ("image", "cards/receipt.png", 0, 12, False),
    ("video", "treasury.mp4", 6.0, 6, False),
    ("image", "cards/close.png", 0, 15, False),
]

CAPTIONS = [
    (6, 14, "Day 478 on chogos.vercel.app. Sixty founding citizens. The clock is live."),
    (14, 22, "Six completed road spurs. No critical shortage. The map's storehouse is labeled simulated."),
    (22, 28, "Workshop E is an AI decision. The sentence under it is the model's own reason."),
    (28, 34, "The column beside it says Simulation. A simulated food batch is not a balance."),
    (34, 42, "Token 104 is CHOG #1565. ownerOf on this request is 0xEf6f…577F."),
    (42, 50, "No AI decision is stored for this citizen. These shifts are simulation. The record stays with the token."),
    (50, 56, "History, filtered to AI. These construction rows are stored model decisions."),
    (56, 62, "Workshop E, House 18, and South Meadows Plot. Each line keeps the reason the model gave."),
    (62, 70, "The browser recomputes the hash. This page says the event is not a blockchain transaction."),
    (70, 78, "Source AI. Chain status offchain. Both hashes start 0xe15a85e8. No Merkle batch, and no anchor."),
    (90, 100, "ChogBank is not deployed. No funding address. This server does not sign or broadcast."),
    (100, 108, "MON and $CHOG were not read. These limits are application rules, not a live contract. $CHOG is closed."),
    (120, 126, "Watcher rows for Genesis transfers. The row we checked is token 1021, block 113457077."),
    (126, 134, "The page says the application has not independently verified this transaction."),
    (134, 138, "Token 1021 moved in block 113457077. The hash chain matches. This is not an onchain anchor."),
    (138, 142, "Receipt check: not read. Hash 0x8f97aafb…02c4536b. Log 82. Token 1021."),
]


def ts(seconds: float) -> str:
    whole = int(seconds)
    cs = int(round((seconds - whole) * 100))
    if cs == 100:
        whole += 1
        cs = 0
    hours, rem = divmod(whole, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def run(args):
    print(" ".join(args[:8]), "...")
    subprocess.run(args, check=True)


def base_chain():
    return "crop=1920:1052:0:28,scale=1920:1080:flags=lanczos,fps=30,format=yuv420p"


def render_segment(index, kind, source, start, duration, zoom):
    dest = BUILD / f"seg-{index:02d}.mp4"
    src = RAW / source
    common = [
        "-an",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "30000",
        str(dest),
    ]
    if kind == "image":
        run(
            [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-framerate",
                "30",
                "-t",
                str(duration),
                "-i",
                str(src),
                "-vf",
                "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p",
                *common,
            ]
        )
        return dest
    video_filters = base_chain()
    if zoom:
        video_filters = (
            "crop=1920:1052:0:28,scale=1920:1080:flags=lanczos,fps=30,split[base][src];"
            "[src]crop=1900:310:10:745,scale=1840:-1[zoom];"
            "[base]eq=brightness=-0.32:saturation=0.72[dim];"
            "[dim][zoom]overlay=(W-w)/2:118,format=yuv420p"
        )
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-ss",
            str(start),
            "-t",
            str(duration),
            "-vf",
            video_filters,
            *common,
        ]
    )
    return dest


def write_ass():
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Cap,Inter,42,&H00C1E7F6,&H000000FF,&H0012182B,&HE012182B,0,0,0,0,100,100,0,0,3,14,0,2,90,90,42,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, text in CAPTIONS:
        # Keep each caption to two lines by breaking near the middle sentence boundary.
        broken = text.replace(". ", ".\\N") if text.count(". ") == 1 else text
        if broken == text and len(text) > 78:
            cut = text.rfind(" ", 0, 78)
            broken = text[:cut] + "\\N" + text[cut + 1 :]
        lines.append(f"Dialogue: 0,{ts(start)},{ts(end)},Cap,,0,0,0,,{broken}")
    ASS.write_text("\n".join(lines) + "\n")


def main():
    subprocess.run(["python3", str(ROOT / "scripts" / "make-cards.py")], check=True)
    files = []
    total = 0.0
    for index, segment in enumerate(SEGMENTS):
        kind, source, start, duration, zoom = segment
        files.append(render_segment(index, kind, source, start, duration, zoom))
        total += duration
    listing = BUILD / "concat.txt"
    listing.write_text("".join(f"file '{path}'\n" for path in files))
    silent = BUILD / "silent.mp4"
    run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            str(silent),
        ]
    )
    write_ass()
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(silent),
            "-f",
            "lavfi",
            "-t",
            f"{total:.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-vf",
            f"subtitles={ASS}:fontsdir={FONTS},fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.6:.3f}:d=0.6",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(OUT),
        ]
    )
    print(f"rendered {OUT} target {total:.2f}s")


if __name__ == "__main__":
    main()
