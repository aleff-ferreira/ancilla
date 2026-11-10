import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionAsk } from "../src/browser/commit.js";
import { BrowserService, type CommitRequest, type ElementFacts } from "../src/browser/service.js";
import { BrowseSites, SiteGate, SiteRules, questionView } from "../src/browser/sites.js";
import { ServiceSurface, SurfaceError, type SurfaceGate } from "../src/browser/surface.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";

/**
 * Actions that change something in the world: a form the page sends is held in the browser until the person says so, a click or
 * key on something that looks like a commit is asked about before it is sent, and the assistant never types a password or a card
 * number. Nothing is remembered: every action asks.
 */

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const sent = (fake: FakeBrowser, method: string) => fake.calls.filter((c) => c.method === method);
const FOUND = { browser: { kind: "edge" as const, path: "/fake/edge" } };
const ASK: ActionAsk = { origin: "https://shop.example", page: "Cart", what: "Click “Place order”", fields: [{ name: "item", value: "Blue Widget" }] };

// ------------------------------------------------------------------ the gate

test("gate: an action asks every time, and only a yes lets it through", async () => {
  const changes: number[] = [];
  const gate = new SiteGate(new SiteRules(null), { onChange: () => changes.push(1) });
  const first = gate.ask("t1", ASK);
  const shown = gate.pending();
  assert.equal(shown?.type, "action");
  assert.deepEqual(shown && questionView(shown), { type: "action", origin: "https://shop.example", kind: "public", page: "Cart", what: "Click “Place order”", fields: [{ name: "item", value: "Blue Widget" }] }, "a screen is told what, and no id");
  assert.equal(gate.waiting("t1"), true);
  gate.answer(shown?.id ?? "", "do");
  assert.equal(await first, true);
  // Nothing was kept: the same action asks again, and "dont" is a no.
  const second = gate.ask("t1", ASK);
  assert.equal(gate.pending()?.type, "action", "asked again");
  gate.answer(gate.pending()?.id ?? "", "dont");
  assert.equal(await second, false);
  assert.equal(gate.pending(), null);
  assert.ok(changes.length >= 4);
});

test("gate: an answer for the other kind of question is refused, and a site rule never settles an action", async () => {
  const rules = new SiteRules(null);
  const gate = new SiteGate(rules);
  const action = gate.ask("t1", ASK);
  const id = gate.pending()?.id ?? "";
  assert.throws(() => gate.answer(id, "task"), /about an action: answer do or dont/);
  const site = gate.request("t1", "https://other.example/x");
  gate.answer(id, "do");
  assert.equal(await action, true);
  assert.equal(gate.pending()?.type, "site", "the site question waits behind, one at a time");
  assert.throws(() => gate.answer(gate.pending()?.id ?? "", "do"), /about a site, not an action/);
  rules.set("https://shop.example", "allow");
  assert.equal(gate.pending()?.type, "site");
  gate.answer(gate.pending()?.id ?? "", "not-now");
  assert.equal(await site, false);
  const again = gate.ask("t1", ASK);
  assert.equal(gate.pending()?.type, "action", "an always-allowed site still asks about an action");
  gate.end("t1");
  assert.equal(await again, false);
});

test("gate: an expired, stopped or ended action is a no, and what the task was allowed stays", async () => {
  const gate = new SiteGate(new SiteRules(null));
  const grant = gate.request("t1", "https://a.example/");
  gate.answer(gate.pending()?.id ?? "", "task");
  assert.equal(await grant, true);
  const expiring = gate.ask("t1", ASK);
  gate.expire("t1");
  assert.equal(await expiring, false, "nobody answered in time: Don't");
  assert.equal(gate.check("t1", "https://a.example"), "allow");
  assert.equal(gate.pending(), null);

  const abort = new AbortController();
  const stopped = gate.ask("t1", ASK, abort.signal);
  abort.abort();
  assert.equal(await stopped, false);
  assert.equal(gate.pending(), null);
  assert.equal(await gate.ask("t1", ASK, AbortSignal.abort()), false, "an already stopped task is not asked");
  assert.equal(gate.pending(), null);
});

test("gate: the click that was approved covers the form it sends, once, for a short while, and nothing else", () => {
  let now = 1_000;
  const gate = new SiteGate(new SiteRules(null), { now: () => now });
  assert.equal(gate.takeApproval("t1"), false, "nothing approved yet");
  gate.approved("t1");
  assert.equal(gate.takeApproval("t2"), false, "another task's form is not covered");
  gate.approved("t1");
  assert.equal(gate.takeApproval("t1"), true);
  assert.equal(gate.takeApproval("t1"), false, "once");
  gate.approved("t1");
  now += 21_000;
  assert.equal(gate.takeApproval("t1"), false, "not for long");
  gate.approved("t1");
  gate.endApproval();
  assert.equal(gate.takeApproval("t1"), false, "the next action ends it");
  gate.approved("t1");
  gate.end("t1");
  assert.equal(gate.takeApproval("t1"), false, "and so does the end of the task");
});

