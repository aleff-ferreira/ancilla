import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findBrowser } from "../src/browser/find.js";
import { BrowserError, BrowserService } from "../src/browser/service.js";
import { BrowseSites, questionView, type ActionQuestion } from "../src/browser/sites.js";
import { ServiceSurface, SurfaceError, type SurfaceGate } from "../src/browser/surface.js";

/**
 * Actions that change something, against a real browser and a local shop: a form the page sends is held until the person says so
 * (and a no leaves the page and the shop untouched), a GET goes by without a question, a click on "Place order" asks first with
 * the form it sends and its answer covers that form once, the assistant cannot type into a password field, and a page that sends
 * its request with JavaScript instead of a form is NOT caught (said here so it is not forgotten). Skipped, with the reason, where
 * there is no browser.
 */

const found = findBrowser();
const SKIP: string | false = found.browser ? false : `no browser to drive: ${found.reason}`;
const TASK = "t_web";

let shop: Server;
let origin = "";
const posts: string[] = [];
const searches: string[] = [];
const ajax: string[] = [];
let dataDir = "";
let svc: BrowserService;
let sites: BrowseSites;
let sandboxSkip: string | null = null;

const HOME = `<!doctype html><title>Shop</title><h1>Shop</h1>
<form action="/search"><input name="q" aria-label="Search"><button type="submit">Find</button></form>
<form id="order" method="post" action="/order"><input name="item" aria-label="Item" value="Blue Widget"><input type="password" name="zz" aria-label="Password" value="secret"><input name="note" aria-label="Note"><button type="submit">Place order</button></form>
<button onclick="fetch('/ajax',{method:'POST',body:'sneaky=1'})">Go</button> <a href="/next">Next</a>`;

