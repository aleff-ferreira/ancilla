import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findBrowser } from "../src/browser/find.js";
import { BrowserError, BrowserService, type BrowserEvent, type ScreencastFrame } from "../src/browser/service.js";

/**
 * The service against a real browser, whichever Edge, Chrome, Chromium or Brave this machine has. Without one the
 * tests are skipped with the reason; the CI runners (Windows, macOS, Linux) all have one. A fixture page is served from
 * a local http server so nothing leaves the machine.
 */

const found = findBrowser();
const SKIP: string | false = found.browser ? false : `no browser to drive: ${found.reason}`;
const DOWNLOAD_BODY = "the bytes of the file";
const DOWNLOAD_NAME = `ancilla-test-${process.pid}-${Date.now()}.bin`;

let server: Server;
let base = "";
let dataDir = "";
let svc: BrowserService;
/** What the assistant's download question answers: the folder the person chose, or null for a no. */
let gateFolder: string | null = null;
const cookiesSeen: Array<string | undefined> = [];
let downloadRequests = 0;
let startedMs = 0;
let pid: number | null = null;
let sandboxSkip: string | null = null;
const metrics: Record<string, unknown> = {};

const PAGE = `<!doctype html><title>Fixture</title><h1>Fixture page</h1><a href="/next">Go next</a>
<label>Name <input id="n" aria-label="Name"></label>
<button onclick="document.getElementById('out').textContent='clicked'">Press</button><p id="out"></p>
<p style="display:none">HIDDEN-ONE</p><p style="opacity:0">HIDDEN-TWO</p><p style="font-size:0">HIDDEN-THREE</p>
<p style="position:absolute;left:-9999px">HIDDEN-FOUR</p><p>Visible paragraph</p><a href="/file.bin">Download</a>`;

before(async () => {
  if (SKIP) return;
  dataDir = mkdtempSync(join(tmpdir(), "ancilla-browser-real-"));
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (path === "/") return html(PAGE);
    if (path === "/next") return html("<!doctype html><title>Next page</title><h1>Arrived</h1>");
    if (path === "/set") {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=assistant-secret; Path=/" });
      return void res.end("set");
    }
    if (path === "/whoami") {
      cookiesSeen.push(req.headers.cookie);
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("whoami");
    }
    if (path === "/file.bin") {
      downloadRequests += 1;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"` });
      return void res.end(DOWNLOAD_BODY);
    }
    if (path === "/anim") {
      return html("<!doctype html><body><script>let i=0;(function f(){document.body.style.background='hsl('+((i++*7)%360)+',80%,50%)';requestAnimationFrame(f)})()</script>");
    }
    if (path === "/latency") {
      return html("<!doctype html><body style='margin:0;height:100vh;background:blue' onmousedown=\"this.style.background=this.style.background=='red'?'blue':'red'\">");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  svc = new BrowserService({ dataDir, downloadGate: async () => gateFolder });
});

after(async () => {
  if (SKIP) return;
  await svc.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a profile file for a moment after the browser exits
  }
  console.log(`BROWSER-METRICS ${JSON.stringify({ browser: found.browser, ...metrics })}`);
});

const real = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: SKIP }, async (t) => {
    if (sandboxSkip) return void t.skip(sandboxSkip);
    await fn();
  });

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let tabId = "";

real("starts lazily, finds the page, and its snapshot has the roles and none of the hidden text", async () => {
  const t0 = Date.now();
  try {
    const tab = await svc.openTab("assistant", `${base}/`);
    tabId = tab.id;
  } catch (error) {
    // A Linux box that forbids the browser's own sandbox: Ancilla does not weaken it, so the test cannot run there.
    if (process.platform === "linux" && error instanceof BrowserError && error.code === "unavailable") {
      sandboxSkip = `the browser could not start sandboxed on this Linux machine: ${error.message}`;
      console.log(`SKIPPED: ${sandboxSkip}`);
      return;
    }
    throw error;
  }
  startedMs = Date.now() - t0;
  pid = svc.processId();
  metrics["startAndFirstPageMs"] = startedMs;
  const snap = await svc.snapshot(tabId);
  assert.match(snap.text, /heading "Fixture page" level=1/);
  assert.match(snap.text, /link "Go next".*\[ref=e\d+\]/);
  assert.match(snap.text, /textbox "Name".*\[ref=e\d+\]/);
  assert.match(snap.text, /button "Press"/);
  assert.match(snap.text, /Visible paragraph/);
  for (const hidden of ["HIDDEN-ONE", "HIDDEN-TWO", "HIDDEN-THREE", "HIDDEN-FOUR"]) assert.ok(!snap.text.includes(hidden), `${hidden} must not reach the model`);
});