test("decideCommit: asks about a form with what it sends; with no task nothing is sent; the form of an approved click is not asked twice", async () => {
  let task: string | null = null;
  const sites = new BrowseSites(null, () => ({ taskId: () => task, gateChanged: () => undefined }));
  const request = { url: "https://shop.example/buy", method: "POST", title: "Cart", contentType: "application/x-www-form-urlencoded", body: "item=Widget&password=hunter2" };
  assert.equal(await sites.decideCommit(request), false, "nobody is browsing");
  task = "t1";
  const decided = sites.decideCommit(request);
  const question = sites.gate.pending();
  assert.equal(question?.type, "action");
  assert.deepEqual(question && questionView(question), { type: "action", origin: "https://shop.example", kind: "public", page: "Cart", what: "Send a form to https://shop.example/buy", fields: [{ name: "item", value: "Widget" }, { name: "password", value: "••••••••" }] });
  sites.gate.answer(question?.id ?? "", "dont");
  assert.equal(await decided, false);
  sites.gate.approved("t1");
  assert.equal(await sites.decideCommit(request), true, "the click they approved was shown this form");
  const next = sites.decideCommit(request);
  assert.equal(sites.gate.pending()?.type, "action", "but only once");
  sites.gate.end("t1");
  assert.equal(await next, false);
});

// ------------------------------------------------------------------ the browser holds a form

function holding(fake: FakeBrowser, commit?: (r: CommitRequest) => Promise<boolean>, site: () => Promise<boolean> = async () => true) {
  return new BrowserService({ dataDir: ":memory:", find: () => FOUND, launch: () => fake.proc, gracefulMs: 200, siteGate: site, ...(commit ? { commitGate: commit } : {}) });
}

const paused = (fake: FakeBrowser, session: string, id: string, frameId: string, request: Record<string, unknown>) =>
  fake.emit("Fetch.requestPaused", { requestId: id, frameId, resourceType: "Document", request }, session);

test("service: a form waits for the person; yes sends it, no aborts it and the assistant is told nothing changed; a GET is untouched", async () => {
  const fake = fakeBrowser(healthy());
  const asked: CommitRequest[] = [];
  const answers: Array<Promise<boolean>> = [];
  const svc = holding(fake, (r) => {
    asked.push(r);
    return answers.shift() ?? Promise.resolve(false);
  });
  const tab = await svc.openTab("assistant");
  const session = `S-${tab.id}`;

  // A GET never asks.
  paused(fake, session, "R0", tab.id, { url: "https://shop.example/search?q=1", method: "GET" });
  await tick();
  assert.equal(asked.length, 0);
  assert.deepEqual(sent(fake, "Fetch.continueRequest").map((c) => c.params), [{ requestId: "R0" }]);

  // A POST waits.
  let answer: (allowed: boolean) => void = () => undefined;
  answers.push(new Promise<boolean>((resolve) => (answer = resolve)));
  paused(fake, session, "R1", tab.id, { url: "https://shop.example/buy", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, postData: "item=Widget" });
  await tick();
  assert.deepEqual(asked[0], { url: "https://shop.example/buy", method: "POST", title: "", contentType: "application/x-www-form-urlencoded", body: "item=Widget", secrets: [] });
  assert.equal(sent(fake, "Fetch.continueRequest").some((c) => c.params["requestId"] === "R1"), false, "nothing is sent while the person decides");
  assert.equal(sent(fake, "Fetch.failRequest").length, 0);
  answer(true);
  await tick();
  assert.ok(sent(fake, "Fetch.continueRequest").some((c) => c.params["requestId"] === "R1"), "yes: it goes");

  // A refusal aborts it (the page that had the form stays) and says so, once.
  answers.push(Promise.resolve(false));
  paused(fake, session, "R2", tab.id, { url: "https://shop.example/buy", method: "POST", postData: "item=Other" });
  await tick();
  assert.deepEqual(sent(fake, "Fetch.failRequest").map((c) => c.params), [{ requestId: "R2", errorReason: "Aborted" }]);
  assert.deepEqual(svc.takeNotes(tab.id), ["A form to https://shop.example was not sent: the person did not allow it. Nothing was changed."]);
  assert.deepEqual(svc.takeNotes(tab.id), []);
  await svc.dispose();
});

