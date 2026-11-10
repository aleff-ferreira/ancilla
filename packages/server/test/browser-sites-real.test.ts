import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findBrowser } from "../src/browser/find.js";
import { BrowserError, BrowserService } from "../src/browser/service.js";
import { BrowseSites, type SiteAnswer, type SiteQuestion } from "../src/browser/sites.js";

/**
 * The sites gate against a real browser: a page of the assistant's tab is held until the gate has answered, for a link, a
 * redirect and a frame as much as for an address typed in; a refused one never reaches the server; a popup is closed and a
 * dialog does not freeze the page. Five local servers stand for five sites (a port is an origin). Skipped, with the reason,
 * where there is no browser.
 */

const found = findBrowser();
const SKIP: string | false = found.browser ? false : `no browser to drive: ${found.reason}`;
const TASK = "t_web";

interface Site {
  name: string;
  server: Server;
  origin: string;
  hits: string[];
}

const sites: Record<string, Site> = {};
let dataDir = "";
let svc: BrowserService;
let rules: BrowseSites;
let sandboxSkip: string | null = null;

function listen(name: string, handler: (path: string, site: Site) => { type?: string; body?: string; status?: number; location?: string }): Promise<void> {
  const site: Site = { name, origin: "", hits: [], server: createServer() };
  site.server.on("request", (req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    // The browser asks for an icon after a page loads; it is not a page and is left out of what the sites saw.
    if (path !== "/favicon.ico") site.hits.push(path);
    const out = handler(path, site);
    res.writeHead(out.status ?? 200, { "content-type": out.type ?? "text/html; charset=utf-8", ...(out.location ? { location: out.location } : {}) });
    res.end(out.body ?? "");
  });
  sites[name] = site;
  return new Promise((resolve) =>
    site.server.listen(0, "127.0.0.1", () => {
      site.origin = `http://127.0.0.1:${(site.server.address() as { port: number }).port}`;
      resolve();
    }),
  );
}

before(async () => {
  if (SKIP) return;
  dataDir = mkdtempSync(join(tmpdir(), "ancilla-sites-real-"));
  // The sites that are not A are made first so that A can link to them.
  await listen("b", (path) => ({ body: `<!doctype html><title>B ${path}</title><h1>B says hello</h1>` }));
  await listen("c", (path) => ({ body: `<!doctype html><title>C ${path}</title><h1>C says hello</h1>` }));
  await listen("d", (path) => ({ body: `<!doctype html><title>D ${path}</title><h1>D says hello</h1>` }));
  await listen("e", (path) => ({ body: `<!doctype html><title>E ${path}</title><h1>E says hello</h1>` }));
  await listen("f", (path) => ({ body: `<!doctype html><title>F ${path}</title><h1>F says hello</h1>` }));
  const [b, c, d, e, f] = [sites.b as Site, sites.c as Site, sites.d as Site, sites.e as Site, sites.f as Site];
  await listen("a", (path) => {
    if (path === "/") return { body: `<!doctype html><title>A home</title><h1>A home</h1><a href="${b.origin}/landed">To B</a> <a href="/frames">Frames</a> <button onclick="window.open('${e.origin}/popup')">Pop</button>` };
    if (path === "/redirect") return { status: 302, location: `${d.origin}/redirected` };
    if (path === "/frames") return { body: `<!doctype html><title>A frames</title><h1>A frames</h1><iframe src="${f.origin}/frame"></iframe><iframe src="${c.origin}/frame"></iframe>` };
    if (path === "/dialog") return { body: `<!doctype html><title>A dialog</title><h1>A dialog</h1><script>alert("hello"); window.__after = true;</script><p>after the alert</p>` };
    return { status: 404 };
  });
  rules = new BrowseSites(null, () => ({ taskId: () => TASK, gateChanged: () => undefined }));
  svc = new BrowserService({ dataDir, siteGate: (request) => rules.decide(request) });
});

after(async () => {
  if (SKIP) return;
  await svc.dispose();
  for (const site of Object.values(sites)) await new Promise<void>((resolve) => site.server.close(() => resolve()));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a profile file for a moment after the browser exits
  }
});

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function answer(origin: string, how: SiteAnswer): Promise<void> {
  await until(() => rules.gate.pending() !== null, `a question about ${origin}`);
  const question = rules.gate.pending() as SiteQuestion;
  assert.equal(question.origin, origin);
  assert.equal(question.kind, "local", "a test server is on this computer");
  rules.gate.answer(question.id, how);
}

const real = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: SKIP, timeout: 120_000 }, async (t) => {
    if (sandboxSkip) return void t.skip(sandboxSkip);
    await fn();
  });

let tab = "";
const a = () => (sites.a as Site).origin;
const heading = async () => /heading "([^"]*)"/.exec((await svc.snapshot(tab)).text)?.[1] ?? "";

