#!/usr/bin/env node
// Echo probe driver. Runs on Windows with the Node 22 that ships with the app:
//   <path to the app's node.exe> driver.mjs --assets <dir> --out <dir> [--plan full|smoke] [--edge <msedge.exe>]
// It serves probe.html over http://127.0.0.1:<port> (getUserMedia needs a secure context), starts a persistent PowerShell
// helper that plays short WAV clips with System.Media.SoundPlayer (a different process from the browser, so the browser's echo
// canceller cannot know them), launches msedge.exe with a throwaway profile and the REAL microphone and speakers, and drives
// the page over the DevTools Protocol. It reads audio devices only: it never changes a volume, a mute, a default device or a
// privacy setting. See README.md.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const assetsDir = path.resolve(String(args.assets ?? process.env.ECHO_PROBE_ASSETS ?? ""));
const outDir = path.resolve(String(args.out ?? process.env.ECHO_PROBE_OUT ?? path.join(os.tmpdir(), "echo-probe")));
const planName = String(args.plan ?? "full");
const captureTs = path.resolve(String(args.capture ?? path.join(here, "../../../packages/ui/src/model/voice/capture.ts")));
const hrMs = () => Number(process.hrtime.bigint()) / 1e6; // QueryPerformanceCounter based, like Stopwatch and performance.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);

const PRE_ROLL_MS = 1500;
const TAIL_MS = 2500;
const LEAD_SEC = 0.3;
const CLIPS = ["stop-en-F2-stop", "stop-en-M2-stop", "stop-en-F4-stop", "stop-en-M4-wait", "stop-pt-F2-pare", "stop-pt-M2-espera"];
const GAINS_DB = [0, 6, 12]; // attenuation applied to the clip files, written as new WAVs; the system volume is never touched

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) o[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

// ---------- WAV helpers
function readWav16(file) {
  const b = fs.readFileSync(file);
  let at = 12, rate = 0, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") rate = b.readUInt32LE(at + 12);
    if (id === "data") { data = new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + Math.min(size, b.length - at - 8))); break; }
    at += 8 + size + (size & 1);
  }
  if (!data) throw new Error(`no data chunk in ${file}`);
  return { rate, pcm: data };
}
function writeWav16(file, pcm, rate) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(b, 44);
  fs.writeFileSync(file, b);
}

// ---------- the worklet: the shipped source, read from capture.ts, plus a subclass that adds timing to every frame
function shippedWorklet() {
  const ts = fs.readFileSync(captureTs, "utf8");
  const frame = /export const CAPTURE_FRAME_SAMPLES = (\d+);/.exec(ts)?.[1];
  const processor = /export const CAPTURE_PROCESSOR = ("[^"]+");/.exec(ts)?.[1];
  const body = /export const CAPTURE_WORKLET_SOURCE = `([\s\S]*?)`;/.exec(ts)?.[1];
  if (!frame || !processor || !body) throw new Error(`cannot read CAPTURE_WORKLET_SOURCE from ${captureTs}`);
  return body.replaceAll("${CAPTURE_FRAME_SAMPLES}", frame).replaceAll("${JSON.stringify(CAPTURE_PROCESSOR)}", processor);
}
const WRAPPER = `
class EchoProbeCapture extends AncillaCapture {
  constructor(options) {
    super(options);
    this.calls = 0;
    this.cf0 = -1;
    this.nFrames = 0;
    const port = this.port;
    const post = port.postMessage.bind(port);
    port.postMessage = (msg, transfer) => {
      post({ pcm: msg.pcm, rms: msg.rms, peak: msg.peak, n: this.nFrames++, cf: currentFrame, calls: this.calls, cf0: this.cf0 }, transfer);
    };
  }
  process(inputs, outputs, parameters) {
    if (this.cf0 < 0) this.cf0 = currentFrame;
    this.calls++;
    return super.process(inputs, outputs, parameters);
  }
}
registerProcessor("echo-probe-capture", EchoProbeCapture);
`;

