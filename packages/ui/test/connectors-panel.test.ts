import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ActivityList, ConnectorCardView, ProposalList, type CardHandlers, type CardState } from "../src/components/assistant/ConnectorsPanel.js";
import { activityLine, reachNote, statusOf, tokenLooksUsable } from "../src/components/assistant/connectors.js";
import { TaskRow } from "../src/components/assistant/TasksPanel.js";
import { WriteCardView } from "../src/components/assistant/WriteCard.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import type { AssistantConnectorActivity, AssistantConnectorView, AssistantTaskView, AssistantWriteCard } from "../src/types.js";

/**
 * The Connectors page: what a connected account is called, what is asked of the person to connect one, what they are told it
 * can and cannot do, which kinds of change they switched on, what the card for a change shows, and what the list of what it did
 * says. A connected account starts read only, and the page never says more than is true.
 */

const TEST = {
  at: 1,
  ok: true,
  message: "Works. 2 read tools are offered, and 9 more that it has are not offered because they can change things or are not on Ancilla's list.",
  offered: [
    { name: "get_me", text: "Who the token belongs to.", class: "read" as const },
    { name: "search_issues", text: "Find issues.", class: "read" as const },
  ],
  hidden: 9,
  missing: [],
};

const OFF = { reversible: "off", communicates: "off", destructive: "off" } as const;
const WRITE_TOOLS = [
  { name: "create_branch", class: "reversible" as const, text: "Create a branch in a repository." },
  { name: "add_issue_comment", class: "communicates" as const, text: "Comment on an issue or a pull request." },
  { name: "merge_pull_request", class: "destructive" as const, text: "Merge a pull request." },
];

const CARD: AssistantWriteCard = {
  id: "wq_1",
  taskId: "t_1",
  connector: "github",
  connectorName: "GitHub",
  tool: "add_issue_comment",
  class: "communicates",
  what: "Comment on an issue or a pull request.",
  target: "aleff-ferreira/ancilla #12",
  fields: [
    { name: "owner", value: "aleff-ferreira" },
    { name: "body", value: "Fixed in 0.27.\nSee https://evil.example" },
    { name: "title", value: "" },
  ],
  flags: [{ code: "link", text: "The text has a link or an address that you did not write: https://evil.example." }],
  hash: "0123456789abcdef0123456789abcdef",
  at: 1,
  expiresAt: 600_001,
  offerAlways: false,
  proposal: false,
};

const view = (over: Partial<AssistantConnectorView> = {}): AssistantConnectorView => ({
  id: "github",
  name: "GitHub",
  summary: "Your repositories, issues and pull requests.",
  connected: false,
  mode: "off",
  connectedAt: null,
  token: { label: "Fine-grained personal access token", helpUrl: "https://github.com/settings/personal-access-tokens/new", recipe: "Choose the repositories it may see and set everything to Read-only." },
  revoke: { url: "https://github.com/settings/personal-access-tokens", text: "Open Settings, Developer settings, Personal access tokens, and delete the token." },
  caution: null,
  policy: { ...OFF },
  writeTools: [],
  test: null,
  ...over,
});

const state = (over: Partial<CardState> = {}): CardState => ({ token: "", goal: "", busy: null, error: null, note: null, ...over });
const on: CardHandlers = { token: () => undefined, goal: () => undefined, connect: () => undefined, test: () => undefined, mode: () => undefined, policy: () => undefined, disconnect: () => undefined, ask: () => undefined };
const card = (v: AssistantConnectorView, s: CardState = state()) => renderToStaticMarkup(createElement(ConnectorCardView, { view: v, state: s, on }));
const connected = (over: Partial<AssistantConnectorView> = {}) => view({ connected: true, mode: "read", connectedAt: 5, test: TEST, ...over });