real("a page typed in waits for the answer, and loads once it is allowed", async () => {
  try {
    tab = (await svc.openTab("assistant")).id;
  } catch (error) {
    if (process.platform === "linux" && error instanceof BrowserError && error.code === "unavailable") {
      sandboxSkip = `the browser could not start sandboxed on this Linux machine: ${error.message}`;
      console.log(`SKIPPED: ${sandboxSkip}`);
      return;
    }
    throw error;
  }
  const loading = svc.navigate(tab, `${a()}/`);
  await until(() => rules.gate.pending() !== null, "the question");
  assert.deepEqual((sites.a as Site).hits, [], "nothing was sent to the site while the question was open");
  await answer(a(), "task");
  await loading;
  assert.equal(await heading(), "A home");
  assert.deepEqual((sites.a as Site).hits, ["/"]);
});

real("a link to another site is held; refused, it never reaches that site, and the assistant is told", async () => {
  const link = /\[ref=(e\d+)\]/.exec((await svc.snapshot(tab)).text.split("\n").find((l) => /link "To B"/.test(l)) ?? "")![1]!;
  const clicked = svc.click(tab, { ref: link });
  await answer((sites.b as Site).origin, "not-now");
  await clicked;
  assert.deepEqual((sites.b as Site).hits, [], "the request was failed before it left the browser");
  assert.equal(await heading(), "A home", "and the page that had the link is still there");
  assert.equal((await svc.listTabs()).find((t) => t.id === tab)?.url, `${a()}/`);
  const notes = svc.takeNotes(tab);
  assert.deepEqual(notes, [`${(sites.b as Site).origin} was not opened: the person did not allow it.`]);
});

real("a site that was refused for the task is not asked about again, and an address typed in for it is a blocked error", async () => {
  await assert.rejects(svc.navigate(tab, `${(sites.b as Site).origin}/landed`), (e: unknown) => e instanceof BrowserError && e.code === "blocked");
  assert.equal(rules.gate.pending(), null, "no second question");
  assert.deepEqual((sites.b as Site).hits, []);
  assert.equal(await heading(), "A home", "a refused address leaves the page where it was");
});

real("a site allowed for the task loads, and is not asked about again", async () => {
  const f = (sites.f as Site).origin;
  const loading = svc.navigate(tab, `${f}/landed`);
  await answer(f, "task");
  await loading;
  assert.equal(await heading(), "F says hello");
  await svc.navigate(tab, `${f}/again`);
  assert.equal(rules.gate.pending(), null, "no second question");
  assert.deepEqual((sites.f as Site).hits, ["/landed", "/again"]);
});

real("a redirect to a site nobody was asked about waits too; blocked, the navigation is a blocked error", async () => {
  const d = (sites.d as Site).origin;
  const loading = svc.navigate(tab, `${a()}/redirect`).then(
    () => null,
    (error: unknown) => error,
  );
  await answer(d, "block");
  const error = await loading;
  assert.ok(error instanceof BrowserError && error.code === "blocked", `a blocked error, got ${String(error)}`);
  assert.deepEqual((sites.d as Site).hits, [], "the redirect target was never asked for");
  assert.equal(rules.gate.rules.get(d)?.decision, "block");
  // A saved block holds without asking again.
  await assert.rejects(svc.navigate(tab, `${d}/other`), (e: unknown) => e instanceof BrowserError && e.code === "blocked");
  assert.equal(rules.gate.pending(), null);
});

real("a frame inside a page is part of the page, unless it leads inside and nobody allowed that site", async () => {
  const [f, c] = [sites.f as Site, sites.c as Site];
  await svc.navigate(tab, `${a()}/frames`);
  assert.equal(await heading(), "A frames");
  await until(() => f.hits.includes("/frame"), "the allowed frame to load");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(c.hits, [], "the frame of an unallowed local site was never fetched");
  assert.equal(rules.gate.pending(), null, "and nobody was asked about it");
});

real("a popup is closed and noted, and a dialog does not freeze the page", async () => {
  await svc.navigate(tab, `${a()}/`);
  svc.takeNotes(tab);
  const button = /\[ref=(e\d+)\]/.exec((await svc.snapshot(tab)).text.split("\n").find((l) => /button "Pop"/.test(l)) ?? "")![1]!;
  await svc.click(tab, { ref: button });
  await until(() => svc.takeNotes(tab).some((n) => /popup/.test(n)) || false, "the popup note", 4000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await svc.listTabs()).filter((t) => t.context === "assistant").length, 1, "never a second tab");
  await svc.navigate(tab, `${a()}/dialog`);
  assert.equal(await heading(), "A dialog", "the page loaded although it showed an alert");
  assert.ok(svc.takeNotes(tab).some((n) => /alert dialog.*hello.*dismissed/.test(n)));
});

real("the person's own tabs are never asked about", async () => {
  const mine = await svc.openTab("you", `${(sites.c as Site).origin}/mine`);
  assert.equal(rules.gate.pending(), null);
  assert.match((await svc.snapshot(mine.id)).text, /C says hello/);
});