real("typing goes into the field and a click that navigates arrives on the next page", async () => {
  const snap = await svc.snapshot(tabId);
  const ref = (re: RegExp) => /\[ref=(e\d+)\]/.exec(snap.text.split("\n").find((l) => re.test(l)) ?? "")![1]!;
  await svc.type(tabId, { ref: ref(/textbox "Name"/) }, "olá mundo");
  assert.match((await svc.snapshot(tabId)).text, /textbox "Name" .*value="olá mundo"/);
  await svc.click(tabId, { ref: ref(/button "Press"/) });
  assert.match((await svc.snapshot(tabId)).text, /text "clicked"/);
  const link = ref(/link "Go next"/);
  const fresh = await svc.snapshot(tabId);
  assert.ok(fresh.refs > 0);
  await svc.click(tabId, { ref: /\[ref=(e\d+)\]/.exec(fresh.text.split("\n").find((l) => /link "Go next"/.test(l))!)![1]! });
  void link;
  await until(async () => (await svc.listTabs()).find((t) => t.id === tabId)?.url.endsWith("/next") === true, "the tab to reach /next");
  assert.match((await svc.snapshot(tabId)).text, /heading "Arrived"/);
  await until(async () => (await svc.listTabs()).find((t) => t.id === tabId)?.title === "Next page", "the title to follow the page");
  await svc.back(tabId);
  assert.ok((await svc.listTabs()).find((t) => t.id === tabId)!.url.endsWith("/"));
});

real("a screenshot is a PNG", async () => {
  const png = await svc.screenshot(tabId);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.length > 1000);
});

real("screencast frames arrive, are capped, and a click shows in the next frame quickly", async () => {
  await svc.navigate(tabId, `${base}/anim`);
  const frames: ScreencastFrame[] = [];
  const stop = await svc.screencast(tabId, (f) => void frames.push(f), { maxFps: 30 });
  await new Promise((r) => setTimeout(r, 2000));
  stop();
  assert.ok(frames.length >= 5, `only ${frames.length} frames in 2 s`);
  assert.ok(frames.length <= 30 * 2 + 6, `${frames.length} frames in 2 s exceeds the 30 fps cap`);
  assert.ok(frames[0]!.data.length > 100 && frames[0]!.width > 0);
  metrics["screencastFpsCap30"] = Number((frames.length / 2).toFixed(1));

  await svc.navigate(tabId, `${base}/latency`);
  let last = 0;
  let waiters: Array<() => void> = [];
  const stop2 = await svc.screencast(tabId, () => {
    last = performance.now();
    for (const w of waiters.splice(0)) w();
  }, { maxFps: 60 });
  await new Promise((r) => setTimeout(r, 400));
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const before = last;
    const t0 = performance.now();
    const next = new Promise<void>((resolve) => waiters.push(resolve));
    await svc.dispatchMouse(tabId, { type: "mousePressed", x: 50, y: 50, button: "left", buttons: 1, clickCount: 1 });
    await svc.dispatchMouse(tabId, { type: "mouseReleased", x: 50, y: 50, button: "left", buttons: 0, clickCount: 1 });
    await Promise.race([next, new Promise((r) => setTimeout(r, 2000))]);
    if (last > before) samples.push(last - t0);
    await new Promise((r) => setTimeout(r, 80));
  }
  stop2();
  assert.ok(samples.length >= 10, `only ${samples.length} of 15 clicks produced a frame`);
  samples.sort((a, b) => a - b);
  metrics["clickToFrameMs"] = { p50: Math.round(samples[Math.floor(samples.length / 2)]!), max: Math.round(samples.at(-1)!), n: samples.length };
  // the fps the service can deliver uncapped by the fixture's own animation
  await svc.navigate(tabId, `${base}/anim`);
  const fast: ScreencastFrame[] = [];
  const stop3 = await svc.screencast(tabId, (f) => void fast.push(f), { maxFps: 60 });
  await new Promise((r) => setTimeout(r, 2000));
  stop3();
  metrics["screencastFpsCap60"] = Number((fast.length / 2).toFixed(1));
});

real("the two contexts do not share cookies", async () => {
  await svc.navigate(tabId, `${base}/set`);
  await svc.navigate(tabId, `${base}/whoami`);
  assert.equal(cookiesSeen.at(-1), "sid=assistant-secret", "the assistant's own context keeps its cookie");
  const you = await svc.openTab("you", `${base}/whoami`);
  assert.equal(cookiesSeen.at(-1), undefined, "the user's context must not see the assistant's cookie");
  const tabs = await svc.listTabs();
  assert.equal(tabs.find((t) => t.id === you.id)?.context, "you");
  await svc.resetAssistant();
  const again = await svc.openTab("assistant", `${base}/whoami`);
  assert.equal(cookiesSeen.at(-1), undefined, "a reset assistant context starts without cookies");
  tabId = again.id;
});

