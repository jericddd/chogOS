#!/usr/bin/env node
/**
 * Records production chogOS pages and one verify flow from a headed Chrome window.
 * Does not sign, broadcast, fund, or change application data.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RAW = path.join(ROOT, "raw");
const PROFILE = "/tmp/chog-demo-profile";
const PORT = 9222;
const SITE = "https://chogos.vercel.app";

const SCENES = [
  {
    id: "world",
    url: `${SITE}/`,
    ready: "Citizens",
    seconds: 36,
    scrolls: [
      { at: 8, pixels: 520, ms: 5000 },
      { at: 18, pixels: 640, ms: 6000 },
      { at: 28, pixels: -700, ms: 4000 },
    ],
  },
  {
    id: "citizen-104",
    url: `${SITE}/citizens/104`,
    ready: "104",
    seconds: 18,
    scrolls: [
      { at: 4, pixels: 420, ms: 3500 },
      { at: 10, pixels: 480, ms: 3500 },
    ],
  },
  {
    id: "ai-feed",
    url: `${SITE}/activity?source=ai`,
    ready: "Workshop E",
    seconds: 16,
    scrolls: [{ at: 6, pixels: 280, ms: 3000 }],
  },
  {
    id: "ai-verify",
    url: `${SITE}/verify/events/0668f30b-d956-4dac-a90a-4014e8b6c955`,
    ready: "Workshop E",
    seconds: 18,
    scrolls: [
      { at: 4, pixels: 620, ms: 4000 },
      { at: 10, pixels: 420, ms: 3000 },
    ],
  },
  {
    id: "economy",
    url: `${SITE}/economy`,
    ready: "ChogBank is not deployed",
    seconds: 18,
    scrolls: [{ at: 8, pixels: 720, ms: 4500 }],
  },
  {
    id: "onchain-feed",
    url: `${SITE}/activity?source=onchain`,
    ready: "1021",
    seconds: 12,
    scrolls: [{ at: 1.5, pixels: 1280, ms: 3500 }],
  },
  {
    id: "transfer-verify",
    url: `${SITE}/verify/events/8b163c7e-b50f-430f-923c-29b07d59c62b`,
    ready: "1021",
    seconds: 18,
    scrolls: [
      { at: 4, pixels: 540, ms: 4000 },
      { at: 11, pixels: 480, ms: 3000 },
    ],
  },
  {
    id: "treasury",
    url: `${SITE}/treasury`,
    ready: "ChogTreasury",
    seconds: 14,
    scrolls: [{ at: 4, pixels: 360, ms: 3000 }],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    const body = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(body);
    });
  }
}

async function connectPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((item) => item.type === "page");
  if (!page) throw new Error("No Chrome page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { cdp, ws };
}

async function pageText(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText.slice(0, 6000) : ''",
    returnByValue: true,
  });
  return result.result?.value ?? "";
}

async function waitForText(cdp, needle, timeoutMs) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    last = await pageText(cdp);
    if (last.includes(needle)) return last;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}. Last text: ${last.slice(0, 400)}`);
}

async function scrollBy(cdp, pixels, ms) {
  await cdp.send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const start = window.scrollY;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / ${ms});
        const eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
        window.scrollTo(0, start + (${pixels}) * eased);
        if (p < 1) requestAnimationFrame(step);
        else resolve(window.scrollY);
      };
      requestAnimationFrame(step);
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
}

function startChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(
    "/usr/local/bin/google-chrome",
    [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-sync",
      "--test-type",
      "--password-store=basic",
      "--disable-features=Translate,InfiniteSessionRestore,SigninPromo,ChromeWhatsNewUI",
      "--window-position=0,0",
      "--window-size=1920,1080",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${PROFILE}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  return chrome.pid;
}

async function placeWindow() {
  const { stdout } = await exec("xdotool", ["search", "--onlyvisible", "--class", "Google-chrome"]);
  const ids = stdout.trim().split("\n").filter(Boolean);
  if (ids.length === 0) return;
  const id = ids[ids.length - 1];
  await exec("xdotool", ["windowactivate", "--sync", id]);
  await exec("xdotool", ["windowmove", id, "0", "0"]);
  await exec("xdotool", ["windowsize", id, "1920", "1080"]);
  await sleep(200);
}

async function waitForChrome() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome debugging port did not open");
}

function startGrab(file, seconds) {
  fs.mkdirSync(RAW, { recursive: true });
  const args = [
    "-y",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-framerate",
    "30",
    "-video_size",
    "1920x1080",
    "-i",
    ":1.0",
    "-t",
    String(seconds),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    file,
  ];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => {
    err += chunk.toString();
  });
  const done = new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`));
    });
  });
  return { done };
}

async function moveMouse(points) {
  for (const [x, y] of points) {
    await exec("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    await sleep(180);
  }
}

async function recordScene(cdp, scene) {
  const file = path.join(RAW, `${scene.id}.mp4`);
  process.stdout.write(`\n→ ${scene.id} ${scene.url}\n`);
  await cdp.send("Page.navigate", { url: scene.url });
  await sleep(600);
  await waitForText(cdp, scene.ready, 35000);
  await sleep(800);
  await placeWindow();
  await exec("xdotool", ["mousemove", "760", "460"]);
  const grab = startGrab(file, scene.seconds);
  const started = Date.now();
  const mouse = moveMouse([
    [420, 280],
    [880, 360],
    [1240, 520],
    [760, 680],
    [980, 430],
  ]);
  const scrolls = (scene.scrolls ?? []).map(async (item) => {
    const wait = item.at * 1000 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    await scrollBy(cdp, item.pixels, item.ms);
  });
  await Promise.all([grab.done, mouse, ...scrolls]);
  const stat = fs.statSync(file);
  process.stdout.write(`  saved ${file} (${stat.size} bytes)\n`);
}

async function stopChrome() {
  await new Promise((resolve) => {
    const child = spawn("pkill", ["-f", "remote-debugging-port=9222"], { stdio: "ignore" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  await sleep(400);
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const skip = new Set(process.argv.includes("--skip") ? process.argv[process.argv.indexOf("--skip") + 1].split(",") : []);
  const scenes = (only ? SCENES.filter((scene) => scene.id === only) : SCENES).filter((scene) => !skip.has(scene.id));
  if (scenes.length === 0) throw new Error(`Unknown scene ${only}`);
  fs.mkdirSync(RAW, { recursive: true });
  await stopChrome();
  startChrome();
  await waitForChrome();
  const { cdp, ws } = await connectPage();
  try {
    for (const scene of scenes) {
      await recordScene(cdp, scene);
    }
  } finally {
    ws.close();
    await stopChrome();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
