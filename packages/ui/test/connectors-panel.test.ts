import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ActivityList, ConnectorCardView, type CardHandlers, type CardState } from "../src/components/assistant/ConnectorsPanel.js";
import { activityLine, reachNote, statusOf, tokenLooksUsable } from "../src/components/assistant/connectors.js";
import { TaskRow } from "../src/components/assistant/TasksPanel.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import type { AssistantConnectorActivity, AssistantConnectorView, AssistantTaskView } from "../src/types.js";

/**
 * The Connectors page: what a connected account is called, what is asked of the person to connect one, what they are told it
 * can and cannot do, and what the list of what it did says. A connected account can only be read, and the page never says more
 * than that.
 */

const TEST = {
  at: 1,
  ok: true,
  message: "Works. 2 read tools are offered, and 9 more that it has are not offered because they can change things or are not on Ancilla's list.",
  offered: [
    { name: "get_me", text: "Who the token belongs to." },
    { name: "search_issues", text: "Find issues." },
  ],
  hidden: 9,
  missing: [],
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
  test: null,
  ...over,
});

const state = (over: Partial<CardState> = {}): CardState => ({ token: "", goal: "", busy: null, error: null, note: null, ...over });
const on: CardHandlers = { token: () => undefined, goal: () => undefined, connect: () => undefined, test: () => undefined, mode: () => undefined, disconnect: () => undefined, ask: () => undefined };
const card = (v: AssistantConnectorView, s: CardState = state()) => renderToStaticMarkup(createElement(ConnectorCardView, { view: v, state: s, on }));
const connected = (over: Partial<AssistantConnectorView> = {}) => view({ connected: true, mode: "read", connectedAt: 5, test: TEST, ...over });

describe("what the page says about an account", () => {
  it("names the state of an account in a word, and whether to worry", () => {
    assert.deepEqual(statusOf(view()), { label: "Not connected", tone: "plain" });
    assert.deepEqual(statusOf(connected()), { label: "Connected, read only", tone: "ok" });
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
    assert.equal(reachNote(connected({ test: { ...TEST, offered: [{ name: "get_me", text: "x" }], hidden: 1, missing: ["old_tool"] } })), "The assistant is given 1 read-only tool. 1 more that the server has is not offered, because it can change things or is not on Ancilla's list. 1 on Ancilla's list was not found on the server, so it is not offered either.");
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
    assert.equal(line({ kind: "mode", note: "mode read" }), "GitHub: switched on for reading");
    assert.equal(line({ kind: "disconnect" }), "GitHub: disconnected");
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
    assert.match(html, /reads a connected account and cannot change anything/);
    assert.match(html, /What is open on my GitHub\?/);
    assert.doesNotMatch(html, /turns/);
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