// ---------- plan
function buildPlan(name) {
  const reply = (seconds) => ({ asset: "reply-en-native.wav", lang: "en", seconds });
  if (name === "ambient") return [{ id: "ambient", kind: "silence", seconds: 20 }];
  // checks the reference tap after a long silence (the condition that once broke its alignment); needs no audible speakers
  if (name === "reftest") return [{ id: "rt-quiet", kind: "silence", seconds: 14 }, { id: "rt-clicks", kind: "clicks", count: 10, spacing: 1 }, { id: "rt-reply", kind: "reply", asset: "reply-en-native.wav", lang: "en", seconds: 8 }];
  if (name === "smoke") {
    return [
      { id: "reply-en", kind: "reply", asset: "reply-en-native.wav", lang: "en", seconds: 8 },
      { id: "solo", kind: "events", reply: null, events: [{ clip: CLIPS[0], gainDb: 0, at: 1 }, { clip: CLIPS[1], gainDb: 12, at: 4 }] },
      { id: "dt-smoke", kind: "events", reply: reply(9), events: [{ clip: CLIPS[2], gainDb: 6, at: 2.5 }, { clip: CLIPS[3], gainDb: 0, at: 5.5 }] },
    ];
  }
  const plan = [
    { id: "ambient-1", kind: "silence", seconds: 20 },
    { id: "reply-en", kind: "reply", asset: "reply-en-native.wav", lang: "en", seconds: 25 },
    { id: "reply-pt", kind: "reply", asset: "reply-pt-native.wav", lang: "pt", seconds: 25 },
    { id: "clicks", kind: "clicks", count: 10, spacing: 1 },
    { id: "solo", kind: "events", reply: null, events: Array.from({ length: 12 }, (_, k) => ({ clip: CLIPS[(k * 5) % 6], gainDb: GAINS_DB[k % 3], at: 1 + 3.2 * k })) },
  ];
  const offsets = [[2.5, 5.5, 8.5, 11.5, 14.5, 17.5, 20.0], [2.0, 5.0, 8.0, 11.0, 14.0, 17.0, 19.5]];
  const order = [0, 6, 12, 0, 6, 12];
  order.forEach((gainDb, r) => {
    plan.push({
      id: `dt-g${gainDb}-${r < 3 ? "a" : "b"}`, kind: "events", reply: reply(25), gainDb,
      events: offsets[r < 3 ? 0 : 1].map((at, k) => ({ clip: CLIPS[(k + 3 * (r < 3 ? 0 : 1) + (r % 3)) % 6], gainDb, at })),
    });
  });
  plan.push({ id: "ambient-2", kind: "silence", seconds: 20 });
  return plan;
}

