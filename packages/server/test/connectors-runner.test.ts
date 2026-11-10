import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeHost } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { parseTaskSpec } from "../src/assistant/tasks.js";
import { AuditLog } from "../src/connectors/audit.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { handleConnectors } from "../src/connectors/routes.js";
import { ConnectorRunner } from "../src/connectors/runner.js";
import { FileSecretStore } from "../src/connectors/secrets.js";
import type { BrainEvent, BrainProvider, BrainRequest } from "../src/voice/brain.js";
import { noticeOf } from "../src/voice/assistant-host.js";
import { VoiceTools, type VoiceConnectors } from "../src/voice/tools.js";
import { TOKEN, fakeServer, openerFor, type FakeServer } from "./connectors-fixtures.js";

/**
 * A task on a connected account, end to end but for the account itself: the voice tool (or the text box) makes it, the executive
 * keeps its row, the runner works on it with a scripted model and the registry's session, and every guard a web task has holds
 * for it too. Then the HTTP surface, which must never say the token.
 */

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, arguments: JSON.stringify(args) });

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 4));
  }
}

/** A promise the test settles by hand: the model "thinks" until it is told to go on. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Step = { text?: string; calls?: Array<{ name: string; args?: Record<string, unknown> }>; wait?: Promise<void> };

class Scripted implements BrainProvider {
  readonly id = "scripted";
  readonly label = "Scripted";
  readonly capabilities = { tools: true, speculative: false, local: true };
  private n = 0;
  constructor(private readonly steps: Step[]) {}
  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const step = this.steps[this.n] ?? { text: "" };
    this.n += 1;
    if (step.wait) await step.wait;
    if (request.signal.aborted) return;
    if (step.text) yield { type: "text", delta: step.text };
    for (const [i, c] of (step.calls ?? []).entries()) yield { type: "tool", call: { id: `c${this.n}_${i}`, name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
    yield { type: "done", reason: step.calls?.length ? "tool" : "stop" };
  }
}

const READ_AND_ANSWER: Step[] = [{ calls: [{ name: "search_issues", args: { query: "is:open" } }] }, { calls: [{ name: "done", args: { answer: "#7 is open." } }] }];

function rig(options: { steps?: Step[]; problem?: string | null; server?: FakeServer } = {}) {
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true });
  const host = new FakeHost(clock);
  const server = options.server ?? fakeServer();
  const audit = new AuditLog(null);
  const registry = new ConnectorRegistry({ file: null, secrets: new FileSecretStore(null), audit, open: openerFor(server), now: () => clock.t });
  const state = { steps: options.steps ?? READ_AND_ANSWER, problem: options.problem ?? null };
  const runner = new ConnectorRunner({ registry, brain: () => ({ brain: new Scripted(state.steps), problem: state.problem }), log: () => undefined });
  const service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host, connector: runner });
  const connectors: VoiceConnectors = { usable: () => registry.usable().map((id) => ({ id, name: registry.view(id).name })), available: (id) => runner.available(id) };
  const tools = new VoiceTools({ assistant: service, project: () => "/work/atlas", lang: () => "en", conversationId: "cv_1", connectors });
  const exec = service.executive;
  assert.ok(exec);
  const task = (id: string) => service.tasks.require(id);
  const start = async (goal = "What is open on my GitHub?", title = "Open on GitHub") => {
    const result = await tools.run(call("use_connector", { connector: "github", goal, title }));
    assert.equal(result.ok, true, result.text);
    const created = service.tasks.list("all", 1)[0];
    assert.ok(created);
    return { result, id: created.id };
  };
  return { clock, store, host, server, audit, registry, runner, service, tools, exec, state, task, start };
}

describe("a task on a connected account", () => {
  it("is offered to the voice only while an account is connected, is made by it, reads with the account's tools, and answers with where it came from", async () => {
    const r = rig();
    assert.ok(!r.tools.specs().some((t) => t.name === "use_connector"), "nothing is connected, so the model is not offered it");
    await r.registry.connect("github", TOKEN);
    const spec = r.tools.specs().find((t) => t.name === "use_connector");
    assert.deepEqual((spec?.parameters["properties"] as Record<string, { enum?: string[] }>)["connector"]?.enum, ["github"], "it names what exists");

    const { result, id } = await r.start();
    assert.match(result.text, /Started task .*It works in GitHub in the background\. It can change something only if the user asked for that/);
    assert.equal(result.narration, "I've started that in the background.");
    const made = r.task(id);
    assert.deepEqual([made.origin, made.allowWrites, made.title, made.cwd], ["connector", false, "Open on GitHub", "/work/atlas"]);
    await until(() => r.task(id).status === "completed", "the answer");
    const done = r.task(id);
    assert.equal(done.result, "From GitHub (not checked):\n#7 is open.\nTools used: search_issues");
    assert.equal(done.reason, "Done after 2 steps.");
    assert.deepEqual(done.progress, { done: 1, total: 1 });
    assert.equal(noticeOf(done), "done");
    assert.equal(r.host.sessions.length, 0, "no Muse thread was opened for it");
    assert.equal(r.host.turns.length, 0);
    assert.equal(r.runner.owns(id), false);
    assert.ok(r.audit.recent(20).some((e) => e.kind === "call" && e.task === id && e.tool === "search_issues" && e.ok), "the call is written down, with its task");
    assert.equal(r.server.closed, r.server.opened, "the connection was let go");
  });

  it("is refused in plain words when the account is off, unknown, not connected, or no model is there", async () => {
    const r = rig();
    const asked = async (args: Record<string, unknown>) => r.tools.run(call("use_connector", args));
    assert.match((await asked({ connector: "github", goal: "x" })).text, /None is connected: the user connects one under Assistant, Connectors\./);
    await r.registry.connect("github", TOKEN);
    assert.match((await asked({ connector: "gitlab", goal: "x" })).text, /There is no connected account called "gitlab".*The accounts are: GitHub\./);
    assert.match((await asked({ connector: "github", goal: "" })).text, /needs a goal/);
    r.state.problem = "Choose a model in the voice settings.";
    assert.equal((await asked({ connector: "GitHub", goal: "x" })).text, "Choose a model in the voice settings.");
    r.state.problem = null;
    r.registry.setMode("github", "off");
    assert.ok(!r.tools.specs().some((t) => t.name === "use_connector"), "switched off, it is not offered");
    assert.match((await asked({ connector: "github", goal: "x" })).text, /None is connected|There is no connected account/);
    await assert.rejects(() => r.exec.connectorAvailable("nothing"));
    assert.equal(r.service.tasks.list("all", 5).length, 0, "no task was made by any of them");
  });

  it("is one at a time, can be cancelled, and is stopped with the assistant", async () => {
    const hold = deferred();
    const r = rig({ steps: [{ wait: hold.promise, calls: [{ name: "get_me" }] }, { calls: [{ name: "done", args: { answer: "late" } }] }] });
    await r.registry.connect("github", TOKEN);
    const { id } = await r.start();
    await until(() => r.runner.owns(id), "the runner to take it");
    const busy = await r.tools.run(call("use_connector", { connector: "github", goal: "another" }));
    assert.equal(busy.ok, false);
    assert.match(busy.text, /already using a connector/);

    await r.exec.cancel(id);
    assert.equal(r.task(id).status, "cancelled");
    hold.resolve();
    await until(() => !r.runner.owns(id), "the runner to let go");
    assert.equal(r.task(id).status, "cancelled", "what the runner reports after the cancel is ignored");
    assert.equal(r.task(id).result, "");
    assert.equal(r.server.closed, r.server.opened);

    const second = deferred();
    r.state.steps = [{ wait: second.promise, calls: [{ name: "get_me" }] }];
    const again = await r.start("one more");
    await until(() => r.runner.owns(again.id), "the second task");
    assert.equal(r.exec.pauseAll("The assistant was switched off."), 1);
    assert.equal(r.task(again.id).status, "cancelled");
    second.resolve();
    await until(() => !r.runner.owns(again.id), "the second runner to let go");
  });

  it("cannot be paused, resumed, retried, extended, resolved or confirmed, and is ended when Ancilla restarts around it", async () => {
    const hold = deferred();
    const r = rig({ steps: [{ wait: hold.promise, calls: [{ name: "get_me" }] }] });
    await r.registry.connect("github", TOKEN);
    const { id } = await r.start();
    await until(() => r.runner.owns(id), "the runner to take it");
    assert.throws(() => r.exec.pause(id), /A connector task cannot be paused/);
    assert.throws(() => r.exec.resume(id), /A connector task cannot be resumed/);
    assert.throws(() => r.exec.retry(id), /A connector task cannot be tried again/);
    assert.throws(() => r.exec.extend(id, 1, 0), /A connector task cannot be extended/);
    assert.throws(() => r.exec.resolve(id, "st_x", "done"), /A connector task cannot be resolved by hand/);
    assert.throws(() => r.exec.confirm(id), /A connector task cannot be confirmed/);
    assert.throws(() => r.exec.approve(id), /nothing here to approve/);
    r.exec.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.task(id).status, "running", "a pass of the executive leaves it alone");

    const spec = parseTaskSpec({ goal: "left behind", cwd: "/work/atlas" }, r.store.getProfile(), (c) => c);
    const stale = r.service.tasks.create({ ...spec, origin: "connector" });
    r.service.tasks.setStatus(stale.id, "running", "Connecting.");
    assert.deepEqual(await r.exec.recover(), { resumed: 0, reconciled: 0, blocked: 0 });
    assert.equal(r.task(stale.id).status, "failed");
    assert.match(r.task(stale.id).reason, /stopped while this connector task ran/);
    assert.equal(r.task(id).status, "running", "the one being worked on is not touched");
    await r.exec.cancel(id);
    hold.resolve();
    await until(() => !r.runner.owns(id), "the runner to let go");
  });

  it("says why it stopped when the account fails or the model cannot be used, and counts nothing it did not do", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    r.server.tokens = [];
    const { id } = await r.start();
    await until(() => r.task(id).status === "failed", "the failure");
    assert.match(r.task(id).reason, /did not accept the token/);
    assert.equal(r.task(id).result, "");
    assert.equal(r.service.tasks.list("all", 5).length, 1);
  });
});

describe("the HTTP surface of the connectors", () => {
  function http(r: ReturnType<typeof rig>) {
    const seen: string[] = [];
    const send = async (method: string, sub: string, body: Record<string, unknown> = {}, query = "") => {
      const reply = await handleConnectors({ registry: r.registry, audit: r.audit, assistant: () => r.service, project: () => "/work/atlas" }, { method, path: `/api/assistant/connectors${sub}`, query: new URLSearchParams(query), body: async () => body });
      seen.push(JSON.stringify(reply));
      return reply;
    };
    return { send, seen };
  }

  it("lists, connects, tests, switches and disconnects, and no answer ever says the token", async () => {
    const r = rig();
    const { send, seen } = http(r);
    const list = await send("GET", "");
    assert.equal(list.status, 200);
    const body = list.body as { connectors: Array<{ id: string; connected: boolean }>; storage: string };
    assert.deepEqual(body.connectors.map((c) => [c.id, c.connected]), [["github", false], ["supabase", false], ["brevo", false]]);
    assert.match(body.storage, /only your user account can read|memory/);

    assert.equal((await send("POST", "/github/connect", { token: "short" })).status, 400);
    assert.equal((await send("POST", "/github/connect", { token: "wrong-token-0123456789" })).status, 422);
    assert.equal((await send("POST", "/nothing/connect", { token: TOKEN })).status, 404);
    const connected = await send("POST", "/github/connect", { token: TOKEN });
    assert.equal(connected.status, 200);
    assert.equal((connected.body as { connector: { connected: boolean; mode: string } }).connector.mode, "read");
    assert.equal((await send("POST", "/github/test")).status, 200);
    assert.equal((await send("PATCH", "/github", { mode: "off" })).status, 200);
    assert.equal((await send("PATCH", "/github", { mode: "admin" })).status, 400);
    assert.equal((await send("PATCH", "/brevo", { mode: "read" })).status, 409);

    const activity = await send("GET", "/activity", {}, "limit=5");
    const entries = (activity.body as { entries: Array<{ kind: string }> }).entries;
    assert.ok(entries.length > 0 && entries.length <= 5);
    assert.equal(entries[0]?.kind, "mode", "newest first");

    const gone = await send("DELETE", "/github");
    assert.equal((gone.body as { connector: { connected: boolean; revoke: { text: string } } }).connector.connected, false);
    assert.match((gone.body as { connector: { revoke: { text: string } } }).connector.revoke.text, /delete the token/);
    assert.equal((await send("GET", "/nothing")).status, 404);
    assert.equal((await send("PUT", "/github")).status, 404);
    for (const text of seen) assert.ok(!text.includes(TOKEN) && !text.includes("github_pat_"), "no answer carries the token");
  });

  it("starts a task from the text box when the account is on, and says why when it cannot", async () => {
    const r = rig();
    const { send } = http(r);
    await send("POST", "/github/connect", { token: TOKEN });
    assert.equal((await send("POST", "/ask", { connector: "github", goal: "x" })).status, 400, "a goal says what to find out");
    assert.equal((await send("POST", "/ask", { goal: "What is open?" })).status, 400);
    const started = await send("POST", "/ask", { connector: "github", goal: "What is open on my GitHub?", title: "Open on GitHub" });
    assert.equal(started.status, 201);
    const task = (started.body as { task: { id: string; origin: string; title: string } }).task;
    assert.deepEqual([task.origin, task.title], ["connector", "Open on GitHub"]);
    await until(() => r.task(task.id).status === "completed", "the answer");
    await send("PATCH", "/github", { mode: "off" });
    const off = await send("POST", "/ask", { connector: "github", goal: "What is open on my GitHub?" });
    assert.equal(off.status, 409);
    assert.match((off.body as { error: string }).error, /switched off/);
    assert.equal((await send("POST", "/ask", { connector: "nothing", goal: "What is open?" })).status, 404);
  });
});