describe("what the page says about an account", () => {
  it("names the state of an account in a word, and whether to worry", () => {
    assert.deepEqual(statusOf(view()), { label: "Not connected", tone: "plain" });
    assert.deepEqual(statusOf(connected()), { label: "Connected, read only", tone: "ok" });
    assert.deepEqual(statusOf(connected({ policy: { ...OFF, communicates: "ask" } })), { label: "Connected, asks before it changes things", tone: "ok" }, "once a kind of change is on, it no longer says read only");
    assert.deepEqual(statusOf(connected({ mode: "off" })), { label: "Connected, switched off", tone: "warn" });
    assert.deepEqual(statusOf(connected({ test: { ...TEST, ok: false } })), { label: "Connected, last check failed", tone: "danger" });
  });

  it("takes a token only when it could be one", () => {
    assert.equal(tokenLooksUsable("made-up-token-0123456789_abcdefg"), true);
    assert.equal(tokenLooksUsable("  padded-token-12345  "), true);
    for (const bad of ["", "short", "two words here 12345", "line\nbreak 12345678", "x".repeat(2100)]) assert.equal(tokenLooksUsable(bad), false, bad.slice(0, 12));
  });

  it("says what the assistant is given and what it is not, in the singular and the plural", () => {
    assert.equal(reachNote(connected()), "The assistant is given 2 read-only tools. 9 more that the server has are not offered, because they can change things or are not on Ancilla's list.");
    assert.equal(reachNote(connected({ test: { ...TEST, offered: [{ name: "get_me", text: "x", class: "read" }], hidden: 1, missing: ["old_tool"] } })), "The assistant is given 1 read-only tool. 1 more that the server has is not offered, because it can change things or is not on Ancilla's list. 1 on Ancilla's list was not found on the server, so it is not offered either.");
    assert.equal(reachNote(connected({ test: { ...TEST, hidden: 0, offered: [...TEST.offered, { name: "add_issue_comment", text: "x", class: "communicates" }] } })), "The assistant is given 2 read tools and 1 that asks you before it changes something.");
    assert.equal(reachNote(connected({ test: { ...TEST, hidden: 0, offered: [{ name: "get_me", text: "x", class: "read" }, { name: "a", text: "x", class: "reversible" }, { name: "b", text: "x", class: "destructive" }] } })), "The assistant is given 1 read tool and 2 that ask you before they change something.");
    assert.equal(reachNote(view()), null);
    assert.equal(reachNote(connected({ test: { ...TEST, ok: false } })), null);
  });

  it("writes each line of the activity in words, a refusal as what it was", () => {
    const name = (id: string) => (id === "github" ? "GitHub" : id);
    const line = (entry: Partial<AssistantConnectorActivity>) => activityLine({ at: 1, kind: "call", connector: "github", ok: true, ...entry }, name);
    assert.equal(line({ tool: "search_issues" }), "GitHub: read with search_issues");
    assert.equal(line({ tool: "merge_pull_request", ok: false, note: "refused: not on the list" }), "GitHub: merge_pull_request was refused, because it is not on the list of tools it may use");
    assert.equal(line({ tool: "get_me", ok: false, note: "The server did not answer in time." }), "GitHub: get_me did not work");
    assert.equal(line({ kind: "connect" }), "GitHub: connected");
    assert.equal(line({ kind: "connect", ok: false }), "GitHub: connecting did not work");
    assert.equal(line({ kind: "test" }), "GitHub: checked, and it works");
    assert.equal(line({ kind: "test", ok: false }), "GitHub: the check did not work");
    assert.equal(line({ kind: "mode", note: "mode off" }), "GitHub: switched off");
    assert.equal(line({ kind: "mode", note: "mode read" }), "GitHub: switched on");
    assert.equal(line({ kind: "disconnect" }), "GitHub: disconnected");
  });

  it("writes each step of a change in words, with a short fingerprint of its arguments, and a refusal as what it was", () => {
    const name = (id: string) => (id === "github" ? "GitHub" : id);
    const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const line = (entry: Partial<AssistantConnectorActivity>) => activityLine({ at: 1, kind: "write", connector: "github", tool: "add_issue_comment", hash, ok: true, ...entry }, name);
    assert.equal(line({ phase: "held" }), "GitHub: add_issue_comment waits for your answer (fingerprint 01234567)");
    assert.equal(line({ phase: "approved" }), "GitHub: you approved add_issue_comment (fingerprint 01234567)");
    assert.equal(line({ phase: "approved", note: "standing rule: reversible changes are allowed here" }), "GitHub: you approved add_issue_comment under your standing rule (fingerprint 01234567)");
    assert.equal(line({ phase: "executed" }), "GitHub: add_issue_comment was done (fingerprint 01234567)");
    assert.equal(line({ phase: "executed", ok: false }), "GitHub: add_issue_comment was approved but did not work (fingerprint 01234567)");
    assert.equal(line({ phase: "refused", ok: false, note: "the person said no" }), "GitHub: add_issue_comment was not done: the person said no (fingerprint 01234567)");
    assert.equal(line({ phase: "refused", ok: false, note: "the arguments are not the ones that were approved" }), "GitHub: add_issue_comment was not done: the arguments are not the ones that were approved (fingerprint 01234567)");
    assert.equal(line({ phase: "expired", ok: false }), "GitHub: add_issue_comment was not done, because nobody answered in time (fingerprint 01234567)");
    assert.equal(line({ phase: "proposed" }), "GitHub: add_issue_comment was kept for you to decide, because the task was not started by you (fingerprint 01234567)");
    assert.equal(line({ kind: "call", ok: false, note: "refused: switched off" }), "GitHub: add_issue_comment was refused, because that kind of change is switched off");
    assert.equal(line({ kind: "policy", note: "communicates ask, reversible always" }), "GitHub: changes other people see: asks you first; small changes you can undo: allowed without asking");
    assert.equal(line({ kind: "policy", note: "destructive off" }), "GitHub: changes that cannot be taken back: switched off");
  });
});