// ---------- local HTTP server: the page, the worklet, the assets, a clock ping, and uploads of the recordings
let workletSource = "";
let serverPort = 0;
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code, body, type = "text/plain") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    try {
      if (url.pathname === "/" || url.pathname === "/probe.html") return send(200, fs.readFileSync(path.join(here, "probe.html")), "text/html; charset=utf-8");
      if (url.pathname === "/worklet.js") return send(200, workletSource, "application/javascript");
      if (url.pathname === "/ping") return send(200, JSON.stringify({ hr: hrMs() }), "application/json");
      if (url.pathname === "/favicon.ico") return send(204, "");
      if (url.pathname.startsWith("/assets/")) {
        const file = path.join(assetsDir, path.basename(url.pathname));
        if (!file.endsWith(".wav") || !fs.existsSync(file)) return send(404, "no such asset");
        return send(200, fs.readFileSync(file), "audio/wav");
      }
      if (url.pathname === "/upload" && req.method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(400, "bad name");
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => { fs.writeFileSync(path.join(outDir, name), Buffer.concat(chunks)); send(200, "ok"); });
        return undefined;
      }
      return send(404, "not found");
    } catch (e) {
      return send(500, String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}

// ---------- PowerShell helper: plays WAVs with System.Media.SoundPlayer and stamps Stopwatch ticks around the Play() call
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$players = @{}
[Console]::Out.WriteLine('ready|0|' + [Diagnostics.Stopwatch]::Frequency)
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split('|')
  try {
    if ($p[0] -eq 'load') {
      $sp = New-Object System.Media.SoundPlayer $p[2]
      $sp.Load()
      $players[$p[2]] = $sp
      [Console]::Out.WriteLine('load|' + $p[1] + '|ok')
    } elseif ($p[0] -eq 'play') {
      $sp = $players[$p[2]]
      $t0 = [Diagnostics.Stopwatch]::GetTimestamp()
      $sp.Play()
      $t1 = [Diagnostics.Stopwatch]::GetTimestamp()
      [Console]::Out.WriteLine('play|' + $p[1] + '|' + $t0 + '|' + $t1)
    } elseif ($p[0] -eq 'now') {
      [Console]::Out.WriteLine('now|' + $p[1] + '|' + [Diagnostics.Stopwatch]::GetTimestamp())
    } elseif ($p[0] -eq 'stop') {
      foreach ($k in @($players.Keys)) { $players[$k].Stop() }
      [Console]::Out.WriteLine('stop|' + $p[1] + '|ok')
    } elseif ($p[0] -eq 'quit') {
      exit 0
    }
  } catch {
    [Console]::Out.WriteLine('err|' + $p[1] + '|' + $_.Exception.Message)
  }
}
`;
const helper = { child: null, freq: 1e7, waiting: new Map(), seq: 0, swBase: 0 };
async function startHelper() {
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PS_SCRIPT, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  helper.child = child;
  child.stderr.on("data", (d) => { const t = String(d).trim(); if (t && !t.startsWith("#< CLIXML") && !t.startsWith("<Objs")) log("powershell stderr:", t); });
  const rl = readline.createInterface({ input: child.stdout });
  const ready = new Promise((resolve) => helper.waiting.set("ready", resolve));
  rl.on("line", (line) => {
    const hrAck = hrMs();
    const [verb, id, ...rest] = line.trim().split("|");
    if (verb === "ready") { helper.freq = Number(rest[0]); helper.waiting.get("ready")?.({ hrAck }); return; }
    const w = helper.waiting.get(id);
    if (w) { helper.waiting.delete(id); w({ verb, rest, hrAck }); }
  });
  await ready;
}
function helperCall(verb, arg = "") {
  const id = String(++helper.seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { helper.waiting.delete(id); reject(new Error(`helper ${verb} timed out`)); }, 20000);
    helper.waiting.set(id, (r) => { clearTimeout(timer); if (r.verb === "err") reject(new Error(r.rest.join("|"))); else resolve(r); });
    helper.child.stdin.write(`${verb}|${id}|${arg}\n`);
  });
}
const ticksToMs = (t) => (Number(t) / helper.freq) * 1000;

// ---------- DevTools Protocol client (Node's global WebSocket)
class Cdp {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true }); });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    });
    this.ws.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== undefined) {
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.error) p.reject(new Error(d.error.message)); else p.resolve(d.result);
      } else if (d.method) for (const fn of this.handlers.get(d.method) ?? []) fn(d.params);
    });
  }
  on(method, fn) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("browser connection closed"));
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 240000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const out = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value;
  }
}

let edge = null;
let edgeProfile = "";
async function launchEdge() {
  const candidates = [args.edge, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
  const exe = candidates.find((c) => fs.existsSync(String(c)));
  if (!exe) throw new Error("msedge.exe not found; pass --edge <path>");
  edgeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "echo-probe-edge-"));
  const debugPort = 9300 + Math.floor(Math.random() * 600);
  const flags = [
    `--user-data-dir=${edgeProfile}`, `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*",
    "--use-fake-ui-for-media-stream", // accepts the microphone permission; the devices themselves are the real ones
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-default-apps",
    "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--no-pings",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--window-size=520,300", "--window-position=30,30",
    `http://127.0.0.1:${serverPort}/probe.html`,
  ];
  edge = spawn(String(exe), flags, { stdio: "ignore", cwd: os.tmpdir() });
  edge.on("exit", (code) => log("msedge exited", code));
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = list.find((t) => t.type === "page" && String(t.url).includes(`127.0.0.1:${serverPort}`));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("the Edge page did not appear on the DevTools port");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", (p) => log("page exception:", p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error" || p.type === "warning") log("page console", p.type, (p.args ?? []).map((a) => a.value ?? a.description).join(" ")); });
  try { await cdp.send("Browser.grantPermissions", { origin: `http://127.0.0.1:${serverPort}`, permissions: ["audioCapture"] }); } catch { /* the fake UI flag already accepts */ }
  try { await cdp.send("Page.bringToFront"); } catch { /* optional */ }
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval("typeof window.probe !== 'undefined' && document.readyState === 'complete'").catch(() => false)) break;
    await sleep(100);
  }
  return { cdp, version: version.Browser, exe: String(exe) };
}

