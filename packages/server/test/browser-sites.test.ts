import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserError, BrowserService, type BrowserEvent } from "../src/browser/service.js";
import { BrowseSites, hostKind, kindOfOrigin, originOf, SiteGate, SiteRules, type SiteQuestion } from "../src/browser/sites.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";

/**
 * Which sites the assistant's browser may open: the origins and what they lead into, the saved rules, the questions and the
 * answers, and the browser holding every page of the assistant's tabs until the gate has spoken.
 */

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const sent = (fake: FakeBrowser, method: string) => fake.calls.filter((c) => c.method === method);
const FOUND = { browser: { kind: "edge" as const, path: "/fake/edge" } };

// ------------------------------------------------------------------ origins

test("originOf: only http and https pages have an origin, with the port when it is not the default", () => {
  assert.equal(originOf("https://Example.com/a/b?q=1#x"), "https://example.com");
  assert.equal(originOf("http://localhost:5173/app"), "http://localhost:5173");
  assert.equal(originOf("https://example.com:443/"), "https://example.com");
  for (const refused of ["file:///C:/secret.txt", "chrome://settings", "edge://flags", "javascript:alert(1)", "data:text/html,hi", "view-source:https://a.example/", "about:blank", "not a url", ""]) {
    assert.equal(originOf(refused), null, refused);
  }
  assert.equal(originOf("http://2130706433/"), "http://127.0.0.1", "a number for an address is read as the address it is");
});