test("service: any frame's form asks; a failing gate, or none at all, sends nothing; a site that was refused is never asked about its form", async () => {
  const fake = fakeBrowser(healthy());
  const asked: string[] = [];
  let broken = false;
  let siteOk = true;
  const svc = holding(
    fake,
    (r) => {
      asked.push(r.url);
      return broken ? Promise.reject(new Error("the gate broke")) : Promise.resolve(true);
    },
    async () => siteOk,
  );
  const tab = await svc.openTab("assistant");
  const session = `S-${tab.id}`;
  paused(fake, session, "F1", "child-frame", { url: "https://ads.example/frame", method: "POST", postData: "a=1" });
  await tick();
  assert.deepEqual(asked, ["https://ads.example/frame"], "a form in a frame is a form");
  assert.ok(sent(fake, "Fetch.continueRequest").some((c) => c.params["requestId"] === "F1"));
  broken = true;
  paused(fake, session, "F2", tab.id, { url: "https://shop.example/buy", method: "POST" });
  await tick();
  assert.ok(sent(fake, "Fetch.failRequest").some((c) => c.params["requestId"] === "F2"), "a gate that fails is a no");
  broken = false;
  siteOk = false;
  asked.length = 0;
  paused(fake, session, "F3", tab.id, { url: "https://nope.example/buy", method: "POST" });
  await tick();
  assert.deepEqual(asked, [], "the site was refused first");
  assert.ok(sent(fake, "Fetch.failRequest").some((c) => c.params["requestId"] === "F3"));
  await svc.dispose();

  const bare = fakeBrowser(healthy());
  const nogate = holding(bare);
  const tab2 = await nogate.openTab("assistant");
  paused(bare, `S-${tab2.id}`, "N1", tab2.id, { url: "https://shop.example/buy", method: "POST", postData: "a=1" });
  paused(bare, `S-${tab2.id}`, "N2", tab2.id, { url: "https://shop.example/", method: "GET" });
  await tick();
  assert.deepEqual(sent(bare, "Fetch.failRequest").map((c) => c.params["requestId"]), ["N1"], "with nobody to ask a form is not sent");
  assert.deepEqual(sent(bare, "Fetch.continueRequest").map((c) => c.params["requestId"]), ["N2"]);
  await nogate.dispose();
});

// ------------------------------------------------------------------ the surface

interface Call {
  op: string;
  arg?: unknown;
}

/** The parts of the browser service the surface uses, recording what was done to the page. */
function fakeService(options: { refs?: Record<string, { role: string; name: string }>; facts?: ElementFacts | null; url?: string }) {
  const calls: Call[] = [];
  const service = {
    listTabs: async () => [{ id: "T1", url: options.url ?? "https://shop.example/cart", title: "Cart" }],
    openTab: async () => ({ id: "T1" }),
    refInfo: (_id: string, ref: string) => options.refs?.[ref] ?? null,
    elementFacts: async (_id: string, ref: string | null) => {
      calls.push({ op: "facts", arg: ref });
      return options.facts ?? null;
    },
    click: async (_id: string, target: unknown) => void calls.push({ op: "click", arg: target }),
    type: async (_id: string, target: unknown, text: string, opts: unknown) => void calls.push({ op: "type", arg: { target, text, opts } }),
    press: async (_id: string, key: string) => void calls.push({ op: "press", arg: key }),
    waitLoaded: async () => undefined,
    takeNotes: () => [],
    snapshot: async () => ({ text: "page", refs: 0, truncated: false }),
    resetAssistant: async () => undefined,
  } as unknown as BrowserService;
  return { service, calls };
}

function fakeGate(answers: boolean[]) {
  const asked: ActionAsk[] = [];
  let ended = 0;
  const gate: SurfaceGate = {
    request: async () => true,
    settled: async () => undefined,
    confirm: async (ask) => {
      asked.push(ask);
      return answers.shift() ?? false;
    },
    endApproval: () => void (ended += 1),
  };
  return { gate, asked, ended: () => ended };
}

const form = (over: Partial<NonNullable<ElementFacts["form"]>> = {}): ElementFacts["form"] => ({ action: "https://shop.example/order", method: "post", defaultButton: "Place order", fields: [{ name: "item", type: "text", value: "Blue Widget" }, { name: "password", type: "password", value: "hunter2" }], ...over });
const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({ tag: "button", type: "submit", name: "", autocomplete: "", role: "", label: "Place order", form: form(), ...over });