/** Read-only: master volume and mute flag of the default speakers, communications speakers and microphone (endpoints.ps1). */
function readEndpoints() {
  try {
    const script = path.join(os.tmpdir(), "echo-probe-endpoints.ps1"); // a local copy: PowerShell dislikes scripts on a UNC share
    fs.copyFileSync(path.join(here, "endpoints.ps1"), script);
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 60000 });
    const line = (r.stdout ?? "").trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
    return { readAt: new Date().toISOString(), ...JSON.parse(line) };
  } catch (e) {
    return { readAt: new Date().toISOString(), error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Stops the browser this run started (its own process tree only) and removes its throwaway profile. */
function killBrowser() {
  if (edge?.pid) spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  edge = null;
  if (edgeProfile) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(edgeProfile, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); }
    }
    edgeProfile = "";
  }
}
function cleanup() {
  try { helper.child?.stdin.write("quit|0|\n"); } catch { /* gone */ }
  try { helper.child?.kill(); } catch { /* gone */ }
  killBrowser();
}

// ---------- clocks: Node's hrtime, PowerShell's Stopwatch and the page's performance.now() are all QueryPerformanceCounter based
async function stopwatchBase() {
  let best = null;
  for (let i = 0; i < 25; i++) {
    const h0 = hrMs();
    const r = await helperCall("now");
    const h1 = hrMs();
    const rtt = h1 - h0;
    const diff = ticksToMs(r.rest[0]) - (h0 + h1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, stopwatchMinusHrMs: diff };
  }
  return best;
}
let page = null;
async function cdpSync(n = 24) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const h0 = hrMs();
    const p = await page.eval("performance.now()");
    const h1 = hrMs();
    const rtt = h1 - h0;
    if (!best || rtt < best.rtt) best = { rtt, offset: (h0 + h1) / 2 - p };
  }
  return best;
}
async function pingSync(n = 40) {
  const samples = await page.eval(`probe.pingSync(${n})`);
  let best = null;
  for (const s of samples) {
    const rtt = s.t1 - s.t0;
    if (!best || rtt < best.rtt) best = { rtt, offset: s.hr - (s.t0 + s.t1) / 2 };
  }
  return best;
}
async function sleepUntilHr(target) {
  for (;;) {
    const d = target - hrMs();
    if (d <= 3) break;
    await sleep(Math.min(d - 2, 40));
  }
  while (hrMs() < target) { /* spin the last milliseconds */ }
}