describe("the changes a connected account may ask for", () => {
  it("lists only the kinds that have a tool, each with its setting, and offers Always only where it is already set", () => {
    const html = card(connected({ writeTools: WRITE_TOOLS, policy: { reversible: "always", communicates: "ask", destructive: "off" } }));
    assert.match(html, /Changes it may ask for/);
    for (const kind of ["Small changes you can undo", "Changes other people see", "Changes that cannot be taken back"]) assert.match(html, new RegExp(kind));
    assert.match(html, /aria-label="GitHub: Changes other people see"[^>]*>(?:(?!<\/select>).)*<option value="ask" selected="">Ask me each time/s);
    assert.match(html, /aria-label="GitHub: Small changes you can undo"[^>]*>(?:(?!<\/select>).)*<option value="always" selected="">Always/s);
    assert.doesNotMatch(card(connected({ writeTools: WRITE_TOOLS })), /<option value="always"/, "Always is not a choice here: it is offered on the card, after a first yes");
    assert.match(html, /create_branch, ?<\/span>|create_branch<\/span>/, "the tools of a kind are named under it");
    assert.match(html, /merge_pull_request<\/span>: Merge a pull request\./);
    assert.match(html, /Connected, asks before it changes things/);
    assert.match(html, /If you ask for a change, you are shown it first\./);
    assert.match(html, /<summary[^>]*>What each can do<\/summary>/);
  });

  it("shows nothing about changes for an account that has no tool for them, or is not connected, and still says read only", () => {
    assert.doesNotMatch(card(connected()), /Changes it may ask for/);
    assert.doesNotMatch(card(view({ writeTools: WRITE_TOOLS })), /Changes it may ask for/);
    assert.match(card(connected()), /It cannot change anything\./);
  });

  it("counts the tools that ask first in the list of what it is given", () => {
    const html = card(connected({ policy: { ...OFF, communicates: "ask" }, test: { ...TEST, offered: [...TEST.offered, { name: "add_issue_comment", text: "Comment.", class: "communicates" }] } }));
    assert.match(html, /<summary[^>]*>3 tools, 1 of them ask first<\/summary>/);
    assert.match(html, /The assistant is given 2 read tools and 1 that asks you before it changes something\./);
  });
});

describe("the card for a change", () => {
  const render = (over: Partial<AssistantWriteCard> = {}, busy = false) => renderToStaticMarkup(createElement(WriteCardView, { card: { ...CARD, ...over }, busy, onAnswer: () => undefined }));

  it("shows the account, the tool and every argument whole, what code noticed, and the fingerprint, and asks Do it or Don't", () => {
    const html = render();
    assert.match(html, /aria-label="A change the assistant wants to make in GitHub"/);
    assert.match(html, /Other people will see it/);
    assert.match(html, />Comment on an issue or a pull request\.</);
    assert.match(html, /In GitHub: aleff-ferreira\/ancilla #12, with <span[^>]*>add_issue_comment<\/span>/);
    assert.match(html, /<ul[^>]*aria-label="Look at these before you answer"[^>]*>\s*<li[^>]*>The text has a link or an address that you did not write: https:\/\/evil\.example\./);
    assert.match(html, /<dt[^>]*>owner<\/dt><dd[^>]*>aleff-ferreira<\/dd>/);
    assert.match(html, /<dd[^>]*whitespace-pre-wrap[^>]*>Fixed in 0\.27\.\nSee https:\/\/evil\.example<\/dd>/, "a text keeps its lines");
    assert.match(html, /<dt[^>]*>title<\/dt><dd[^>]*><span[^>]*>\(empty\)<\/span><\/dd>/);
    assert.match(html, /Exactly this is sent, and nothing else; if anything changes, you are asked again\. It lapses after 10 minutes\. Fingerprint 0123456789ab\./);
    assert.match(html, />Do it</);
    assert.match(html, />Don&#x27;t</);
    assert.doesNotMatch(html, /always do small changes/);
  });

  it("says how bad a mistake would be, and has no warning list when code noticed nothing", () => {
    assert.match(render({ class: "destructive" }), /Cannot be taken back/);
    assert.match(render({ class: "reversible" }), /Can be undone/);
    assert.doesNotMatch(render({ flags: [] }), /Look at these before you answer/);
  });

  it("offers 'always' only when it is offered, and says a proposal is one nobody asked for in person", () => {
    assert.match(render({ class: "reversible", offerAlways: true }), />Do it, and always do small changes like this</);
    const proposal = render({ proposal: true });
    assert.match(proposal, /Nobody was there when this was asked for, so it was kept for you\. It does nothing until you say so\./);
    assert.match(proposal, />Do it now</);
    assert.doesNotMatch(proposal, /lapses after 10 minutes/);
    assert.match(render({}, true), /<button[^>]*disabled=""[^>]*>Do it</, "while an answer is on its way, nothing can be clicked twice");
  });

  it("lists the proposals that wait on the Connectors page, and nothing when there are none", () => {
    const controller = { assistant: async () => ({}) } as unknown as AncillaController;
    const list = (cards: AssistantWriteCard[]) => renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(ProposalList, { cards, changed: () => undefined }) }));
    assert.equal(list([]), "");
    const html = list([{ ...CARD, proposal: true, taskId: "t_sched" }]);
    assert.match(html, /Waiting for you/);
    assert.match(html, />Do it now</);
  });
});

