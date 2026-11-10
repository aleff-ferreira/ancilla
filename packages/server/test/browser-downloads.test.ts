import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DownloadDesk, DownloadError, MAX_DOWNLOAD_BYTES, checkDownloadFolder, freeName, riskWarning, sanitizeFileName } from "../src/browser/downloads.js";
import { BrowseRunner } from "../src/browser/runner.js";
import { BrowseSites } from "../src/browser/sites.js";
import { BrowserService, type BrowserEvent, type DownloadRequest } from "../src/browser/service.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";
import { waitFor } from "./harness.js";

const FOUND = { browser: { kind: "edge" as const, path: "/fake/edge" } };
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `ancilla-dl-${name}-`));
const GUID = "0123abcd-4567-89ef-0123-456789abcdef";
const sent = (fake: FakeBrowser, method: string) => fake.calls.filter((c) => c.method === method);

function rig(extra: Partial<ConstructorParameters<typeof BrowserService>[0]> = {}) {
  const fake = fakeBrowser(healthy());
  const svc = new BrowserService({ dataDir: tmp("data"), find: () => FOUND, launch: () => fake.proc, gracefulMs: 200, ...extra });
  const events: BrowserEvent[] = [];
  svc.on((e) => events.push(e));
  return { fake, svc, events };
}

/** The browser reports a download that finished: the bytes sit in staging under the guid, as `allowAndName` does it. */
async function finished(r: ReturnType<typeof rig>, tabId: string, options: { guid?: string; name?: string; bytes?: string; total?: number } = {}) {
  const guid = options.guid ?? GUID;
  writeFileSync(join(r.svc.downloads.dir, guid), options.bytes ?? "hello");
  r.fake.emit("Browser.downloadWillBegin", { frameId: tabId, guid, url: "https://shop.example/files/report.pdf", suggestedFilename: options.name ?? "report.pdf" });
  r.fake.emit("Browser.downloadProgress", { guid, totalBytes: options.total ?? 5, receivedBytes: options.total ?? 5, state: "completed" });
  return guid;
}

const staged = (r: ReturnType<typeof rig>) => readdirSync(r.svc.downloads.dir);

// ------------------------------------------------------------------ the rules

test("file names: no separators or control characters, no reserved Windows names, bounded, extension kept", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), ".._.._etc_passwd".replace(/^\.+/, ""));
  assert.equal(sanitizeFileName("a\\b/c.txt"), "a_b_c.txt");
  assert.equal(sanitizeFileName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeFileName("nul"), "_nul");
  assert.equal(sanitizeFileName("  .hidden. "), "hidden");
  assert.equal(sanitizeFileName(""), "download");
  assert.equal(sanitizeFileName("x\u0000y\u0007z.zip"), "x_y_z.zip");
  const long = sanitizeFileName(`${"a".repeat(500)}.tar`);
  assert.ok(long.length <= 120 && long.endsWith(".tar"));
  assert.ok(!/[\\/]/.test(sanitizeFileName("..\\..\\boot.ini")));
});

test("files that run programs get a plain warning, others none", () => {
  for (const name of ["setup.exe", "a.MSI", "run.sh", "x.ps1", "tool.jar", "Thing.dmg", "page.lnk", "go.bat"]) assert.match(riskWarning(name) ?? "", /can run programs/, name);
  for (const name of ["report.pdf", "photo.png", "notes.txt", "data.csv"]) assert.equal(riskWarning(name), null, name);
});

test("a folder must be an existing, writable, full path", () => {
  const dir = tmp("folder");
  assert.equal(checkDownloadFolder(dir), dir);
  assert.throws(() => checkDownloadFolder(join(dir, "nope")), /does not exist/);
  assert.throws(() => checkDownloadFolder("relative/folder"), /full folder path/);
  assert.throws(() => checkDownloadFolder(""), DownloadError);
  writeFileSync(join(dir, "file.txt"), "x");
  assert.throws(() => checkDownloadFolder(join(dir, "file.txt")), /not a folder/);
});

test("freeName never reuses a name that is there: ' (1)', ' (2)'", () => {
  const dir = tmp("free");
  assert.equal(freeName(dir, "a.txt"), "a.txt");
  writeFileSync(join(dir, "a.txt"), "1");
  assert.equal(freeName(dir, "a.txt"), "a (1).txt");
  writeFileSync(join(dir, "a (1).txt"), "2");
  assert.equal(freeName(dir, "a.txt"), "a (2).txt");
});