test("hostKind: what leads into this computer or its network is local, the rest is public", () => {
  for (const local of ["localhost", "app.localhost", "127.0.0.1", "127.8.8.8", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.1.1", "100.64.0.9", "0.0.0.0", "::1", "[::1]", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "printer.local", "nas.lan", "router", "nas"]) {
    assert.equal(hostKind(local), "local", local);
  }
  for (const pub of ["example.com", "en.wikipedia.org", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(hostKind(pub), "public", pub);
  }
  assert.equal(kindOfOrigin("http://192.168.0.10:8080"), "local");
  assert.equal(kindOfOrigin("https://example.com"), "public");
});

// ------------------------------------------------------------------ rules

test("rules: saved to a file, read back, removed; a missing, broken or hand-edited file means only what is valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "ancilla-sites-"));
  try {
    const file = join(dir, "browser", "sites.json");
    const rules = new SiteRules(file, () => 1000);
    assert.deepEqual(rules.list(), []);
    rules.set("https://b.example", "block");
    rules.set("https://a.example", "allow");
    rules.set("not an origin", "allow");
    rules.set("https://a.example/path", "allow");
    assert.deepEqual(rules.list().map((r) => [r.origin, r.decision]), [["https://a.example", "allow"], ["https://b.example", "block"]]);
    const again = new SiteRules(file);
    assert.equal(again.get("https://a.example")?.decision, "allow");
    assert.equal(again.get("https://b.example")?.decision, "block");
    assert.equal(again.remove("https://a.example"), true);
    assert.equal(again.remove("https://a.example"), false);
    assert.equal(new SiteRules(file).get("https://a.example"), null);
    writeFileSync(file, JSON.stringify({ rules: [{ origin: "https://ok.example", decision: "allow" }, { origin: "file:///x", decision: "allow" }, { origin: "https://bad.example", decision: "maybe" }, 7, null] }));
    assert.deepEqual(new SiteRules(file).list().map((r) => r.origin), ["https://ok.example"]);
    writeFileSync(file, "{ not json");
    assert.deepEqual(new SiteRules(file).list(), []);
    assert.match(readFileSync(join(dir, "browser", "sites.json"), "utf8"), /not json/, "a file that cannot be read is left alone until a rule is saved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the gate

function gate(options: { onChange?: () => void } = {}) {
  const rules = new SiteRules(null, () => 5);
  return { rules, gate: new SiteGate(rules, { ...options, now: () => 7 }) };
}

test("gate: an unknown site asks, a rule or an answer for the task decides after, and a block beats everything", async () => {
  const { rules, gate: g } = gate();
  assert.equal(g.check("t1", "https://a.example"), "ask");
  const pending = g.request("t1", "https://a.example/page");
  const question = g.pending() as SiteQuestion;
  assert.deepEqual([question.taskId, question.origin, question.kind, question.at], ["t1", "https://a.example", "public", 7]);
  assert.equal(g.waiting("t1"), true);
  assert.equal(g.waiting("t2"), false);
  g.answer(question.id, "task");
  assert.equal(await pending, true);
  assert.equal(g.check("t1", "https://a.example"), "allow");
  assert.equal(g.check("t2", "https://a.example"), "ask", "what was allowed for one task is not allowed for another");
  assert.equal(await g.request("t1", "https://a.example/other"), true, "asked once, not again");
  rules.set("https://a.example", "block");
  assert.equal(g.check("t1", "https://a.example"), "block", "a saved block beats an answer for the task");
  assert.equal(await g.request("t1", "https://a.example"), false);
  assert.equal(await g.request("t1", "file:///etc/passwd"), false, "a page that is not on the web is never opened");
});

test("gate: always and block are saved; not now is remembered for the task only", async () => {
  const { rules, gate: g } = gate();
  const always = g.request("t1", "https://always.example");
  g.answer((g.pending() as SiteQuestion).id, "always");
  assert.equal(await always, true);
  assert.equal(rules.get("https://always.example")?.decision, "allow");
  assert.equal(g.check("t9", "https://always.example"), "allow", "a saved rule holds for every task");

  const blocked = g.request("t1", "https://blocked.example");
  g.answer((g.pending() as SiteQuestion).id, "block");
  assert.equal(await blocked, false);
  assert.equal(rules.get("https://blocked.example")?.decision, "block");
  assert.equal(await g.request("t9", "https://blocked.example"), false);

  const notNow = g.request("t1", "https://later.example");
  g.answer((g.pending() as SiteQuestion).id, "not-now");
  assert.equal(await notNow, false);
  assert.equal(rules.get("https://later.example"), null, "nothing saved");
  assert.equal(await g.request("t1", "https://later.example"), false, "and not asked again by this task");
  assert.equal(g.check("t2", "https://later.example"), "ask", "but another task asks");
});

test("gate: one question at a time, the others wait behind it and are settled by its answer when they can be", async () => {
  const changes: string[] = [];
  const { gate: g } = gate({ onChange: () => changes.push("changed") });
  const first = g.request("t1", "https://a.example/1");
  const same = g.request("t1", "https://a.example/2");
  const other = g.request("t1", "https://b.example/");
  const third = g.request("t1", "https://c.example/");
  assert.equal((g.pending() as SiteQuestion).origin, "https://a.example", "the first is the one shown");
  assert.throws(() => g.answer("sq_nope", "task"), /not waiting any more/);
  g.answer((g.pending() as SiteQuestion).id, "always");
  assert.deepEqual(await Promise.all([first, same]), [true, true], "two pages of one site are one question");
  assert.equal((g.pending() as SiteQuestion).origin, "https://b.example");
  g.answer((g.pending() as SiteQuestion).id, "block");
  assert.equal(await other, false);
  assert.equal((g.pending() as SiteQuestion).origin, "https://c.example");
  g.answer((g.pending() as SiteQuestion).id, "task");
  assert.equal(await third, true);
  assert.equal(g.pending(), null);
  assert.ok(changes.length >= 6, "every change is announced so a screen can follow");
});

test("gate: the end of a task refuses its questions and forgets what it was allowed; an expired question is refused once", async () => {
  const { gate: g } = gate();
  const granted = g.request("t1", "https://a.example");
  g.answer((g.pending() as SiteQuestion).id, "task");
  await granted;
  const open = g.request("t1", "https://b.example");
  const settled = g.settled("t1");
  let done = false;
  void settled.then(() => (done = true));
  await tick(5);
  assert.equal(done, false, "settled waits while a question is open");
  g.end("t1");
  assert.equal(await open, false);
  await settled;
  assert.equal(g.check("t1", "https://a.example"), "ask", "its grants are forgotten");

  const slow = g.request("t2", "https://c.example");
  g.expire("t2");
  assert.equal(await slow, false);
  assert.equal(g.check("t2", "https://c.example"), "block", "refused for the task, not saved");
  assert.equal(g.pending(), null);

  const controller = new AbortController();
  const aborted = g.request("t3", "https://d.example", controller.signal);
  assert.equal(g.waiting("t3"), true);
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(g.waiting("t3"), false, "a request that was given up on leaves no question behind");
});

test("gate: a site on this computer or its network is said to be, and is never allowed by anything but its own exact answer", async () => {
  const { gate: g } = gate();
  const request = g.request("t1", "http://localhost:5173/");
  assert.equal((g.pending() as SiteQuestion).kind, "local");
  g.answer((g.pending() as SiteQuestion).id, "task");
  await request;
  assert.equal(g.check("t1", "http://localhost:5173"), "allow");
  assert.equal(g.check("t1", "http://localhost:3000"), "ask", "another port is another site");
  assert.equal(g.check("t1", "http://127.0.0.1:5173"), "ask", "and so is another name for it");
});

// ------------------------------------------------------------------ what decides for the browser

test("decide: a page waits for the task's question; with no task nothing loads; a frame loads unless it leads inside or is blocked", async () => {
  let task: string | null = null;
  const sites = new BrowseSites(null, () => ({ taskId: () => task, gateChanged: () => undefined }));
  const req = (url: string, mainFrame: boolean) => ({ url, origin: originOf(url) as string, tabId: "T1", mainFrame });
  assert.equal(await sites.decide(req("https://a.example/", true)), false, "no task is browsing: nothing is opened");
  assert.equal(await sites.decide(req("https://a.example/ad", false)), true, "a frame of a public site is only a part of a page");
  assert.equal(await sites.decide(req("http://192.168.1.1/", false)), false, "a frame that leads inside is not");
  task = "t1";
  const asked = sites.decide(req("https://a.example/", true));
  assert.equal(sites.gate.pending()?.origin, "https://a.example");
  sites.gate.answer((sites.gate.pending() as SiteQuestion).id, "task");
  assert.equal(await asked, true);
  sites.gate.rules.set("https://tracker.example", "block");
  assert.equal(await sites.decide(req("https://tracker.example/x.html", false)), false, "a blocked site is not let in as a frame either");
  sites.gate.rules.set("http://192.168.1.1", "allow");
  assert.equal(await sites.decide(req("http://192.168.1.1/", false)), true, "unless the person said so for that exact site");
});

// ------------------------------------------------------------------ the browser holds the page

function gated(fake: FakeBrowser, decide: (r: { url: string; origin: string; tabId: string; mainFrame: boolean }) => Promise<boolean>) {
  return new BrowserService({ dataDir: ":memory:", find: () => FOUND, launch: () => fake.proc, gracefulMs: 200, siteGate: decide });
}

test("service: only the assistant's tabs are held, and only for pages (Fetch on documents)", async () => {
  const fake = fakeBrowser(healthy());
  const svc = gated(fake, async () => true);
  const mine = await svc.openTab("you");
  const theirs = await svc.openTab("assistant");
  const fetches = sent(fake, "Fetch.enable");
  assert.equal(fetches.length, 1, "one tab is held");
  assert.equal(fetches[0]?.sessionId, `S-${theirs.id}`);
  assert.deepEqual(fetches[0]?.params, { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  assert.notEqual(fetches[0]?.sessionId, `S-${mine.id}`);
  await svc.dispose();
  const plain = fakeBrowser(healthy());
  const open = new BrowserService({ dataDir: ":memory:", find: () => FOUND, launch: () => plain.proc, gracefulMs: 200 });
  await open.openTab("assistant");
  assert.equal(sent(plain, "Fetch.enable").length, 0, "with no gate there is nothing to ask");
  await open.dispose();
});

test("service: a page that is allowed goes on; one that is refused fails as blocked and the assistant is told, once", async () => {
  const fake = fakeBrowser(healthy());
  const answers: Array<Promise<boolean>> = [];
  const seen: Array<{ url: string; origin: string; mainFrame: boolean }> = [];
  let broken = false;
  const svc = gated(fake, (r) => {
    seen.push({ url: r.url, origin: r.origin, mainFrame: r.mainFrame });
    if (broken) return Promise.reject(new Error("the gate broke"));
    return answers.shift() ?? Promise.resolve(false);
  });
  const tab = await svc.openTab("assistant");
  const session = `S-${tab.id}`;
  answers.push(Promise.resolve(true));
  fake.emit("Fetch.requestPaused", { requestId: "R1", frameId: tab.id, resourceType: "Document", request: { url: "https://ok.example/page" } }, session);
  await tick();
  assert.deepEqual(sent(fake, "Fetch.continueRequest").map((c) => c.params), [{ requestId: "R1" }]);
  assert.deepEqual(seen[0], { url: "https://ok.example/page", origin: "https://ok.example", mainFrame: true });

  answers.push(Promise.resolve(false));
  fake.emit("Fetch.requestPaused", { requestId: "R2", frameId: tab.id, resourceType: "Document", request: { url: "https://no.example/" } }, session);
  await tick();
  assert.deepEqual(sent(fake, "Fetch.failRequest").map((c) => c.params), [{ requestId: "R2", errorReason: "Aborted" }], "aborted, so the page that had the link stays");
  assert.deepEqual(svc.takeNotes(tab.id), ["https://no.example was not opened: the person did not allow it."]);
  assert.deepEqual(svc.takeNotes(tab.id), [], "said once");

  // A frame inside the page is told apart from the page.
  answers.push(Promise.resolve(true));
  fake.emit("Fetch.requestPaused", { requestId: "R3", frameId: "some-child-frame", resourceType: "Document", request: { url: "https://ads.example/frame" } }, session);
  await tick();
  assert.equal(seen[2]?.mainFrame, false);
  // A gate that fails is a refusal, never a pass.
  broken = true;
  fake.emit("Fetch.requestPaused", { requestId: "R4", frameId: tab.id, resourceType: "Document", request: { url: "https://broken.example/" } }, session);
  await tick();
  assert.ok(sent(fake, "Fetch.failRequest").some((c) => c.params["requestId"] === "R4"));
  await svc.dispose();
});

test("service: a page waits while the person decides, and nothing is sent for it until they have", async () => {
  const fake = fakeBrowser(healthy());
  let answer: (allowed: boolean) => void = () => undefined;
  const svc = gated(fake, () => new Promise<boolean>((resolve) => (answer = resolve)));
  const tab = await svc.openTab("assistant");
  fake.emit("Fetch.requestPaused", { requestId: "R1", frameId: tab.id, resourceType: "Document", request: { url: "https://slow.example/" } }, `S-${tab.id}`);
  await tick(60);
  assert.equal(sent(fake, "Fetch.continueRequest").length + sent(fake, "Fetch.failRequest").length, 0, "held");
  answer(true);
  await tick();
  assert.equal(sent(fake, "Fetch.continueRequest").length, 1);
  await svc.dispose();
});

test("service: a navigation the browser refused as blocked is a blocked error, not a broken page", async () => {
  const fake = fakeBrowser(healthy((method) => (method === "Page.navigate" ? { errorText: "net::ERR_BLOCKED_BY_CLIENT" } : undefined)));
  const svc = gated(fake, async () => false);
  const tab = await svc.openTab("assistant");
  await assert.rejects(svc.navigate(tab.id, "https://no.example/"), (e: unknown) => e instanceof BrowserError && e.code === "blocked");
  const other = fakeBrowser(healthy((method) => (method === "Page.navigate" ? { errorText: "net::ERR_NAME_NOT_RESOLVED" } : undefined)));
  const svc2 = gated(other, async () => true);
  const tab2 = await svc2.openTab("assistant");
  await assert.rejects(svc2.navigate(tab2.id, "https://nowhere.invalid/"), (e: unknown) => e instanceof BrowserError && e.code === "invalid" && /ERR_NAME_NOT_RESOLVED/.test(e.message));
  await svc.dispose();
  await svc2.dispose();
});

test("service: a popup of the assistant's tab is closed and noted; a dialog is dismissed by the browser, not left to freeze the page", async () => {
  const fake = fakeBrowser(healthy());
  const svc = gated(fake, async () => true);
  const events: BrowserEvent[] = [];
  svc.on((e) => events.push(e));
  const tab = await svc.openTab("assistant");
  fake.emit("Target.targetCreated", { targetInfo: { targetId: "P1", type: "page", openerId: tab.id, url: "https://pop.example/", title: "" } });
  await tick();
  assert.ok(sent(fake, "Target.closeTarget").some((c) => c.params["targetId"] === "P1"));
  assert.equal((await svc.listTabs()).some((t) => t.id === "P1"), false, "never a tab");
  assert.ok(events.some((e) => e.type === "notice" && e.kind === "popup"));
  fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "Hello", url: "https://a.example/" }, `S-${tab.id}`);
  fake.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?", url: "https://a.example/" }, `S-${tab.id}`);
  await tick();
  assert.deepEqual(sent(fake, "Page.handleJavaScriptDialog").map((c) => c.params["accept"]), [true, false], "an alert is accepted, a question is declined");
  const notes = svc.takeNotes(tab.id);
  assert.equal(notes.length, 3);
  assert.match(notes[0] as string, /popup window/);
  assert.match(notes[2] as string, /confirm dialog.*Delete everything\?.*dismissed/);
  assert.equal(events.some((e) => e.type === "dialog"), false, "no pane is told: nobody is there to answer it");
  await svc.dispose();
});