describe("an account that is not connected", () => {
  it("asks for a token the person makes, says how to make it small, and keeps the field a password field", () => {
    const html = card(view());
    assert.match(html, /Not connected/);
    assert.match(html, /Choose the repositories it may see and set everything to Read-only\./);
    assert.match(html, /<input[^>]*type="password"[^>]*autocomplete="off"/i);
    assert.match(html, /<a [^>]*href="https:\/\/github\.com\/settings\/personal-access-tokens\/new"[^>]*target="_blank"[^>]*>Make a token</);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Connect</, "nothing to connect with yet");
    for (const gone of [">Test<", ">Disconnect<", ">Ask<", "role=\"switch\""]) assert.ok(!html.includes(gone), `${gone} is not shown before there is a connection`);
  });

  it("can connect once a token that could be one is typed, and says so first when the provider cannot limit it", () => {
    const html = card(view({ caution: "A Brevo MCP key cannot be limited to reading." }), state({ token: "made-up-key-0123456789abcdef" }));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Connect</);
    assert.match(html, /A Brevo MCP key cannot be limited to reading\./);
  });

  it("shows a failure in words, and after a disconnect says where the token is revoked, because Ancilla cannot", () => {
    assert.match(card(view(), state({ error: "The server did not accept the token (401)." })), /role="alert"[^>]*>The server did not accept the token \(401\)\./);
    const html = card(view(), state({ note: "Removed from Ancilla. Open Settings, Developer settings, Personal access tokens, and delete the token." }));
    assert.match(html, /Removed from Ancilla\. Open Settings, Developer settings/);
    assert.match(html, /<a [^>]*href="https:\/\/github\.com\/settings\/personal-access-tokens"[^>]*>Open that page</);
  });

  it("shows work in progress on the button, and keeps everything else still", () => {
    const html = card(view(), state({ token: "made-up-token-0123456789abcdef", busy: "connect" }));
    assert.match(html, /<button[^>]*aria-busy="true"[^>]*>(?:<span[^>]*><\/span>)?Connect</);
  });
});