// ---------- one run of the plan
/** Opt-in (--gate=<dBFS> [--gate-wait=<s>]): waits until the raw microphone has been quieter than the gate for 1 s. */
async function quietGate() {
  const gateDb = args.gate === undefined ? null : Number(args.gate);
  if (gateDb === null || Number.isNaN(gateDb)) return null;
  const maxWaitMs = Number(args["gate-wait"] ?? 20) * 1000;
  const t0 = hrMs();
  let level = null;
  for (;;) {
    level = await page.eval("probe.ambientDb(1000)");
    if (level.B <= gateDb || hrMs() - t0 > maxWaitMs) break;
    await sleep(500);
  }
  return { gateDb, waitedMs: Math.round(hrMs() - t0), rawDbfs: level.B, procDbfs: level.A, passed: level.B <= gateDb };
}

async function runItem(item, clipFile) {
  const startedWall = new Date().toISOString();
  const gate = await quietGate();
  const mark = await page.eval("probe.mark()");
  const syncBefore = await cdpSync();
  await sleep(PRE_ROLL_MS);
  const events = [];
  const plays = [];
  let endHr;
  if (item.kind === "silence") {
    endHr = hrMs() + item.seconds * 1000;
  } else if (item.kind === "reply") {
    const p = await page.eval(`probe.playReply(${JSON.stringify(item.asset)}, ${JSON.stringify({ durationSec: item.seconds, leadSec: LEAD_SEC })})`);
    plays.push(p);
    endHr = hrMs() + (item.seconds + LEAD_SEC) * 1000 + TAIL_MS;
  } else if (item.kind === "clicks") {
    const p = await page.eval(`probe.playClicks(${JSON.stringify({ count: item.count, spacingSec: item.spacing, leadSec: 0.5 })})`);
    plays.push(p);
    endHr = hrMs() + (0.5 + item.count * item.spacing) * 1000 + TAIL_MS;
  } else {
    let originHr;
    if (item.reply) {
      const p = await page.eval(`probe.playReply(${JSON.stringify(item.reply.asset)}, ${JSON.stringify({ durationSec: item.reply.seconds, leadSec: LEAD_SEC })})`);
      plays.push(p);
      originHr = p.perfCall + syncBefore.offset + LEAD_SEC * 1000;
    } else {
      originHr = hrMs() + 300;
    }
    const lastAt = Math.max(...item.events.map((e) => e.at));
    const totalSec = item.reply ? Math.max(item.reply.seconds, lastAt + 2.5) : lastAt + 2.5;
    for (const [index, ev] of item.events.entries()) {
      const target = originHr + ev.at * 1000;
      await sleepUntilHr(target);
      const hrSent = hrMs();
      const r = await helperCall("play", clipFile(ev.clip, ev.gainDb));
      events.push({
        index, clip: ev.clip, gainDb: ev.gainDb, clipFile: path.basename(clipFile(ev.clip, ev.gainDb)), atSec: ev.at,
        hrTarget: target, hrSent, hrCallBeforePlay: ticksToMs(r.rest[0]) - helper.swBase, hrCallAfterPlay: ticksToMs(r.rest[1]) - helper.swBase, hrAck: r.hrAck,
      });
    }
    endHr = originHr + totalSec * 1000 + TAIL_MS;
  }
  await sleepUntilHr(endHr);
  const syncAfter = await cdpSync();
  const exp = await page.eval(`probe.exportSegment(${JSON.stringify(item.id)}, ${JSON.stringify(mark)})`);
  const meta = { id: item.id, item, startedWall, gate, mark, sync: { before: syncBefore, after: syncAfter }, helper: { swBase: helper.swBase, freq: helper.freq }, events, export: exp };
  fs.writeFileSync(path.join(outDir, `${item.id}.json`), JSON.stringify(meta));
  const skew = Math.max(Math.abs(exp.refSkewSamples.min), Math.abs(exp.refSkewSamples.max));
  if (skew > 600) log(`WARNING: the reference is ${round(skew / 16, 0)} ms off the microphone's clock in ${item.id}: its recording cannot be used`);
  const summary = { id: item.id, seconds: round((exp.n1 - exp.n0) * 512 / 16000, 1), frames: exp.n1 - exp.n0, gaps: exp.gaps, refSkewSamples: exp.refSkewSamples, events: events.length, cf0: exp.cf0, syncRttMs: [round(syncBefore.rtt, 2), round(syncAfter.rtt, 2)], offsetDriftMs: round(syncAfter.offset - syncBefore.offset, 3) };
  log("done", JSON.stringify(summary));
  return summary;
}
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- main
async function main() {
  if (!args.assets && !process.env.ECHO_PROBE_ASSETS) throw new Error("pass --assets <dir> (reply-*-native.wav and stop-*-16k.wav)");
  fs.mkdirSync(path.join(outDir, "clips"), { recursive: true });
  workletSource = shippedWorklet() + WRAPPER;
  // the clips at three gains, as new WAV files (the system volume is never changed)
  const clipDir = path.join(outDir, "clips");
  for (const base of CLIPS) {
    const src = readWav16(path.join(assetsDir, `${base}-16k.wav`));
    for (const g of GAINS_DB) {
      const k = 10 ** (-g / 20);
      writeWav16(path.join(clipDir, `${base}-g${g}.wav`), Int16Array.from(src.pcm, (s) => Math.max(-32768, Math.min(32767, Math.round(s * k)))), src.rate);
    }
  }
  writeWav16(path.join(clipDir, "silence.wav"), new Int16Array(3200), 16000);
  const clipFile = (clip, g) => path.join(clipDir, `${clip}-g${g}.wav`);

  const server = await startServer();
  await startHelper();
  for (const base of CLIPS) for (const g of GAINS_DB) await helperCall("load", clipFile(base, g));
  await helperCall("load", path.join(clipDir, "silence.wav"));
  await helperCall("play", path.join(clipDir, "silence.wav")); // warm up the player path
  await sleep(500);
  const sw = await stopwatchBase();
  helper.swBase = sw.stopwatchMinusHrMs;
  log("stopwatch minus node hrtime (ms):", round(sw.stopwatchMinusHrMs, 3), "best round trip (ms):", round(sw.rtt, 2));

  const names = new Set([...buildPlan(planName).flatMap((i) => [i.asset, i.reply?.asset].filter(Boolean))]);
  const session = { tool: "echo-probe", startedWall: new Date().toISOString(), plan: planName, node: process.version, stopwatch: sw, outDir, assetsDir, worklet: { source: captureTs }, relaunches: 0 };
  try {
    session.pnp = JSON.parse(spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object FriendlyName | ConvertTo-Json -Compress"], { encoding: "utf8" }).stdout || "null");
  } catch { session.pnp = null; }

  // A muted speaker makes every echo and word number meaningless, so the tool stops before it plays anything (the check only reads).
  session.endpoints = readEndpoints();
  fs.writeFileSync(path.join(outDir, "endpoints.json"), JSON.stringify(session.endpoints, null, 2));
  const spk = session.endpoints.render;
  log("endpoints (read only): speakers", JSON.stringify(spk), "microphone", JSON.stringify(session.endpoints.capture));
  if (spk?.muted === true && !args["allow-muted"]) {
    session.stopped = `the default speakers are muted at the Windows endpoint (volume ${Math.round((spk.volume ?? 0) * 100)}%): nothing would be audible, so no echo can be measured. Unmute them yourself (this tool never changes a volume or a mute) or pass --allow-muted for a dry run.`;
    fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));
    console.log(JSON.stringify({ stopped: session.stopped, endpoints: session.endpoints }, null, 2));
    process.exitCode = 4;
    return server;
  }
  if (typeof spk?.volume === "number" && spk.volume < 0.05) log("warning: the speaker volume is below 5%; the echo may be below the room noise");

  /** Starts Edge, opens both microphone streams, loads the assets and syncs the clocks. Returns the mic check when the microphone is muted. */
  const bringUp = async () => {
    const launched = await launchEdge();
    page = launched.cdp;
    session.browser = launched.version;
    session.edgeExe = launched.exe;
    const init = await page.eval("probe.init()");
    session.init ??= init;
    log("context", JSON.stringify(init.ctx), "A:", JSON.stringify(init.A.settings), "B:", JSON.stringify(init.B.settings));
    // Where does the sound go? Headphones, earbuds and a TV never reach the microphone, so there would be nothing to cancel.
    const labels = init.devices.filter((d) => d.kind === "audiooutput").map((d) => d.label);
    session.defaultOutput = labels.find((l) => /^default\s*-/i.test(l)) ?? null;
    log("default output device:", session.defaultOutput);
    if (session.defaultOutput && /head(phone|set)|ear(bud|phone)|buds|airpod|hands-free/i.test(session.defaultOutput) && !args["allow-headphones"]) {
      return { reason: `the default output is "${session.defaultOutput}": sound played there does not reach the laptop microphone. Switch the default output to the speakers yourself (this tool never changes a device) or pass --allow-headphones.`, exitCode: 5 };
    }
    const check = await page.eval("probe.checkMic(1600)");
    session.micCheck ??= check;
    log("mic check", JSON.stringify({ A: check.A, B: check.B, same: check.identicalSampleFraction, cf0: check.cf0, muted: [check.tracks.A.muted, check.tracks.B.muted] }));
    if (check.B.allZero || check.tracks.B.muted === true || check.tracks.A.muted === true) return { reason: "the microphone is muted or blocked: the raw stream is all exact zeros or track.muted is true", exitCode: 3, micCheck: check };
    session.assets = [];
    for (const n of names) session.assets.push(await page.eval(`probe.loadAsset(${JSON.stringify(n)}, ${JSON.stringify(`/assets/${n}`)})`));
    session.clockStart = { ping: await pingSync(), cdp: await cdpSync() };
    log("clock offsets hr-perf (ms): ping", round(session.clockStart.ping.offset, 3), "cdp", round(session.clockStart.cdp.offset, 3));
    return null;
  };
  const blocked = await bringUp();
  if (blocked) {
    session.stopped = blocked.reason;
    fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));
    console.log(JSON.stringify({ stopped: session.stopped, micCheck: blocked.micCheck, defaultOutput: session.defaultOutput }, null, 2));
    process.exitCode = blocked.exitCode;
    return server;
  }

  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  session.runs = [];
  for (const item of buildPlan(planName)) {
    if (only && !only.has(item.id)) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        log("==", item.id, attempt > 1 ? `(attempt ${attempt})` : "");
        session.runs.push(await runItem(item, clipFile));
        break;
      } catch (e) {
        // the browser went away (someone closed the window) or the page failed: start again, up to twice per run
        log(`run ${item.id} failed: ${e.message}`);
        if (attempt >= 3) throw e;
        await helperCall("stop").catch(() => undefined);
        killBrowser();
        await sleep(1500);
        session.relaunches++;
        const again = await bringUp();
        if (again) throw new Error(`cannot continue after a relaunch: ${again.reason}`);
      }
    }
    fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));
  }
  session.clockEnd = { ping: await pingSync(), cdp: await cdpSync() };
  session.clockDriftMs = { ping: round(session.clockEnd.ping.offset - session.clockStart.ping.offset, 3), cdp: round(session.clockEnd.cdp.offset - session.clockStart.cdp.offset, 3), pingVsCdpStartMs: round(session.clockStart.ping.offset - session.clockStart.cdp.offset, 3) };
  session.finalInfo = await page.eval("probe.info()");
  fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));
  console.log(JSON.stringify({ outDir, runs: session.runs, clockDriftMs: session.clockDriftMs, stopwatchMinusHrMs: round(sw.stopwatchMinusHrMs, 3) }, null, 2));
  return server;
}

let serverRef = null;
process.on("SIGINT", () => { cleanup(); process.exit(130); });
try {
  serverRef = await main();
} catch (e) {
  console.error("echo-probe failed:", e?.stack ?? e);
  process.exitCode = process.exitCode || 1;
} finally {
  cleanup();
  serverRef?.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