test("save: moves the staged file, never over one that exists, never outside the folder, remembers the folder", () => {
  const base = tmp("desk");
  const folder = tmp("dest");
  const desk = new DownloadDesk(join(base, "staging"), join(base, "last.json"), base);
  desk.reset();
  writeFileSync(join(desk.dir, GUID), "NEW");
  writeFileSync(join(folder, "report.pdf"), "OLD");
  const saved = desk.save(GUID, "report.pdf", folder);
  assert.equal(saved, join(folder, "report (1).pdf"));
  assert.equal(readFileSync(join(folder, "report.pdf"), "utf8"), "OLD", "the existing file is untouched");
  assert.equal(readFileSync(saved, "utf8"), "NEW");
  assert.deepEqual(readdirSync(desk.dir), [], "staging is empty after a save");
  assert.equal(new DownloadDesk(join(base, "staging"), join(base, "last.json"), base).defaultFolder(), folder, "the last folder is the next default");

  writeFileSync(join(desk.dir, GUID), "EVIL");
  const escaped = desk.save(GUID, "../../escape.txt", folder);
  assert.equal(join(escaped, ".."), folder, "a traversal in the name stays inside the folder");
  assert.ok(!existsSync(join(folder, "..", "escape.txt")) && !existsSync(join(folder, "..", "..", "escape.txt")));

  writeFileSync(join(desk.dir, GUID), "X");
  assert.throws(() => desk.save(GUID, "a.txt", join(folder, "missing")), /does not exist/);
  assert.ok(existsSync(join(desk.dir, GUID)), "a refused folder keeps the file waiting");
  assert.throws(() => desk.stagedPath("../x"), DownloadError);
  writeFileSync(join(desk.dir, "left-over-123456"), "stale");
  desk.reset();
  assert.deepEqual(readdirSync(desk.dir), [], "staging is emptied at start");
});

// ------------------------------------------------------------------ the person's own tab

test("their tab: the file is staged, the person is asked, and only their answer moves it", async () => {
  const r = rig();
  const tab = await r.svc.openTab("you");
  const folder = tmp("dest");
  await finished(r, tab.id);
  await waitFor(() => r.events.some((e) => e.type === "download"), "the question");
  const ask = r.events.find((e) => e.type === "download");
  assert.ok(ask && ask.type === "download");
  assert.equal(ask.download.name, "report.pdf");
  assert.equal(ask.download.tabId, tab.id);
  assert.equal(ask.download.size, 5);
  assert.equal(ask.download.warning, null);
  assert.deepEqual(readdirSync(folder), [], "nothing is written before an answer");
  assert.deepEqual(staged(r), [GUID], "it waits in staging");
  assert.equal(r.svc.pendingDownloads().length, 1);
  r.svc.answerDownload(GUID, true, folder);
  await waitFor(() => readdirSync(folder).length === 1, "the save");
  assert.equal(readFileSync(join(folder, "report.pdf"), "utf8"), "hello");
  await waitFor(() => staged(r).length === 0, "staging emptied");
  assert.ok(r.events.some((e) => e.type === "notice" && e.kind === "download" && /Saved report\.pdf/.test(e.text)));
  assert.ok(r.events.some((e) => e.type === "download-closed"));
  await r.svc.dispose();
});

test("their tab: Don't save deletes the staged file and writes nothing", async () => {
  const r = rig();
  const tab = await r.svc.openTab("you");
  const folder = tmp("dest");
  await finished(r, tab.id);
  await waitFor(() => r.svc.pendingDownloads().length === 1, "the question");
  r.svc.answerDownload(GUID, false);
  await waitFor(() => staged(r).length === 0, "deleted");
  assert.deepEqual(readdirSync(folder), []);
  assert.ok(r.events.some((e) => e.type === "notice" && /was not saved/.test(e.text)));
  assert.throws(() => r.svc.answerDownload(GUID, true, folder), /not waiting any more/);
  await r.svc.dispose();
});

test("their tab: a folder that cannot be used is refused and the question stays", async () => {
  const r = rig();
  const tab = await r.svc.openTab("you");
  const folder = tmp("dest");
  await finished(r, tab.id);
  await waitFor(() => r.svc.pendingDownloads().length === 1, "the question");
  assert.throws(() => r.svc.answerDownload(GUID, true, join(folder, "missing")), /does not exist/);
  assert.equal(r.svc.pendingDownloads().length, 1, "still waiting");
  assert.deepEqual(readdirSync(folder), []);
  r.svc.answerDownload(GUID, true, folder);
  await waitFor(() => readdirSync(folder).length === 1, "saved into the good folder");
  await r.svc.dispose();
});

test("no answer in time deletes the file and closes the question", async () => {
  const r = rig({ downloadAskMs: 40 });
  const tab = await r.svc.openTab("you");
  await finished(r, tab.id);
  await waitFor(() => r.events.some((e) => e.type === "download-closed"), "the question to expire");
  await waitFor(() => staged(r).length === 0, "staging emptied");
  assert.equal(r.svc.pendingDownloads().length, 0);
  await r.svc.dispose();
});

test("closing the browser deletes what was waiting", async () => {
  const r = rig();
  const tab = await r.svc.openTab("you");
  await finished(r, tab.id);
  await waitFor(() => r.svc.pendingDownloads().length === 1, "the question");
  await r.svc.stop();
  assert.deepEqual(staged(r), []);
  assert.equal(r.svc.pendingDownloads().length, 0);
});