test("surface: a click on something that looks like a commit asks first, with the form it sends, and a no clicks nothing", async () => {
  const f = fakeService({ refs: { e1: { role: "button", name: "Place order" }, e2: { role: "link", name: "Next" }, e3: { role: "button", name: "Finalizar compra" } }, facts: facts() });
  const g = fakeGate([false, true, true]);
  const surface = new ServiceSurface(f.service, g.gate);
  await assert.rejects(surface.click("e1"), (e: unknown) => e instanceof SurfaceError && /did not allow that.*Nothing was changed/.test(e.message));
  assert.equal(f.calls.some((c) => c.op === "click"), false, "refused: nothing was clicked");
  assert.deepEqual(g.asked[0], { origin: "https://shop.example", page: "Cart", what: "Click “Place order”, which sends a form to https://shop.example/order", fields: [{ name: "item", value: "Blue Widget" }, { name: "password", value: "••••••••" }] });

  await surface.click("e1");
  assert.deepEqual(f.calls.filter((c) => c.op === "click").map((c) => c.arg), [{ ref: "e1" }], "allowed: it is clicked");
  await surface.click("e2");
  assert.equal(g.asked.length, 2, "a plain link asks nothing");
  await surface.click("e3");
  assert.equal(g.asked.length, 3, "and the same in Portuguese");
  assert.equal(g.ended(), 4, "every action ends the approval of the one before");
});

test("surface: the assistant never types a password or a card number, and says why", async () => {
  const f = fakeService({ facts: facts({ tag: "input", type: "password", name: "pw", label: "" }) });
  const surface = new ServiceSurface(f.service, fakeGate([]).gate);
  await assert.rejects(surface.type("e1", "hunter2", false), (e: unknown) => e instanceof SurfaceError && /password or payment/.test(e.message));
  const plain = fakeService({ facts: facts({ tag: "input", type: "text", name: "note", label: "", form: null }) });
  const surface2 = new ServiceSurface(plain.service, fakeGate([]).gate);
  await assert.rejects(surface2.type("e1", "my card 4111 1111 1111 1111", false), (e: unknown) => e instanceof SurfaceError && /card number/.test(e.message));
  await assert.rejects(surface2.type(null, "4111111111111111", true), (e: unknown) => e instanceof SurfaceError && /card number/.test(e.message));
  for (const c of [f.calls, plain.calls]) assert.equal(c.some((x) => x.op === "type" || x.op === "press"), false, "nothing was typed");
  await surface2.type("e1", "Ana Souza", false);
  assert.deepEqual(plain.calls.find((c) => c.op === "type")?.arg, { target: { ref: "e1" }, text: "Ana Souza", opts: { clear: true, submit: false } });
});

test("surface: Enter in a field whose form has a button that commits asks first; text typed stays, a no sends no Enter", async () => {
  const f = fakeService({ facts: facts({ tag: "input", type: "text", label: "", form: form({ defaultButton: "Buy now" }) }) });
  const g = fakeGate([false, true]);
  const surface = new ServiceSurface(f.service, g.gate);
  await assert.rejects(surface.type("e1", "Ana", true), (e: unknown) => e instanceof SurfaceError);
  assert.equal(f.calls.some((c) => c.op === "type"), true, "the text was typed: typing is not the commit");
  assert.equal(f.calls.some((c) => c.op === "press"), false, "but Enter was not pressed");
  assert.equal(g.asked[0]?.what, "Press Enter on “Buy now”, which sends a form to https://shop.example/order");
  await surface.press("Enter");
  assert.deepEqual(f.calls.filter((c) => c.op === "press").map((c) => c.arg), ["Enter"], "allowed: Enter goes");
});

test("surface: Enter or Space on a button that commits asks; other keys, plain fields and a textarea do not", async () => {
  const button = fakeService({ facts: facts({ tag: "button", type: "button", label: "Delete account", form: null }) });
  const g = fakeGate([true]);
  const surface = new ServiceSurface(button.service, g.gate);
  await surface.press(" ");
  assert.equal(g.asked[0]?.what, "Press Space on “Delete account”");
  await surface.press("ArrowDown");
  await surface.press("Tab");
  assert.equal(g.asked.length, 1, "other keys never ask");
  assert.equal(button.calls.filter((c) => c.op === "facts").length, 1, "and do not even look");

  const search = fakeService({ facts: facts({ tag: "input", type: "search", label: "", form: form({ defaultButton: "Search" }) }) });
  const g2 = fakeGate([]);
  await new ServiceSurface(search.service, g2.gate).press("Enter");
  assert.equal(g2.asked.length, 0, "a search form's button is not a commit");
  const area = fakeService({ facts: facts({ tag: "textarea", type: "", label: "", form: form({ defaultButton: "Send" }) }) });
  const g3 = fakeGate([]);
  await new ServiceSurface(area.service, g3.gate).press("Enter");
  assert.equal(g3.asked.length, 0, "Enter in a textarea is a new line");
});