real("downloads: staged, asked, saved only where the person says; a no deletes; the assistant's asks through its gate", async () => {
  const where = () => [join(homedir(), "Downloads"), dataDir].flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [e.name]));
  const events: BrowserEvent[] = [];
  const off = svc.on((e) => events.push(e));
  const clickDownload = async (id: string) => {
    await svc.navigate(id, `${base}/`);
    const snap = await svc.snapshot(id);
    const line = snap.text.split("\n").find((l) => /link "Download"/.test(l))!;
    await svc.click(id, { ref: /\[ref=(e\d+)\]/.exec(line)![1]! });
  };
  const until = async (test: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !test(); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.ok(test(), what);
  };
  // The person's own tab: asked, nothing written before the answer, then saved where they said.
  const mine = await svc.openTab("you");
  await clickDownload(mine.id);
  await until(() => svc.pendingDownloads().length === 1, "the question");
  assert.equal(svc.pendingDownloads()[0]!.name, DOWNLOAD_NAME);
  assert.equal(svc.pendingDownloads()[0]!.size, DOWNLOAD_BODY.length);
  assert.ok(!where().includes(DOWNLOAD_NAME) && !walk(join(dataDir, "browser", "profile")).includes(DOWNLOAD_NAME), "nothing is written before an answer");
  assert.equal(readdirSync(svc.downloads.dir).length, 1, "it waits in staging");
  const folder = mkdtempSync(join(tmpdir(), "ancilla-real-dl-"));
  svc.answerDownload(svc.pendingDownloads()[0]!.id, true, folder);
  await until(() => existsSync(join(folder, DOWNLOAD_NAME)), "the file in the chosen folder");
  assert.equal(readFileSync(join(folder, DOWNLOAD_NAME), "utf8"), DOWNLOAD_BODY);
  await until(() => readdirSync(svc.downloads.dir).length === 0, "staging emptied");
  // The same file again never replaces the first.
  await clickDownload(mine.id);
  await until(() => svc.pendingDownloads().length === 1, "the second question");
  svc.answerDownload(svc.pendingDownloads()[0]!.id, true, folder);
  await until(() => readdirSync(folder).length === 2, "a second copy with its own name");
  assert.ok(readdirSync(folder).some((n) => / \(1\)\./.test(n)), "' (1)' added");
  // Don't save: gone, nothing anywhere.
  await clickDownload(mine.id);
  await until(() => svc.pendingDownloads().length === 1, "the third question");
  svc.answerDownload(svc.pendingDownloads()[0]!.id, false);
  await until(() => readdirSync(svc.downloads.dir).length === 0, "deleted");
  assert.equal(readdirSync(folder).length, 2);
  assert.ok(!where().includes(DOWNLOAD_NAME));
  // The assistant's tab: its gate decides, with the person's folder; a no (or no gate answer) saves nothing.
  const theirs = await svc.openTab("assistant");
  const asked = events.filter((e) => e.type === "download").length;
  gateFolder = null;
  await clickDownload(theirs.id);
  await until(() => events.some((e) => e.type === "notice" && /was not saved/.test(e.text) && e.tabId === theirs.id), "the assistant's no");
  assert.equal(readdirSync(folder).length, 2);
  gateFolder = folder;
  await clickDownload(theirs.id);
  await until(() => readdirSync(folder).length === 3, "the assistant's file, after a yes");
  assert.equal(events.filter((e) => e.type === "download").length, asked, "the pane was not asked about the assistant's file");
  assert.ok(downloadRequests >= 1);
  off();
  await svc.closeTab(mine.id).catch(() => undefined);
});


real("a refused scheme is refused, and the tab is unchanged", async () => {
  const before = (await svc.listTabs()).find((t) => t.id === tabId)!.url;
  for (const bad of ["file:///etc/hosts", "chrome://version", "edge://version", "view-source:http://example.com", "javascript:alert(1)", "data:text/html,hi"]) {
    await assert.rejects(svc.navigate(tabId, bad), (e: unknown) => e instanceof BrowserError && e.code === "scheme", bad);
  }
  assert.equal((await svc.listTabs()).find((t) => t.id === tabId)!.url, before);
});

real("dispose ends the browser and leaves no process behind", async () => {
  assert.ok(pid && pid > 0);
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(pid!), true);
  const t0 = Date.now();
  await svc.dispose();
  metrics["stopMs"] = Date.now() - t0;
  await until(() => !alive(pid!), "the browser process to be gone", 5000);
  assert.equal(svc.processId(), null);
  assert.equal((await svc.status()).running, false);
});