test("one file over the cap is cancelled, and a made-up id is ignored", async () => {
  const r = rig();
  const tab = await r.svc.openTab("you");
  r.fake.emit("Browser.downloadWillBegin", { frameId: tab.id, guid: GUID, url: "https://x.example/big.iso", suggestedFilename: "big.iso" });
  r.fake.emit("Browser.downloadProgress", { guid: GUID, totalBytes: MAX_DOWNLOAD_BYTES + 1, receivedBytes: 10, state: "inProgress" });
  await waitFor(() => sent(r.fake, "Browser.cancelDownload").length === 1, "the cancel");
  assert.ok(r.events.some((e) => e.type === "notice" && /bigger than 1 GB/.test(e.text)));
  assert.equal(r.events.filter((e) => e.type === "download").length, 0, "no question for a refused file");
  r.fake.emit("Browser.downloadWillBegin", { frameId: tab.id, guid: "../../x", url: "https://x.example/a", suggestedFilename: "a" });
  r.fake.emit("Browser.downloadProgress", { guid: "../../x", totalBytes: 1, receivedBytes: 1, state: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(r.events.filter((e) => e.type === "download").length, 0);
  await r.svc.dispose();
});

// ------------------------------------------------------------------ the assistant's tab

test("the assistant's download goes to its gate, not to the pane; the folder is the one the person gave", async () => {
  const folder = tmp("dest");
  const asked: DownloadRequest[] = [];
  const r = rig({ downloadGate: async (request) => (asked.push(request), folder) });
  const tab = await r.svc.openTab("assistant");
  await finished(r, tab.id, { name: "setup.exe" });
  await waitFor(() => readdirSync(folder).length === 1, "the save");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.name, "setup.exe");
  assert.match(asked[0]?.warning ?? "", /can run programs/);
  assert.equal(r.events.filter((e) => e.type === "download").length, 0, "the pane is not asked about the assistant's file");
  assert.deepEqual(readdirSync(folder), ["setup.exe"]);
  await r.svc.dispose();
});

test("the assistant's download is deleted on a no, and when nothing can ask", async () => {
  const folder = tmp("dest");
  const no = rig({ downloadGate: async () => null });
  await finished(no, (await no.svc.openTab("assistant")).id);
  await waitFor(() => no.events.some((e) => e.type === "notice" && /was not saved/.test(e.text)), "refused");
  await waitFor(() => staged(no).length === 0, "deleted");
  await no.svc.dispose();
  const none = rig();
  await finished(none, (await none.svc.openTab("assistant")).id);
  await waitFor(() => staged(none).length === 0 && none.events.some((e) => e.type === "notice"), "deleted without a gate");
  assert.deepEqual(readdirSync(folder), []);
  await none.svc.dispose();
});

// ------------------------------------------------------------------ the question of a web task

function questionRig() {
  const sites = new BrowseSites(null, () => ({ taskId: () => "t1", gateChanged: () => undefined }));
  const runner = new BrowseRunner({ service: () => ({}) as never, brain: () => ({ brain: {} as never, problem: null }), gate: sites.gate, log: () => undefined, surface: () => ({}) as never });
  return { sites, runner };
}

test("a web task's download is a question with the file in it; the person's folder is the one used", async () => {
  const { sites, runner } = questionRig();
  const dest = tmp("dest");
  const asking = sites.decideDownload({ name: "a.pdf", size: 10, origin: "https://a.example", page: "A", folder: tmp("default"), warning: null });
  const shown = sites.gate.pending();
  assert.equal(shown?.type, "action");
  assert.equal(shown?.type === "action" ? shown.download?.name : null, "a.pdf");
  assert.throws(() => runner.answerAction("t1", "do", join(dest, "missing")), /does not exist/);
  assert.notEqual(sites.gate.pending(), null, "a folder that fails leaves the question");
  runner.answerAction("t1", "do", dest);
  assert.equal(await asking, dest);
});

test("a web task's download: no folder given uses the default shown; a no is null; no task browsing is null", async () => {
  const { sites, runner } = questionRig();
  const def = tmp("default");
  const yes = sites.decideDownload({ name: "a.pdf", size: null, origin: "https://a.example", page: "", folder: def, warning: null });
  runner.answerAction("t1", "do");
  assert.equal(await yes, def);
  const no = sites.decideDownload({ name: "a.pdf", size: null, origin: "https://a.example", page: "", folder: def, warning: null });
  runner.answerAction("t1", "dont");
  assert.equal(await no, null);
  const idle = new BrowseSites(null, () => ({ taskId: () => null, gateChanged: () => undefined }));
  assert.equal(await idle.decideDownload({ name: "a", size: null, origin: "", page: "", folder: def, warning: null }), null);
  mkdirSync(join(def, "x"), { recursive: true });
});