before(async () => {
  if (SKIP) return;
  dataDir = mkdtempSync(join(tmpdir(), "ancilla-actions-real-"));
  shop = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (path === "/order" && req.method === "POST") posts.push(body);
      if (path === "/search") searches.push(req.url ?? "");
      if (path === "/ajax" && req.method === "POST") ajax.push(body);
      const page = path === "/order" ? "<!doctype html><title>Ordered</title><h1>Ordered</h1>" : path === "/search" ? "<!doctype html><title>Found</title><h1>Found</h1>" : path === "/ajax" ? "ok" : HOME;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    });
  });
  await new Promise<void>((resolve) =>
    shop.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(shop.address() as { port: number }).port}`;
      resolve();
    }),
  );
  sites = new BrowseSites(null, () => ({ taskId: () => TASK, gateChanged: () => undefined }));
  sites.gate.rules.set(origin, "allow");
  svc = new BrowserService({ dataDir, siteGate: (request) => sites.decide(request), commitGate: (request) => sites.decideCommit(request) });
});

after(async () => {
  if (SKIP) return;
  await svc.dispose();
  await new Promise<void>((resolve) => shop.close(() => resolve()));
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

const real = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: SKIP, timeout: 120_000 }, async (t) => {
    if (sandboxSkip) return void t.skip(sandboxSkip);
    try {
      await fn();
    } finally {
      // A test that failed must not leave a question that holds the next one.
      sites.gate.end(TASK);
    }
  });

/** The question the person is looking at, once there is one of the kind asked for. */
async function asked(): Promise<ActionQuestion> {
  await until(() => sites.gate.pending()?.type === "action", "an action question");
  return sites.gate.pending() as ActionQuestion;
}

function surfaceGate(): { gate: SurfaceGate; confirmed: ActionQuestion[] } {
  const confirmed: ActionQuestion[] = [];
  const gate: SurfaceGate = {
    request: (url) => sites.gate.request(TASK, url),
    settled: () => sites.gate.settled(TASK),
    confirm: async (ask) => {
      const outcome = sites.gate.ask(TASK, ask);
      confirmed.push(await asked());
      const result = await outcome;
      if (result) sites.gate.approved(TASK);
      return result;
    },
    endApproval: () => sites.gate.endApproval(),
  };
  return { gate, confirmed };
}

const refOf = (text: string, role: string, name: string): string => {
  const match = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(text);
  assert.ok(match, `no ${role} "${name}" in the page:\n${text}`);
  return match[1] as string;
};

real("a form is held until the person says so: a no leaves the page and the shop as they were, a yes sends it, a GET never asks", async () => {
  let tab: string;
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
  await svc.navigate(tab, `${origin}/`);
  const page = (await svc.snapshot(tab)).text;
  const order = refOf(page, "button", "Place order");

  // A GET form goes by with no question.
  await svc.type(tab, { ref: refOf(page, "textbox", "Search") }, "widgets", { clear: true, submit: true });
  await until(() => searches.length === 1, "the search to reach the shop");
  assert.equal(sites.gate.pending(), null, "a GET asks nothing");
  await svc.waitLoaded(tab, 5000);
  await svc.navigate(tab, `${origin}/`);
  const again = (await svc.snapshot(tab)).text;
  assert.equal(refOf(again, "button", "Place order").length > 0, true);

  // A POST waits, and says what it sends. The password is not shown.
  const clicking = svc.click(tab, { ref: refOf(again, "button", "Place order") });
  const question = await asked();
  assert.deepEqual(questionView(question), {
    type: "action",
    origin,
    kind: "local",
    page: "Shop",
    what: `Send a form to ${origin}/order`,
    fields: [
      { name: "item", value: "Blue Widget" },
      { name: "zz", value: "••••••••" },
      { name: "note", value: "" },
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(posts.length, 0, "nothing reached the shop while the person decides");
  sites.gate.answer(question.id, "dont");
  await clicking;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(posts.length, 0, "a no: the shop saw nothing");
  const tabs = await svc.listTabs();
  assert.equal(tabs.find((t) => t.id === tab)?.url, `${origin}/`, "and the page that had the form is still there");
  assert.deepEqual(svc.takeNotes(tab), [`A form to ${origin} was not sent: the person did not allow it. Nothing was changed.`]);

  // A yes sends it, as the page built it.
  const sending = svc.click(tab, { ref: refOf((await svc.snapshot(tab)).text, "button", "Place order") });
  sites.gate.answer((await asked()).id, "do");
  await sending;
  await until(() => posts.length === 1, "the order to reach the shop");
  assert.equal(posts[0], "item=Blue+Widget&zz=secret&note=");
  await svc.waitLoaded(tab, 5000);
  assert.match((await svc.snapshot(tab)).text, /heading "Ordered"/);
});

real("a click on 'Place order' asks first with the form, its answer covers that form once, and a no clicks nothing", async () => {
  posts.length = 0;
  const { gate, confirmed } = surfaceGate();
  const surface = new ServiceSurface(svc, gate);
  try {
    const home = await surface.open(`${origin}/`);
    const order = refOf(home.text, "button", "Place order");

    // No: the assistant is told, and the shop saw nothing.
    const refused = surface.click(order);
    const first = await asked();
    assert.equal(first.what, `Click “Place order”, which sends a form to ${origin}/order`);
    assert.deepEqual(first.fields.map((f) => f.name), ["item", "zz", "note"], "the fields of the form the button is in");
    assert.equal(first.fields.find((f) => f.name === "zz")?.value, "••••••••");
    sites.gate.answer(first.id, "dont");
    await assert.rejects(refused, (e: unknown) => e instanceof SurfaceError && /did not allow that.*Nothing was changed/.test(e.message));
    assert.equal(posts.length, 0);

    // Yes: the click goes, and the form it sends is not asked about a second time.
    const sending = surface.click(order);
    sites.gate.answer((await asked()).id, "do");
    await sending;
    await until(() => posts.length === 1, "the order to reach the shop");
    assert.equal(posts.length, 1, "sent once");
    assert.match((await surface.read()).text, /heading "Ordered"/);
    assert.equal(confirmed.length, 2, "two questions in all: one for each click, none for the form of the one they allowed");
    assert.equal(sites.gate.pending(), null);

    // The next one asks again: nothing was remembered.
    const home2 = await surface.open(`${origin}/`);
    const again = surface.click(refOf(home2.text, "button", "Place order"));
    sites.gate.answer((await asked()).id, "dont");
    await assert.rejects(again, SurfaceError);
    assert.equal(posts.length, 1);
  } finally {
    await surface.close();
  }
});

real("the assistant cannot type into a password field or type a card number; a page that sends with JavaScript is not caught", async () => {
  const { gate, confirmed } = surfaceGate();
  const surface = new ServiceSurface(svc, gate);
  try {
    const home = await surface.open(`${origin}/`);
    await assert.rejects(surface.type(refOf(home.text, "textbox", "Password"), "hunter2", false), (e: unknown) => e instanceof SurfaceError && /password or payment/.test(e.message));
    await assert.rejects(surface.type(refOf(home.text, "textbox", "Note"), "4111 1111 1111 1111", false), (e: unknown) => e instanceof SurfaceError && /card number/.test(e.message));
    const typed = await surface.type(refOf(home.text, "textbox", "Note"), "for Ana", false);
    assert.match(typed.text, /value="for Ana"/, "ordinary text is typed");
    const page = (await surface.read()).text;
    assert.doesNotMatch(page, /hunter2|4111/);

    // The limit, kept honest: a button whose name does not look like a commit that sends its request with fetch goes through.
    await surface.click(refOf(page, "button", "Go"));
    await until(() => ajax.length === 1, "the fetch to reach the shop");
    assert.deepEqual(ajax, ["sneaky=1"]);
    assert.equal(confirmed.length, 0, "no question was asked: this is what the confirmation does not cover");
  } finally {
    await surface.close();
  }
});