describe("an account that is connected", () => {
  it("says it is read only, what it is given, and offers a check, a switch, a disconnect and a question", () => {
    const html = card(connected());
    assert.match(html, /Connected, read only/);
    assert.match(html, /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
    assert.match(html, />Test</);
    assert.match(html, />Disconnect</);
    assert.match(html, /The assistant is given 2 read-only tools\./);
    assert.match(html, /<summary[^>]*>2 tools, read only<\/summary>/);
    assert.match(html, /get_me<\/span>: Who the token belongs to\./);
    assert.match(html, /aria-label="Ask GitHub"/);
    assert.doesNotMatch(html, /type="password"/, "a token is typed once and never shown again");
  });

  it("is switched off without being disconnected: no question box, and the switch says so", () => {
    const html = card(connected({ mode: "off" }));
    assert.match(html, /Connected, switched off/);
    assert.match(html, /aria-checked="false"/);
    assert.doesNotMatch(html, /aria-label="Ask GitHub"/);
    assert.match(html, />Disconnect</);
  });

  it("says when the last check failed, with the reason", () => {
    const html = card(connected({ test: { ...TEST, ok: false, message: "GitHub accepted the token, but the check failed: Bad credentials", offered: [] } }));
    assert.match(html, /Connected, last check failed/);
    assert.match(html, /role="alert"[^>]*>GitHub accepted the token, but the check failed: Bad credentials/);
  });

  it("asks only when there is something to ask: a question of a few words is not sent", () => {
    assert.match(card(connected(), state({ goal: "ab" })), /<button[^>]*disabled=""[^>]*>Ask</);
    assert.doesNotMatch(card(connected(), state({ goal: "What is open?" })), /<button[^>]*disabled=""[^>]*>Ask</);
    assert.match(card(connected(), state({ note: "Started. It is under Tasks, and you are told when it is done." })), /Started\. It is under Tasks/);
  });
});

describe("what the connectors did", () => {
  const now = 10 * 60_000;
  const html = (entries: AssistantConnectorActivity[]) => renderToStaticMarkup(createElement(ActivityList, { entries, now, nameOf: (id) => (id === "github" ? "GitHub" : id) }));

  it("is empty at first, and says what will be written here", () => {
    assert.match(html([]), /Nothing yet\. Every connection, check and read is written here/);
  });

  it("lists the lines newest first, each with how long ago, and marks what did not work", () => {
    const out = html([
      { at: now - 2 * 60_000, kind: "call", connector: "github", tool: "merge_pull_request", ok: false, note: "refused: not on the list" },
      { at: now - 5 * 60_000, kind: "call", connector: "github", tool: "search_issues", ok: true },
    ]);
    assert.ok(out.indexOf("merge_pull_request was refused") < out.indexOf("read with search_issues"));
    assert.match(out, /2 minutes ago/);
    assert.match(out, /5 minutes ago/);
    assert.match(out, /text-warn-text[^>]*>GitHub: merge_pull_request was refused/);
  });
});

describe("a connector task in the Tasks list", () => {
  const task = (over: Partial<AssistantTaskView> = {}): AssistantTaskView => ({
    id: "t_1", title: "Open on GitHub", goal: "What is open on my GitHub?", status: "running", reason: "GitHub: search_issues", origin: "connector", cwd: "/work/atlas", sessionId: null,
    allowWrites: false, maxTurns: 6, maxMinutes: 30, turnsUsed: 0, retryAt: null, startedAt: 1, finishedAt: null, result: "", createdAt: 1, updatedAt: 1, progress: { done: 0, total: 1 }, ...over,
  });
  const render = (t: AssistantTaskView): string => {
    const controller = { assistant: async () => ({}) } as unknown as AncillaController;
    const row = createElement(TaskRow, { task: t, now: 10, open: false, onToggle: () => undefined, changed: () => undefined, bump: 0 });
    return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
  };

  it("shows what it is and what it can do, and nothing that does not apply to work done in this process", () => {
    const html = render(task());
    assert.match(html, /Connected account/);
    assert.match(html, /works in a connected account and asks before it changes anything/);
    assert.match(html, /What is open on my GitHub\?/);
    assert.doesNotMatch(html, /turns/);
    for (const gone of [">Pause<", ">Resume<", ">Try again<", ">Approve<", "Allow for this task"]) assert.ok(!html.includes(gone), gone);
    assert.match(html, />Cancel</);
    assert.doesNotMatch(html, /Needs your OK/);
  });

  it("says it needs the person while a change waits, and offers nothing that does not apply: the card is answered in the row", () => {
    const html = render(task({ status: "paused", reason: "Waiting for your approval: Merge a pull request (o/r #3) on GitHub." }));
    assert.match(html, /Needs your OK/);
    assert.match(html, /Waiting for your approval: Merge a pull request \(o\/r #3\) on GitHub\./);
    for (const gone of [">Pause<", ">Resume<", ">Try again<", ">Approve<", "Allow for this task"]) assert.ok(!html.includes(gone), gone);
    assert.match(html, />Cancel</);
  });

  it("shows what it found, as what it is: not checked", () => {
    const html = render(task({ status: "completed", reason: "Done after 2 steps.", result: "From GitHub (not checked):\n#7 is open.\nTools used: search_issues" }));
    assert.match(html, /From GitHub \(not checked\):/);
    assert.match(html, /#7 is open\./);
    assert.doesNotMatch(html, />Cancel</);
  });
});
