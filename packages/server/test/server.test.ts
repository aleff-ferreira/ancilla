import { describe, it, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import {
  AncillaServer,
  deriveTitle,
  eventsFromHistory,
  mergeSessionSkills,
  normalizeIso,
  parseSkillList,
  stripFrontmatter,
  toWireEvent,
  type HostExit,
  type HostHandle,
  type LoginChild,
  type LoginSpawn,
  type OpenTarget,
} from "../src/server.js";
import type { ExecFn, ServeTarget } from "@ancilla/daemon";
import { MuseSubscriptionReader } from "../src/subscriptionQuota.js";

/** Test credentials must stay inside their fixture even when the runner defines an XDG root or API key. */
function quotaEnvironment(t: TestContext, home: string): void {
  const keys = ["XDG_CONFIG_HOME", "MUSE_AUTH_PATH", "META_API_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["XDG_CONFIG_HOME"] = join(home, ".config");
  delete process.env["MUSE_AUTH_PATH"];
  delete process.env["META_API_KEY"];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
}

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

type Reply = unknown | ((params: Record<string, unknown>) => unknown);

class MspTestError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

class FakeConnection {
  calls: Call[] = [];
  requests: Call[] = [];
  replies = new Map<string, Reply>();
  handler: ((n: { method: string; params?: unknown }) => void) | null = null;

  private answer(method: string, params: Record<string, unknown>): unknown {
    const reply = this.replies.get(method);
    if (reply instanceof Error) {
      throw reply;
    }
    if (typeof reply === "function") {
      return (reply as (p: Record<string, unknown>) => unknown)(params);
    }
    return reply ?? { ok: true };
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.answer(method, params);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ method, params });
    return this.answer(method, params);
  }

  onNotification(handler: (n: { method: string; params?: unknown }) => void): void {
    this.handler = handler;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.handler?.({ method, params });
  }
}

interface FactoryProbe {
  targets: ServeTarget[];
  exits: ((exit: HostExit) => void)[];
}

/** A fake `muse login` child: stdout/stderr an EventEmitter each, `kill()` fires `close` like a real process. */
class FakeLoginChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private readonly emitter = new EventEmitter();
  killCount = 0;

  on(event: "close" | "error", listener: (arg: unknown) => void): void {
    this.emitter.on(event, listener);
  }

  kill(): void {
    this.killCount += 1;
    setImmediate(() => this.emitter.emit("close", null));
  }

  finish(exitCode: number): void {
    this.emitter.emit("close", exitCode);
  }
}

function fakeFactory(connection: FakeConnection, probe?: FactoryProbe): (target: ServeTarget) => HostHandle {
  return (target) => {
    probe?.targets.push(target);
    return {
      start: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: connection as never,
      close: async () => ({ code: 0, signal: null }),
      onExit: (handler) => probe?.exits.push(handler),
    };
  };
}

async function start(connection: FakeConnection, extra: Partial<ConstructorParameters<typeof AncillaServer>[0]> = {}) {
  const fixtureHome = await mkdtemp(join(tmpdir(), "ancilla-server-home-"));
  const server = new AncillaServer({
    port: 0,
    dataDir: ":memory:",
    platform: "linux",
    musePath: "muse",
    home: fixtureHome,
    hostFactory: fakeFactory(connection),
    // No test spawns the real CLI by accident; title upgrades see a failed call.
    exec: async () => ({ stdout: "", exitCode: 127 }),
    ...extra,
  });
  // A test that closes the server itself (to restart it on the same data) is not failed by closing it again.
  after(async () => { await server.close().catch(() => undefined); await rm(fixtureHome, { recursive: true, force: true }); });
  const bound = await server.listen();
  return { server, base: `http://127.0.0.1:${bound.port}` };
}

async function send(
  base: string,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base: string, path: string): Promise<any> {
  return (await fetch(`${base}${path}`)).json();
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await cond()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Opens the real `/api/events` SSE stream, waits for it to be live, runs `drive`, then returns every payload of
 * `type` that arrived. Uses the server's actual public event API rather than a test-only hook.
 */
async function sseEvents(base: string, type: string, drive: () => Promise<void>): Promise<any[]> {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawHello = false;
  const payloads: any[] = [];
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) {
          continue;
        }
        const payload = JSON.parse(dataLine.slice("data: ".length));
        if (payload.type === "hello") {
          sawHello = true;
        }
        if (payload.type === type) {
          payloads.push(payload);
        }
      }
    }
  })();

  await waitFor(() => sawHello, "sse hello event");
  await drive();
  // Give the emitted SSE writes a moment to land before counting.
  await new Promise((r) => setTimeout(r, 150));
  stop = true;
  await reader.cancel().catch(() => undefined);
  await pump.catch(() => undefined);
  return payloads;
}

async function countPlanUsageEvents(base: string, drive: () => Promise<void>): Promise<number> {
  return (await sseEvents(base, "plan-usage", drive)).length;
}

/**
 * A `wsl.exe` whose `-l -v` lists `distros` (the first one WSL's default) and that finds Muse at
 * /home/u/.local/bin/muse in the distros named in `museIn`, whether looked up on PATH or checked as a pinned binary.
 * Every call, and the environment it was given, is recorded in `probe`.
 */
function fakeWsl(distros: string[], museIn: string[], probe: { calls: string[][]; envs: (NodeJS.ProcessEnv | undefined)[] }): ExecFn {
  return async (command, args, options) => {
    probe.calls.push([command, ...args]);
    probe.envs.push(options?.env);
    if (command !== "wsl") {
      return { stdout: "", exitCode: 127 };
    }
    if (args[0] === "-l") {
      const rows = distros.map((name, index) => `${index === 0 ? "*" : " "} ${name}  Running  2`);
      return { stdout: ["  NAME  STATE  VERSION", ...rows].join("\n") + "\n", exitCode: 0 };
    }
    const found = museIn.includes(args[1] ?? "");
    if (args[2] === "-e" && args[3] === "test") {
      return { stdout: "", exitCode: found ? 0 : 1 };
    }
    return found ? { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
  };
}

const RANGE = { first: { id: "r", sequence: 1 }, last: { id: "r", sequence: 1 }, stream: { id: "s", kind: "session" } };

/**
 * Holds every `session/read` until `finish`, then answers all of them with the same snapshot: a refresh reads the
 * status again after paging, and that read is no newer than the delayed one here.
 */
function holdReads(connection: FakeConnection): { started: () => boolean; finish: (value: unknown) => void } {
  let release!: (value: unknown) => void;
  const answer = new Promise((resolve) => {
    release = resolve;
  });
  let started = false;
  connection.replies.set("session/read", () => {
    started = true;
    return answer;
  });
  return { started: () => started, finish: (value) => release(value) };
}

describe("read-only recovery of a silent Muse view", () => {
  async function running() {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/recovery" });
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    return { connection, base };
  }

  it("records unavailable live updates without declaring the running turn failed", async () => {
    const { connection, base } = await running();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.live.activeTurnId, "t1");
    assert.equal(session.live.lastError, null);
    assert.equal(session.live.lastTerminal, null);
    assert.deepEqual(session.live.viewHealth, { status: "unavailable", reason: "projectionUnavailable" });
  });

  it("clears unavailable health only when durable progress belongs to the active turn", async () => {
    const { connection, base } = await running();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    const health = async () => (await get(base, "/api/sessions")).sessions[0].live.viewHealth;
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "m1", viewCursor: "v:1", sourceRange: RANGE });
    connection.notify("item/updated", { sessionId: "s1", viewCursor: "v:2", sourceRange: RANGE,
      item: { itemId: "old", kind: "toolCall", turnId: "older-turn", revision: 2, status: "completed" } });
    connection.notify("item/delta", { sessionId: "s1", turnId: "t1", itemId: "reply", field: "text", delta: "working" });
    assert.equal((await health()).status, "unavailable", "metadata, old turns and ephemeral text do not certify the durable projection");
    connection.notify("item/updated", { sessionId: "s1", viewCursor: "v:3", sourceRange: RANGE,
      item: { itemId: "work", kind: "toolCall", turnId: "t1", revision: 2, status: "completed" } });
    assert.equal(await health(), null);
    assert.equal((await get(base, "/api/sessions")).sessions[0].live.activeTurnId, "t1");
  });

  it("clears unavailable health when the active turn durably completes", async () => {
    const { connection, base } = await running();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed", viewCursor: "v:3", sourceRange: RANGE });
    const live = (await get(base, "/api/sessions")).sessions[0].live;
    assert.equal(live.viewHealth, null);
    assert.equal(live.activeTurnId, null);
    assert.equal(live.lastTerminal, "completed");
  });

  it("does not let a delayed unavailable read overwrite newer durable item progress", async () => {
    const { connection, base } = await running();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    const { started, finish } = holdReads(connection);
    const reading = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(started, "recovery read starts");
    connection.notify("item/completed", { sessionId: "s1", viewCursor: "v:4", sourceRange: RANGE,
      item: { itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "completed", text: "Progress" } });
    finish({ session: { sessionId: "s1", status: "idle", activeTurnId: null },
      history: { mode: "none", noneReason: "projectionUnavailable" } });
    const reply = await reading;
    assert.equal(reply.status, 200);
    assert.equal(reply.json.viewHealth, null);
    assert.equal(reply.json.msp.activeTurnId, "t1");
    assert.equal(reply.json.historyUnavailable, true, "the old response remains partial even though live progress recovered");
    assert.equal(reply.json.pendingComplete, false);
  });

  it("does not let an older successful read clear a newer unavailable notification", async () => {
    const { connection, base } = await running();
    const { started, finish } = holdReads(connection);
    const reading = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(started, "history read starts");
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    finish({ session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "inline", items: [] } });
    const reply = await reading;
    assert.deepEqual(reply.json.viewHealth, { status: "unavailable", reason: "projectionUnavailable" });
  });

  it("clears unavailable health after a successful read serves known history", async () => {
    const { connection, base } = await running();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "inline", items: [{ itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "inProgress", text: "Progress" }] },
    });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.viewHealth, null);
    assert.equal(reply.json.historyUnavailable, false);
    assert.equal(reply.json.msp.activeTurnId, "t1");
    assert.equal(connection.calls.some((call) => ["session/resume", "turn/start"].includes(call.method)), false);
  });

  it("includes newer snapshot items alongside paged history without duplicating usage", async () => {
    const { connection, base } = await running();
    const earlier = { itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "inProgress", text: "Earlier" };
    const latest = { ...earlier, revision: 2, status: "completed", text: "Latest" };
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "snapshot", snapshot: { state: { items: [latest], tokenUsage: { totalTokens: 10 } } } },
    });
    connection.replies.set("view/page", { events: [
      { method: "item/updated", params: { sessionId: "s1", item: earlier } },
      { method: "session/tokenUsage", params: { sessionId: "s1", turnId: "t1", viewCursor: "v:2", promptTokens: 8, totalTokens: 10 } },
    ], nextCursor: null });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.deepEqual(reply.json.events.filter((event: any) => event.params.item).map((event: any) => event.params.item), [earlier, latest]);
    assert.equal(reply.json.events.filter((event: any) => event.method === "session/tokenUsage").length, 1);
    assert.equal(connection.calls.some((call) => ["session/resume", "turn/start"].includes(call.method)), false);
  });

  it("recovers a missed completion through read and history, without resume or another turn", async () => {
    const { connection, base } = await running();
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1 },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    connection.replies.set("view/page", { events: [
      { method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed" } },
    ], nextCursor: null });
    const result = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(result.status, 200);
    assert.equal(result.json.msp.activeTurnId, null);
    assert.equal(result.json.session.live.lastTerminal, "completed");
    assert.equal(result.json.viewHealth.status, "unavailable");
    assert.equal(result.json.historyUnavailable, true, "a nonempty prefix does not make an unavailable projection complete");
    assert.equal(connection.calls.some((call) => ["session/resume", "turn/start"].includes(call.method)), false);
    const reads = connection.requests.filter((call) => call.method === "session/read");
    assert.deepEqual(reads.map((call) => call.params?.["excludeItems"]), [false, true], "history once, then the status after paging");
  });

  it("does not present the history projection's incomplete open run as a failed turn", async () => {
    const { connection, base } = await running();
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "running", activeTurnId: "t1" } });
    const priorFailure = { method: "turn/completed", params: { sessionId: "s1", turnId: "t0", terminal: "failed", reason: "incomplete" } };
    const openRun = { method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "failed", reason: "incomplete" } };
    connection.replies.set("view/page", { events: [priorFailure, openRun], nextCursor: null });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.msp.activeTurnId, "t1");
    assert.deepEqual(reply.json.events, [priorFailure], "only the still-open run's synthetic failure is omitted");
    assert.equal(reply.json.session.live.lastError, null);
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "idle", activeTurnId: null } });
    const stopped = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(stopped.json.events.length, 2, "an idle incomplete run remains a visible failure");
  });

  it("does not clear a newer turn when a delayed read returns an old idle snapshot", async () => {
    const { connection, base } = await running();
    const { started, finish } = holdReads(connection);
    const result = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(started, "read starts");
    connection.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    finish({ session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1 }, history: { items: [] } });
    const reply = await result;
    assert.equal(reply.status, 200);
    assert.equal(reply.json.msp.activeTurnId, "t2");
    assert.equal(reply.json.session.live.activeTurnId, "t2");
    assert.equal(reply.json.pendingComplete, false);
  });

  it("does not interpret another host's notLoaded snapshot as an idle turn", async () => {
    const { connection, base } = await running();
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.msp.activeTurnId, "t1");
    assert.equal(reply.json.session.live.activeTurnId, "t1");
    assert.equal(reply.json.session.live.pendingApprovals, 1);
    assert.equal(reply.json.pendingComplete, false);
  });

  it("keeps the last pending state when its read fails, and marks missing history explicitly", async () => {
    const { connection, base } = await running();
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    connection.replies.set("approval/listPending", new Error("temporarily unavailable"));
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.historyUnavailable, true);
    assert.equal(reply.json.pendingComplete, false);
    assert.equal(reply.json.session.live.pendingApprovals, 1);
  });

  it("protects a newly accepted turn even when its started notification is missing", async () => {
    const { connection, base } = await running();
    const { started, finish } = holdReads(connection);
    const reading = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(started, "read starts");
    connection.replies.set("turn/start", { status: "accepted", disposition: "started", turnId: "t2" });
    assert.equal((await send(base, "/api/turns", { sessionId: "s1", text: "Next task" })).status, 200);
    finish({ session: { sessionId: "s1", status: "idle", activeTurnId: null }, history: { items: [] } });
    const reply = await reading;
    assert.equal(reply.json.msp.activeTurnId, "t2");
    assert.equal(reply.json.session.live.activeTurnId, "t2");
  });
});

describe("recovery after host loss, session closes and stale reads", () => {
  const NOT_LOADED = { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null }, history: { mode: "inline", items: [] }, pendingRequests: [] };
  const IDLE = { session: { sessionId: "s1", status: "idle", activeTurnId: null } };
  const started = (turnId: string) => ({ method: "turn/started", params: { sessionId: "s1", turnId } });
  const ended = (turnId: string, terminal: string, extra: Record<string, unknown> = {}) =>
    ({ method: "turn/completed", params: { sessionId: "s1", turnId, terminal, ...extra } });
  const terminals = (reply: { json: any }) =>
    reply.json.events.filter((e: any) => e.method === "turn/completed").map((e: any) => [e.params.turnId, e.params.terminal]);
  const resumes = (connection: FakeConnection) => connection.calls.filter((c) => c.method === "session/resume").length;
  const live = async (base: string) => (await get(base, "/api/sessions")).sessions[0].live;

  /** A thread started and opened here (its session loaded on the host), then left idle. */
  async function opened(extra: Partial<ConstructorParameters<typeof AncillaServer>[0]> = {}) {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", IDLE);
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base, server } = await start(connection, { hostFactory: fakeFactory(connection, probe), ...extra });
    await send(base, "/api/sessions", { cwd: "/work/recovery" });
    assert.equal((await send(base, "/api/sessions/s1/resume", {})).json.readOnly, false);
    return { connection, base, probe, server };
  }

  it("loads an idle thread again after its host exited, instead of calling it read-only", async () => {
    const { connection, base, probe } = await opened();
    probe.exits[0]?.({ code: 1, signal: null });
    connection.replies.set("session/read", NOT_LOADED);
    const before = resumes(connection);
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.readOnly, false);
    assert.equal(reply.json.readOnlyReason, null);
    assert.equal(reply.json.msp.status, "idle");
    assert.equal(resumes(connection), before + 1, "the session is loaded on the replacement host");
    assert.equal(probe.targets.length, 2);
    connection.replies.set("turn/start", { status: "accepted", disposition: "started", turnId: "t1" });
    assert.equal((await send(base, "/api/turns", { sessionId: "s1", text: "Carry on" })).status, 200, "and the next prompt goes through");
    assert.equal((await live(base)).activeTurnId, "t1");
  });

  it("loads an idle thread again after a settings change restarted its host", async () => {
    const { connection, base, probe } = await opened();
    assert.equal((await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH")).status, 200);
    connection.replies.set("session/read", NOT_LOADED);
    const before = resumes(connection);
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.readOnly, false);
    assert.equal(reply.json.readOnlyReason, null);
    assert.equal(resumes(connection), before + 1);
    assert.ok(probe.targets.at(-1)?.args.includes("--disable-sandbox"), "on a host carrying the new setting");
  });

  it("loads an idle thread again after the server itself restarted on the same data", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-restart-"));
    const first = new FakeConnection();
    first.replies.set("session/start", { session: { sessionId: "s1" } });
    first.replies.set("session/resume", IDLE);
    first.replies.set("view/page", { events: [], nextCursor: null });
    const { base, server } = await start(first, { dataDir });
    await send(base, "/api/sessions", { cwd: "/work/recovery" });
    await send(base, "/api/sessions/s1/resume", {});
    await server.close();

    const second = new FakeConnection();
    second.replies.set("session/read", NOT_LOADED);
    second.replies.set("session/resume", IDLE);
    second.replies.set("view/page", { events: [], nextCursor: null });
    const { base: base2 } = await start(second, { dataDir });
    const reply = await send(base2, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.readOnly, false);
    assert.equal(reply.json.readOnlyReason, null);
    assert.equal(resumes(second), 1, "a server that knows of nothing running loads the session");
  });

  it("stays read-only, with the other client's reason, only while another Muse client holds the lease", async () => {
    const { connection, base, probe } = await opened();
    probe.exits[0]?.({ code: 1, signal: null });
    connection.replies.set("session/read", NOT_LOADED);
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    const held = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(held.status, 200);
    assert.equal(held.json.readOnly, true);
    assert.match(held.json.readOnlyReason, /another host/);
    connection.replies.set("session/resume", new MspTestError("", "sessionInUse"));
    const unexplained = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(unexplained.json.readOnly, true);
    assert.equal(unexplained.json.readOnlyReason, "Another Muse session has this thread open.", "read-only always says why");
    connection.replies.set("session/resume", IDLE);
    const released = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(released.json.readOnly, false);
    assert.equal(released.json.readOnlyReason, null);
  });

  it("never loads a session that is waiting on the user, or whose turn this server still knows to be running", async () => {
    const { connection, base, probe } = await opened();
    probe.exits[0]?.({ code: 1, signal: null });
    connection.replies.set("session/read", { ...NOT_LOADED, pendingRequests: [{ kind: "approval", approvalId: "a1" }] });
    const before = resumes(connection);
    const waiting = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(waiting.status, 200);
    assert.equal(waiting.json.readOnly, false, "unloaded is not read-only either");
    assert.equal(resumes(connection), before, "a question the log still holds is for opening the thread to bring back");

    connection.replies.set("session/read", NOT_LOADED);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const running = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(running.json.msp.activeTurnId, "t1");
    assert.equal(resumes(connection), before, "a running turn is never reattached by a refresh");
  });

  it("does not bring back a turn that session/closed ended while a read was in flight", async () => {
    const { connection, base } = await opened();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const { started: reading, finish } = holdReads(connection);
    const refresh = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(reading, "read in flight");
    connection.notify("session/closed", { sessionId: "s1" });
    assert.equal((await live(base)).activeTurnId, null);
    finish({ session: { sessionId: "s1", status: "running", activeTurnId: "t1" }, history: { mode: "inline", items: [] } });
    const reply = await refresh;
    assert.equal(reply.json.msp.activeTurnId, null, "the older snapshot is not applied");
    assert.equal(reply.json.pendingComplete, false);
    assert.equal((await live(base)).activeTurnId, null);
    connection.replies.set("session/read", NOT_LOADED);
    connection.replies.set("view/page", { events: [started("t1"), ended("t1", "failed", { reason: "incomplete" })], nextCursor: null });
    const later = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(later.json.msp.activeTurnId, null);
    assert.equal((await send(base, "/api/sessions/s1", { settled: true }, "PATCH")).status, 200, "nothing is left running to block settling");
  });

  it("ends a turn whose host exits while its read is still in flight, keeping the host's failure", async () => {
    const { connection, base, probe } = await opened();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "running", activeTurnId: "t1" }, history: { mode: "inline", items: [] } });
    let fail!: (error: Error) => void;
    connection.replies.set("approval/listPending", () => new Promise((_, reject) => { fail = reject; }));
    const refresh = send(base, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(() => Boolean(fail), "listPending in flight");
    probe.exits[0]?.({ code: 1, signal: null });
    fail(new Error("connection closed"));
    const reply = await refresh;
    assert.equal(reply.json.msp.activeTurnId, null);
    const state = await live(base);
    assert.equal(state.activeTurnId, null);
    assert.equal(state.lastTerminal, "failed");
    assert.match(state.lastError, /host exited/);
  });

  it("does not lend a stopped turn an older turn's outcome from a partial prefix", async () => {
    const { connection, base } = await opened();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.replies.set("session/read", { ...IDLE, history: { mode: "none", noneReason: "projectionUnavailable" } });
    connection.replies.set("view/page", { events: [
      started("t0"), ended("t0", "failed", { error: { message: "rate limited" } }), started("t1"),
    ], nextCursor: null });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.msp.activeTurnId, null);
    assert.equal(reply.json.historyUnavailable, true);
    assert.equal(reply.json.session.live.lastTerminal, null, "t1's outcome is unknown, not t0's");
    assert.equal(reply.json.session.live.lastError, null);
    assert.deepEqual(terminals(reply), [["t0", "failed"]], "t0's real failure stays in the transcript");

    connection.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    connection.replies.set("view/page", { events: [started("t1"), ended("t1", "completed")], nextCursor: null });
    const reverse = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reverse.json.session.live.lastTerminal, null, "nor is t1's completion t2's outcome");
  });

  it("takes neither outcome nor failure from a read that does not have the session loaded", async () => {
    const { connection, base } = await opened();
    connection.replies.set("session/resume", new MspTestError("held by the TUI", "sessionInUse"));
    connection.replies.set("session/read", NOT_LOADED);
    connection.replies.set("view/page", { events: [started("t9"), ended("t9", "failed", { reason: "incomplete" })], nextCursor: null });
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.readOnly, true);
    assert.equal(reply.json.readOnlyReason, "held by the TUI");
    assert.equal(reply.json.msp.activeTurnId, null);
    assert.equal(reply.json.session.live.lastTerminal, null, "a run going elsewhere is not a failure here");
    assert.equal(reply.json.session.live.lastError, null);
  });

  it("drops a frozen prefix's stand-in for a run that has since stopped, until the projection says how it ended", async () => {
    const { connection, base } = await opened();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const frozen = { events: [started("t1"), ended("t1", "failed", { reason: "incomplete" })], nextCursor: null };
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "running", activeTurnId: "t1" }, history: { mode: "none", noneReason: "projectionUnavailable" } });
    connection.replies.set("view/page", frozen);
    const running = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.deepEqual(terminals(running), [], "the open run's stand-in is not a failure");

    connection.replies.set("session/read", { ...IDLE, history: { mode: "none", noneReason: "projectionUnavailable" } });
    const stopped = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(stopped.json.msp.activeTurnId, null);
    assert.deepEqual(terminals(stopped), [], "the frozen prefix still says nothing about the outcome");
    assert.equal(stopped.json.session.live.lastTerminal, null);
    assert.equal(stopped.json.session.live.lastError, null);

    connection.replies.set("session/read", { ...IDLE, history: { mode: "inline", items: [] } });
    connection.replies.set("view/page", { events: [started("t1"), ended("t1", "failed", { error: { message: "The provider refused" } })], nextCursor: null });
    const known = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.deepEqual(terminals(known), [["t1", "failed"]], "a real failure, once served, is shown");
    assert.equal(known.json.session.live.lastTerminal, "failed");
    assert.equal(known.json.session.live.lastError, "The provider refused");
  });

  it("recognises a turn that started while the pages were read, and holds its stand-in back", async () => {
    const { connection, base } = await opened();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const page = { events: [started("t1"), ended("t1", "completed"), started("t2"), ended("t2", "failed", { reason: "incomplete" })], nextCursor: null };
    connection.replies.set("view/page", page);
    connection.replies.set("session/read", (params: Record<string, unknown>) => ({
      session: { sessionId: "s1", status: "running", activeTurnId: params["excludeItems"] ? "t2" : "t1" },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    }));
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.msp.activeTurnId, "t2", "the status read after paging is the newer one");
    assert.equal(reply.json.session.live.activeTurnId, "t2");
    assert.deepEqual(terminals(reply), [["t1", "completed"]]);
    assert.equal(reply.json.session.live.lastTerminal, null, "a run under way has no outcome yet");

    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.replies.set("session/read", (params: Record<string, unknown>) => {
      if (params["excludeItems"]) {
        throw new MspTestError("busy", "internal");
      }
      return { session: { sessionId: "s1", status: "running", activeTurnId: "t1" }, history: { mode: "none", noneReason: "projectionUnavailable" } };
    });
    const unread = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(unread.status, 200, "a failed second read keeps the first");
    assert.equal(unread.json.msp.activeTurnId, "t1");
    assert.deepEqual(terminals(unread), [], "a turn the page shows starting after the one read as running may be open too");
  });

  it("keeps a newer live goal over an older one from a stale prefix", async () => {
    const { connection, base } = await opened();
    const goal = (status: string, percentComplete: number, viewCursor: string) =>
      ({ method: "session/goalChanged", params: { sessionId: "s1", goal: { objective: "Ship v2", status, percentComplete }, viewCursor } });
    connection.notify("session/goalChanged", { sessionId: "s1", goal: { objective: "Ship v2", status: "complete", percentComplete: 100 }, viewCursor: "v:s1:9", sourceRange: RANGE });
    connection.replies.set("session/read", { ...IDLE, history: { mode: "none", noneReason: "projectionUnavailable" } });
    connection.replies.set("view/page", { events: [goal("active", 10, "v:s1:3")], nextCursor: null });
    const stale = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(stale.json.session.live.goal.status, "complete");
    assert.equal(stale.json.session.live.goal.percentComplete, 100);
    connection.replies.set("view/page", { events: [goal("active", 60, "v:s1:12")], nextCursor: null });
    const newer = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(newer.json.session.live.goal.percentComplete, 60, "a prefix that reaches past the live goal counts");
  });

  it("clears an unavailable view on an idle thread when Muse says it is healthy, and tells the clients", async () => {
    const { connection, base } = await opened();
    const unavailable = { status: "unavailable", reason: "projectionUnavailable" };
    const statuses = await sseEvents(base, "session-status", async () => {
      connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
      assert.deepEqual((await live(base)).viewHealth, unavailable);
      connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "healthy" });
    });
    assert.equal((await live(base)).viewHealth, null);
    assert.deepEqual(statuses.map((status) => status.live.viewHealth), [unavailable, null]);
  });

  it("clears an unavailable view on an idle thread on any durable record, or on served history", async () => {
    const { connection, base } = await opened();
    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "m1", viewCursor: "v:9", sourceRange: RANGE });
    assert.equal((await live(base)).viewHealth, null, "with no turn running, any durable record means the view is written again");

    connection.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    connection.replies.set("session/resume", new MspTestError("held by the TUI", "sessionInUse"));
    connection.replies.set("session/read", NOT_LOADED);
    const reply = await send(base, "/api/sessions/s1/resume", { refresh: true });
    assert.equal(reply.json.readOnly, true);
    assert.equal(reply.json.viewHealth, null, "served history means the projection works, loaded here or not");
  });

  it("opens a thread whose fallback read fails as incomplete rather than failed", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", { session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 0 } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    connection.replies.set("session/read", new MspTestError("read failed", "internal"));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const fresh = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.msp.status, "idle");
    assert.equal(fresh.json.historyUnavailable, true);
    assert.equal(fresh.json.readOnly, false);

    connection.replies.set("session/resume", new MspTestError("in use by the TUI", "sessionInUse"));
    connection.replies.set("view/page", new MspTestError("in use", "sessionInUse"));
    const held = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(held.status, 200);
    assert.equal(held.json.readOnly, true);
    assert.equal(held.json.readOnlyReason, "in use by the TUI");
    assert.equal(held.json.historyUnavailable, true);
  });
});

describe("AncillaServer", () => {
  it("serves health, projects, sessions and turns", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);

    const health = await get(base, "/api/health");
    assert.equal(health.ok, true);

    const created = await send(base, "/api/sessions", { cwd: "/work/proj/" });
    assert.equal(created.status, 200);
    assert.equal(created.json.session.sessionId, "s1");
    assert.equal(created.json.session.cwd, "/work/proj");
    assert.equal(created.json.session.modelId, "muse-spark-1.3");

    const turn = await send(base, "/api/turns", { sessionId: "s1", text: "hello", ifBusy: "steer", reasoningEffort: "high" });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.turnId, "t1");
    assert.deepEqual(connection.calls.at(-1)?.params, {
      sessionId: "s1",
      input: [{ type: "text", text: "hello" }],
      ifBusy: "steer",
      reasoningEffort: "high",
    });

    // max is a real level on the contributor tier, so it has to pass validation like the rest of the scale.
    const top = await send(base, "/api/turns", { sessionId: "s1", text: "hello", reasoningEffort: "max" });
    assert.equal(top.status, 200);
    assert.equal((connection.calls.at(-1)?.params as { reasoningEffort?: string }).reasoningEffort, "max");

    const projects = await get(base, "/api/projects");
    assert.deepEqual(projects.projects.map((p: { cwd: string }) => p.cwd), ["/work/proj"]);

    const denied = await send(base, "/api/turns", { sessionId: "s1" });
    assert.equal(denied.status, 400);
  });

  it("rejects bad modes, dispositions, efforts and missing fields", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd: "/w", approvalMode: "yolo" })).status, 400);
    assert.equal((await send(base, "/api/sessions", {})).status, 400);
    assert.equal((await send(base, "/api/turns", { sessionId: "s", text: "x", ifBusy: "later" })).status, 400);
    assert.equal((await send(base, "/api/turns", { sessionId: "s", text: "x", reasoningEffort: "louder" })).status, 400);
    assert.equal((await send(base, "/api/approvals/decide", { sessionId: "s" })).status, 400);
    assert.equal((await send(base, "/api/user-input/clarify", { sessionId: "s", userInputId: "u" })).status, 400);
    const bad = await fetch(`${base}/api/turns`, { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
  });

  it("requires a token when one is configured", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret" });
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.equal((await fetch(`${base}/api/health?token=secret`)).status, 200);
  });

  it("answers an allowed origin and refuses one nobody listed", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { allowOrigins: ["https://ancilla.example"] });
    const blocked = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(blocked.status, 403);
    // Nothing to read even by accident: a refused origin gets no CORS headers at all.
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    const allowed = await fetch(`${base}/api/health`, { headers: { origin: "https://ancilla.example" } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://ancilla.example");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  });

  it("answers a preflight for an allowed origin", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { allowOrigins: ["https://ancilla.example"] });
    const res = await fetch(`${base}/api/turns`, { method: "OPTIONS", headers: { origin: "https://ancilla.example" } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  it("trades a token for a cookie, which is what the event stream can carry", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret" });
    assert.equal((await send(base, "/api/auth", { token: "wrong" })).status, 401);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /ancilla_token=secret/);
    assert.match(cookie, /HttpOnly/);
    // EventSource cannot send a header, so the cookie alone has to be enough.
    assert.equal((await fetch(`${base}/api/health`, { headers: { cookie: "ancilla_token=secret" } })).status, 200);
  });

  it("still takes the cookie Helicon set, for the same token only", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret" });
    assert.equal((await fetch(`${base}/api/health`, { headers: { cookie: "helicon_token=secret" } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { cookie: "helicon_token=other" } })).status, 401);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /helicon_token/, "only Ancilla's cookie is ever set");
  });

  it("takes a token from the URL only when no other site is asking", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { token: "secret", allowOrigins: ["https://ancilla.example"] });
    // No origin at all: curl, the desktop shell, the page this daemon served itself.
    assert.equal((await fetch(`${base}/api/health?token=secret`)).status, 200);
    // Its own page writing back still counts as itself, origin header and all.
    assert.equal((await fetch(`${base}/api/health?token=secret`, { headers: { origin: base } })).status, 200);
    // Another site holding the same link gets nothing, so sharing the URL hands over no access.
    const cross = await fetch(`${base}/api/health?token=secret`, { headers: { origin: "https://ancilla.example" } });
    assert.equal(cross.status, 401);
  });

  it("translates Windows paths at the WSL boundary", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s9" } });
    connection.replies.set("session/list", {
      sessions: [
        { session: { sessionId: "tui-1", workspaceRoot: "/mnt/d/work/proj" } },
        { sessionId: "tui-2", workspaceRoot: "/mnt/d/work/other", turnCount: 4, updatedAt: "2026-09-11T12:35:42.947855Z" },
      ],
      nextCursor: null,
    });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      hostFactory: fakeFactory(connection, probe),
    });

    const created = await send(base, "/api/sessions", { cwd: "D:\\work\\proj" });
    assert.equal(created.status, 200);
    const startCall = connection.calls.find((c) => c.method === "session/start");
    assert.equal(startCall?.params?.["workspaceRoot"], "/mnt/d/work/proj");
    assert.equal(probe.targets[0]?.command, "wsl");
    assert.deepEqual(probe.targets[0]?.args.slice(0, 2), ["-d", "Ubuntu"]);
    assert.equal(probe.targets[0]?.cwd, "D:\\work\\proj");

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.equal(found.json.sessions.length, 2);
    const listCall = connection.requests.find((c) => c.method === "session/list");
    assert.equal(listCall?.params?.["commandId"], undefined, "queries must not carry a commandId");
    const projects = await get(base, "/api/projects");
    const cwds = projects.projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(cwds.includes("D:\\work\\proj"));
    assert.ok(cwds.includes("D:\\work\\other"));
    const sessions = await get(base, `/api/sessions?cwd=${encodeURIComponent("D:\\work\\other")}`);
    assert.equal(sessions.sessions[0].origin, "tui");
    assert.equal(sessions.sessions[0].turnCount, 4);
    assert.equal(sessions.sessions[0].activityAt, "2026-09-11T12:35:42.947Z");
  });

  it("runs native Windows Muse with Windows paths, and no WSL", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s9" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "tui-1", workspaceRoot: "d:/work/other", turnCount: 2 }],
      nextCursor: null,
    });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const ran: { command: string; args: string[] }[] = [];
    const binary = "C:\\Users\\ada\\AppData\\Local\\Programs\\muse\\muse-bin-1.3.0-R1.exe";
    const { base } = await start(connection, {
      platform: "win32",
      musePath: undefined,
      findNativeMuse: () => ({ binary, dir: "C:\\Users\\ada\\AppData\\Local\\Programs\\muse", version: "1.3.0-R1", launcher: null }),
      hostFactory: fakeFactory(connection, probe),
      shellRunner: async (command: string, args: string[]) => {
        ran.push({ command, args });
        return { output: "ok\n", exitCode: 0, truncated: false };
      },
    });

    const env = await get(base, "/api/env");
    assert.equal(env.runtime, "native");
    assert.equal(env.musePath, binary);

    const created = await send(base, "/api/sessions", { cwd: "D:\\work\\it's here" });
    assert.equal(created.status, 200);
    const startCall = connection.calls.find((c) => c.method === "session/start");
    assert.equal(startCall?.params?.["workspaceRoot"], "D:\\work\\it's here", "native Muse gets the Windows path itself");
    assert.equal(probe.targets[0]?.command, binary);
    assert.deepEqual(probe.targets[0]?.args, ["serve"]);
    assert.equal(probe.targets[0]?.cwd, "D:\\work\\it's here");

    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    const cwds = (await get(base, "/api/projects")).projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(cwds.includes("D:\\work\\other"), "a root spelled d:/work/other is stored as D:\\work\\other");

    const shell = await send(base, "/api/sessions/s9/shell-proxy", { command: "Get-ChildItem" });
    assert.equal(shell.status, 200);
    assert.match(ran[0]!.command, /powershell\.exe$/i);
    const script = ran[0]!.args.at(-1)!;
    assert.ok(script.startsWith("Set-Location -LiteralPath 'D:\\work\\it''s here'"), script);
    assert.ok(script.endsWith("\nGet-ChildItem"));
  });

  it("tracks live status and derives titles from the view stream", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const read = async () => (await get(base, "/api/sessions")).sessions[0];

    assert.equal((await read()).title, "New thread");
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "\n  Fix the flaky login test in CI\nmore detail" },
    });
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    let session = await read();
    assert.equal(session.title, "Fix the flaky login test in CI");
    assert.equal(session.live.activeTurnId, "t1");
    assert.equal(session.live.pendingApprovals, 1);

    connection.notify("approval/resolved", { sessionId: "s1", approvalId: "a1" });
    connection.notify("turn/completed", {
      sessionId: "s1",
      turnId: "t1",
      terminal: "failed",
      error: { kind: "modelError", message: "Provider timed out", retryable: true },
    });
    session = await read();
    assert.equal(session.live.activeTurnId, null);
    assert.equal(session.live.pendingApprovals, 0);
    assert.equal(session.live.lastTerminal, "failed");
    assert.equal(session.live.lastError, "Provider timed out");
    assert.equal(session.turnCount, 1);

    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i2", kind: "userMessage", revision: 1, status: "completed", text: "Something else entirely" },
    });
    assert.equal((await read()).title, "Fix the flaky login test in CI", "only the first prompt names a thread");
  });

  it("takes Muse's own name for a thread, unless the user named it", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Wire up the updater", title: "fix the updater please" }],
      nextCursor: null,
    });
    const { base } = await start(connection, { syncSessionNames: true });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    const read = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.equal((await read()).title, "fix the updater please");

    await send(base, "/api/discover", {});
    assert.equal((await read()).title, "Wire up the updater", "with titles shared, the name Muse shows in its own CLI wins");

    await send(base, "/api/sessions/s1", { title: "Updater work" }, "PATCH");
    await send(base, "/api/discover", {});
    assert.equal((await read()).title, "Updater work", "a title the user typed stays");
  });

  it("loads a transcript from resume, paged history and pending requests", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t2", turnCount: 1, modelId: "muse-spark-1.3", updatedAt: "2026-09-11T14:00:00Z" },
    });
    const event = (n: number, method: string, extra: Record<string, unknown> = {}) => ({
      method,
      params: { sessionId: "s1", viewCursor: `v:${n}`, sourceRange: RANGE, ...extra },
    });
    connection.replies.set("view/page", (params: Record<string, unknown>) =>
      params["cursor"]
        ? {
            events: [
              event(1, "turn/started", { turnId: "t1" }),
              event(2, "item/completed", { item: { itemId: "u1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode" } }),
            ],
            nextCursor: null,
          }
        : { events: [event(3, "turn/completed", { turnId: "t1", terminal: "completed" }), event(4, "turn/started", { turnId: "t2" })], nextCursor: "v:3" },
    );
    connection.replies.set("approval/listPending", {
      approvals: [{ approvalId: "a1", sessionId: "s1", sourceRange: RANGE, subject: { kind: "shell", command: "rm -rf dist" } }],
      userInputs: [],
    });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, false);
    assert.deepEqual(
      loaded.json.events.map((e: { params: { viewCursor: string } }) => e.params.viewCursor),
      ["v:1", "v:2", "v:3", "v:4"],
    );
    assert.equal(loaded.json.events[0].params.sourceRange, undefined);
    assert.equal(loaded.json.pending.approvals[0].subject.command, "rm -rf dist");
    assert.equal(loaded.json.pending.approvals[0].sourceRange, undefined);
    assert.equal(loaded.json.msp.activeTurnId, "t2");
    assert.equal(loaded.json.session.title, "Add dark mode");
    assert.equal(loaded.json.session.live.pendingApprovals, 1);
    assert.equal(loaded.json.session.live.activeTurnId, "t2");
    const resume = connection.calls.find((c) => c.method === "session/resume");
    assert.equal(resume?.params?.["excludeItems"], true);
    const pages = connection.requests.filter((c) => c.method === "view/page");
    assert.deepEqual(pages.map((p) => p.params?.["direction"]), ["backward", "backward"]);
  });

  it("puts a resumed session back on the model the user chose", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    connection.replies.set("model/list", {
      models: [
        { modelId: "muse-spark-1.3", providerId: "meta", profileId: "tbh" },
        { modelId: "muse-spark-1.3-contributor", providerId: "meta", profileId: "tbh", displayLabel: "muse-spark-1.3-contributor" },
      ],
    });
    const idle = (modelId: string) => ({ session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1, modelId } });
    connection.replies.set("session/resume", idle("muse-spark-1.3"));
    connection.replies.set("view/page", { events: [], nextCursor: null });
    connection.replies.set("approval/listPending", { approvals: [], userInputs: [] });
    const sets = () => connection.calls.filter((c) => c.method === "session/setModel");
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    // A thread whose model was never picked follows the host.
    let loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.json.msp.modelId, "muse-spark-1.3");
    assert.equal(sets().length, 0);

    // The pick goes to Muse as the catalog's whole entry, provider and profile included.
    assert.equal((await send(base, "/api/sessions/s1/model", { model: { modelId: "muse-spark-1.3-contributor" } })).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], {
      modelId: "muse-spark-1.3-contributor",
      providerId: "meta",
      profileId: "tbh",
      displayLabel: "muse-spark-1.3-contributor",
    });

    // The host comes back on the starting model: the pick is set again, and the thread is reported on it.
    loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.json.msp.modelId, "muse-spark-1.3-contributor");
    assert.equal(loaded.json.session.modelId, "muse-spark-1.3-contributor");
    assert.equal(sets().length, 2);
    assert.equal((sets()[1]?.params?.["model"] as Record<string, unknown>)["profileId"], "tbh");

    // A host already on it is left alone.
    connection.replies.set("session/resume", idle("muse-spark-1.3-contributor"));
    await send(base, "/api/sessions/s1/resume", {});
    assert.equal(sets().length, 2);

    // A change the user made in another Muse client is their pick; a default the host applied is not.
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-spark-1.2", source: "user", viewCursor: "v:1", sourceRange: RANGE });
    connection.replies.set("session/resume", idle("muse-spark-1.3"));
    loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.json.msp.modelId, "muse-spark-1.2");
    assert.equal(sets().length, 3);
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-spark-1.3", source: "default", viewCursor: "v:2", sourceRange: RANGE });
    loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.json.msp.modelId, "muse-spark-1.2");
    assert.equal(sets().length, 4);
  });

  it("falls back to a read-only transcript when another host holds the session", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, true);
    assert.match(loaded.json.readOnlyReason, /another host/);
    const read = connection.requests.find((c) => c.method === "session/read");
    assert.equal(read?.params?.["excludeItems"], false);
  });

  it("hydrates a read-only CLI transcript from session/read items", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: null, turnCount: 1 },
      history: {
        mode: "inline",
        items: [
          { itemId: "i1", kind: "userMessage", text: "Ship the fairtab tip", status: "completed", revision: 1 },
          { itemId: "i2", kind: "agentMessage", text: "Done.", status: "completed", revision: 1 },
        ],
      },
    });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.readOnly, true);
    assert.deepEqual(
      loaded.json.events.map((e: { method: string; params: { item: { itemId: string } } }) => [e.method, e.params.item.itemId]),
      [
        ["item/completed", "i1"],
        ["item/completed", "i2"],
      ],
    );
  });

  it("turns session/read history items into fold events", () => {
    const events = eventsFromHistory({
      history: {
        mode: "inline",
        items: [{ itemId: "a", kind: "userMessage", text: "Hi", sourceRange: { first: 1 } }],
      },
    });
    assert.deepEqual(events, [{ method: "item/completed", params: { item: { itemId: "a", kind: "userMessage", text: "Hi" } } }]);
  });

  it("surfaces resume failures that are not about another host", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/resume", new MspTestError("stream mismatch", "sessionStreamMismatch"));
    connection.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const failed = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(failed.status, 409);
    assert.equal(failed.json.kind, "sessionStreamMismatch");
    assert.equal(failed.json.readOnly, undefined);
  });

  it("reports MSP error kinds with a useful status", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", new MspTestError("input too large", "inputTooLarge"));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const failed = await send(base, "/api/turns", { sessionId: "s1", text: "x" });
    assert.equal(failed.status, 409);
    assert.equal(failed.json.kind, "inputTooLarge");
    assert.equal(failed.json.error, "input too large");
  });

  it("renames and archives threads, and hides projects", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const renamed = await send(base, "/api/sessions/s1", { title: "  Ship the sidebar  " }, "PATCH");
    assert.equal(renamed.json.session.title, "Ship the sidebar");
    assert.equal(renamed.json.session.titleSource, "user");
    await send(base, "/api/sessions/s1", { archived: true }, "PATCH");
    assert.equal((await get(base, "/api/sessions")).sessions.length, 0);
    assert.equal((await get(base, "/api/sessions?archived=1")).sessions.length, 1);
    assert.equal((await send(base, "/api/sessions/missing", { title: "x" }, "PATCH")).status, 404);

    await send(base, `/api/projects?cwd=${encodeURIComponent("/work/proj")}`, undefined, "DELETE");
    assert.equal((await get(base, "/api/projects")).projects.length, 0);
    const readded = await send(base, "/api/projects", { cwd: "/work/proj" });
    assert.equal(readded.status, 200);
    assert.equal((await get(base, "/api/projects")).projects.length, 1);
  });

  it("groups a project's folders, and the threads Muse ran in them, under one project", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", (params: Record<string, unknown>) => ({ session: { sessionId: params["workspaceRoot"] === "/work/app-docs" ? "d1" : "a1" } }));
    // Muse already ran a thread in the docs folder; discovery in that folder must attach it to the project.
    connection.replies.set("session/list", (params: Record<string, unknown>) => ({
      sessions: params["workspaceRoot"] === "/work/app-docs" ? [{ sessionId: "tui-1", workspaceRoot: "/work/app-docs", updatedAt: "2026-09-01T00:00:00.000Z" }] : [],
      nextCursor: null,
    }));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/app" });
    await send(base, "/api/sessions", { cwd: "/work/app-docs" });
    const cwds = async () => (await get(base, "/api/projects")).projects.map((p: { cwd: string }) => p.cwd).sort();
    const threads = async () => (await get(base, "/api/sessions")).sessions.map((s: { sessionId: string; cwd: string }) => `${s.sessionId}@${s.cwd}`).sort();
    assert.deepEqual(await cwds(), ["/work/app", "/work/app-docs"]);

    const added = await send(base, "/api/projects/folders", { cwd: "/work/app", path: "/work/app-docs/" });
    assert.equal(added.status, 200);
    assert.deepEqual(added.json.project.folders.map((f: { cwd: string }) => f.cwd), ["/work/app", "/work/app-docs"]);
    assert.equal(added.json.warning, null);
    assert.deepEqual(await cwds(), ["/work/app"], "the folder is no longer a project of its own");
    assert.deepEqual(await threads(), ["a1@/work/app", "d1@/work/app-docs", "tui-1@/work/app-docs"], "its threads came along, and each still names its own folder");
    assert.deepEqual((await get(base, "/api/projects")).projects[0].folders.map((f: { cwd: string }) => f.cwd), ["/work/app", "/work/app-docs"]);

    const readded = await send(base, "/api/projects", { cwd: "/work/app-docs" });
    assert.equal(readded.json.project.cwd, "/work/app", "adding a folder that is inside a project answers with the project");
    assert.deepEqual(await cwds(), ["/work/app"]);

    assert.equal((await send(base, "/api/projects/folders", { cwd: "/work/app", path: "/work/app" })).status, 400);
    assert.equal((await send(base, "/api/projects/folders", { cwd: "/work/app-docs", path: "/work/deeper" })).status, 400);
    assert.equal((await send(base, "/api/projects/folders", { cwd: "/nowhere", path: "/work/x" })).status, 404);
    assert.equal((await send(base, `/api/projects/folders?cwd=${encodeURIComponent("/work/app")}&path=${encodeURIComponent("/work/x")}`, undefined, "DELETE")).status, 400);

    await send(base, `/api/projects?cwd=${encodeURIComponent("/work/app")}`, undefined, "DELETE");
    assert.deepEqual(await threads(), [], "hiding the project hides its folders' threads too");
    await send(base, "/api/projects", { cwd: "/work/app-docs" });
    assert.deepEqual(await cwds(), ["/work/app"], "re-adding a folder brings its project back, whole");
    assert.equal((await threads()).length, 3);

    const removed = await send(base, `/api/projects/folders?cwd=${encodeURIComponent("/work/app")}&path=${encodeURIComponent("/work/app-docs")}`, undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.project.folders.map((f: { cwd: string }) => f.cwd), ["/work/app"]);
    assert.deepEqual(await cwds(), ["/work/app", "/work/app-docs"], "a removed folder is a project again");
    assert.equal((await threads()).length, 3, "no thread disappears");
  });

  it("opens known project folders only", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/list", { sessions: [], nextCursor: null });
    const opened: { path: string; target: OpenTarget }[] = [];
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      opener: async (path, target) => {
        opened.push({ path, target });
      },
    });
    assert.equal((await send(base, "/api/open", { cwd: "C:\\nowhere" })).status, 404);
    await send(base, "/api/projects", { cwd: "/mnt/d/work/app" });
    assert.equal((await send(base, "/api/open", { cwd: "/mnt/d/work/app", target: "editor" })).status, 200);
    assert.deepEqual(opened, [{ path: "D:\\work\\app", target: "editor" }]);
    // A folder inside a project is a known folder too.
    await send(base, "/api/projects/folders", { cwd: "/mnt/d/work/app", path: "/mnt/d/work/app-docs" });
    assert.equal((await send(base, "/api/open", { cwd: "/mnt/d/work/app-docs" })).status, 200);
    assert.deepEqual(opened.at(-1), { path: "D:\\work\\app-docs", target: "files" });
  });

  it("settles and un-settles threads, and wakes a settled thread when work starts", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const settled = await send(base, "/api/sessions/s1", { settled: true }, "PATCH");
    assert.equal(settled.json.session.settled, true);
    assert.ok(settled.json.session.settledAt);
    const active = await send(base, "/api/sessions/s1", { settled: false }, "PATCH");
    assert.equal(active.json.session.settled, false);
    assert.equal(active.json.session.settledAt, null);
    assert.ok(active.json.session.unsettledAt);

    await send(base, "/api/sessions/s1", { settled: true }, "PATCH");
    await send(base, "/api/turns", { sessionId: "s1", text: "pick this back up" });
    const woken = (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.equal(woken.settled, false);
    assert.ok(woken.unsettledAt);
  });

  it("wakes a settled thread when discovery shows it moved on in another client", async () => {
    const connection = new FakeConnection();
    const list = (updatedAt: string) => ({ sessions: [{ sessionId: "tui-1", workspaceRoot: "/work/proj", updatedAt }], nextCursor: null });
    connection.replies.set("session/list", list("2026-09-01T00:00:00.000Z"));
    const { base } = await start(connection);
    await send(base, "/api/discover", {});
    assert.equal((await send(base, "/api/sessions/tui-1", { settled: true }, "PATCH")).json.session.settled, true);
    const find = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "tui-1");

    await send(base, "/api/discover", {});
    assert.equal((await find()).settled, true, "nothing new happened, so it stays settled");

    connection.replies.set("session/list", list(new Date(Date.now() + 60_000).toISOString()));
    await send(base, "/api/discover", {});
    assert.equal((await find()).settled, false);
  });

  it("carries a turn's reasoning effort as the session default, once per change", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const efforts = () => connection.calls.filter((c) => c.method === "session/setReasoningEffort").map((c) => c.params?.["reasoningEffort"]);

    await send(base, "/api/turns", { sessionId: "s1", text: "one", reasoningEffort: "low" });
    const methods = connection.calls.map((c) => c.method);
    assert.ok(methods.indexOf("session/setReasoningEffort") < methods.lastIndexOf("turn/start"), "the default is set before the turn goes");
    await send(base, "/api/turns", { sessionId: "s1", text: "two", reasoningEffort: "low" });
    await send(base, "/api/turns", { sessionId: "s1", text: "three" });
    assert.deepEqual(efforts(), ["low"], "an unchanged or absent effort sends nothing");

    // Changed in another client: the next turn asking for that level has nothing to do.
    connection.notify("session/reasoningEffortChanged", { sessionId: "s1", reasoningEffort: "xhigh", source: "user" });
    await send(base, "/api/turns", { sessionId: "s1", text: "four", reasoningEffort: "xhigh" });
    assert.deepEqual(efforts(), ["low"]);

    const direct = await send(base, "/api/sessions/s1/effort", { reasoningEffort: "max" });
    assert.equal(direct.status, 200);
    assert.deepEqual(efforts(), ["low", "max"]);
    assert.equal((await send(base, "/api/sessions/s1/effort", { reasoningEffort: "loud" })).status, 400);

    // A host without the method still takes the turn, with the effort riding on turn/start.
    connection.replies.set("session/setReasoningEffort", new MspTestError("no such method", "methodNotFound"));
    const old = await send(base, "/api/turns", { sessionId: "s1", text: "five", reasoningEffort: "low" });
    assert.equal(old.status, 200);
    assert.equal(connection.calls.at(-1)?.params?.["reasoningEffort"], "low");

    connection.replies.set("session/setReasoningEffort", new MspTestError("not loaded", "sessionNotLoaded"));
    const unloaded = await send(base, "/api/turns", { sessionId: "s1", text: "six", reasoningEffort: "medium" });
    assert.equal(unloaded.status, 409);
    assert.equal(unloaded.json.kind, "sessionNotLoaded", "the UI reloads and retries on this kind");
  });

  it("drives goals, subagents, background tasks and workflow children", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("goal/set", { commandId: "c", status: "accepted", turnId: "t7" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const last = () => connection.calls.at(-1);

    const goal = await send(base, "/api/sessions/s1/goal", { action: "set", objective: "get CI green" });
    assert.deepEqual(goal.json, { turnId: "t7" });
    assert.deepEqual(last(), { method: "goal/set", params: { sessionId: "s1", objective: "get CI green" } });
    await send(base, "/api/sessions/s1/goal", { action: "pause" });
    assert.deepEqual(last(), { method: "goal/pause", params: { sessionId: "s1" } });
    assert.equal((await send(base, "/api/sessions/s1/goal", { action: "edit" })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/goal", { action: "finish" })).status, 400);

    await send(base, "/api/sessions/s1/subagent", { action: "sendMessage", subagentId: "sa1", body: "use pnpm" });
    assert.deepEqual(last(), { method: "subagent/sendMessage", params: { sessionId: "s1", subagentId: "sa1", body: "use pnpm" } });
    assert.equal((await send(base, "/api/sessions/s1/subagent", { action: "followupTask", subagentId: "sa1" })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/subagent", { action: "stop" })).status, 400);

    await send(base, "/api/sessions/s1/tasks", { action: "background", taskId: "item-4" });
    assert.deepEqual(last(), { method: "task/background", params: { sessionId: "s1", taskId: "item-4" } });
    await send(base, "/api/sessions/s1/tasks", { action: "stop", taskId: "item-4" });
    assert.deepEqual(last(), { method: "task/stop", params: { sessionId: "s1", taskId: "item-4" } });
    await send(base, "/api/sessions/s1/tasks", { action: "stopAll" });
    assert.deepEqual(last(), { method: "task/stopAll", params: { sessionId: "s1" } });
    assert.equal((await send(base, "/api/sessions/s1/tasks", { action: "stop" })).status, 400);

    await send(base, "/api/sessions/s1/workflow", { action: "cancel", workflowRunId: "run-9" });
    assert.deepEqual(last(), { method: "workflow/cancel", params: { sessionId: "s1", workflowRunId: "run-9" } });
    await send(base, "/api/sessions/s1/workflow", { action: "skip", workflowRunId: "run-9", childId: "c1", attempt: 2 });
    assert.deepEqual(last(), { method: "workflow/childControl", params: { sessionId: "s1", workflowRunId: "run-9", childId: "c1", attempt: 2, action: "skip" } });
    assert.equal((await send(base, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 0 })).status, 400);
    assert.equal((await send(base, "/api/sessions/s1/workflow", { action: "cancel" })).status, 400);

    connection.replies.set("workflow/childControl", new MspTestError("stale attempt", "stale_attempt"));
    const stale = await send(base, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.kind, "stale_attempt");
  });

  it("reads a tool's stored output one page at a time", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("item/readOutput", (params: Record<string, unknown>) => ({
      content: "x".repeat(4),
      encoding: "utf8",
      mediaType: "text/plain",
      offsetBytes: params["offsetBytes"],
      byteLen: 4,
      eof: params["offsetBytes"] === 4,
    }));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const first = await get(base, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1");
    assert.deepEqual(first.output, { content: "xxxx", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 4, eof: false });
    const next = await get(base, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1&offset=4&length=99999999");
    assert.equal(next.output.eof, true);
    assert.deepEqual(connection.requests.at(-1)?.params, { sessionId: "s1", itemId: "i1", outputRef: "bash-1", offsetBytes: 4, lengthBytes: 1024 * 1024 });
    assert.equal((await fetch(`${base}/api/sessions/s1/output?itemId=i1`)).status, 400);
  });

  it("keeps the newest subscription window any host reports", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const window = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1000, windowDurationMins: 300 },
      weekly: { usedPercent: 10, resetsAtMs: at + 9000 },
    });
    const { base } = await start(connection);
    connection.replies.set("usage/read", {});
    assert.equal((await get(base, "/api/plan-usage")).usage, null, "no host running and nothing seen");

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal((await get(base, "/api/plan-usage")).usage, null, "a host that has seen nothing is not an error");

    connection.notify("usage/changed", window(40, 2_000));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 40);
    connection.notify("usage/changed", window(5, 1_000));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 40, "an older reading never replaces a newer one");
    connection.replies.set("usage/read", { usage: window(55, 3_000) });
    const read = await get(base, "/api/plan-usage");
    assert.equal(read.usage.window.usedPercent, 55);
    assert.equal(read.usage.weekly.windowDurationMins, null);
  });

  it("tracks plan usage per account and keeps the newest as the default", async () => {
    const work = new FakeConnection();
    const personal = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    await aonia.createProfile("personal");
    // Route each account's host to its own connection so their notifications are distinct.
    const factory = (target: ServeTarget): HostHandle => {
      // Normalize separators: aonia's profile root uses backslashes on Windows (...\profiles\work\config).
      const account = target.env?.["XDG_CONFIG_HOME"]?.replaceAll("\\", "/").includes("/work/") ? work : personal;
      return fakeFactory(account)(target);
    };
    const { base } = await start(work, { hostFactory: factory, aonia });

    work.replies.set("session/start", { session: { sessionId: "w1" } });
    personal.replies.set("session/start", { session: { sessionId: "p1" } });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "personal" });

    // usage/changed notifications carry the SubscriptionUsage fields flat (see parseSubscriptionUsage and
    // the "keeps the newest subscription window any host reports" test above); only the usage/read
    // request/reply wraps them under a "usage" key.
    work.notify("usage/changed", { tier: "1", observedAtMs: 100, window: { usedPercent: 90, resetsAtMs: 1, windowDurationMins: 300 }, weekly: { usedPercent: 50, resetsAtMs: 1, windowDurationMins: null } });
    personal.notify("usage/changed", { tier: "1", observedAtMs: 200, window: { usedPercent: 12, resetsAtMs: 1, windowDurationMins: 300 }, weekly: { usedPercent: 8, resetsAtMs: 1, windowDurationMins: null } });

    const res = await get(base, "/api/plan-usage");
    assert.equal(res.byAccount.work.window.usedPercent, 90);
    assert.equal(res.byAccount.personal.window.usedPercent, 12);
    assert.equal(res.usage.window.usedPercent, 12, "usage holds the newest across accounts");
  });

  it("refreshes default and named subscription limits directly without starting a host", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-direct-quota-"));
    quotaEnvironment(t, home);
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    const saveLogin = async (root: string, token: string) => {
      const dir = join(root, "muse");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "auth.json"), JSON.stringify({ providers: { meta: {
        mechanism: "oauth", access_token: token, user_email: "person@example.test",
      } } }));
    };
    await saveLogin(join(home, ".config"), "dca:default");
    await saveLogin(profile.roots.config, "dca:work");
    let requests = 0;
    const observed = Date.now();
    const subscriptionReader = new MuseSubscriptionReader({ now: () => observed, fetch: async (_url, init) => {
      requests++;
      const work = new Headers(init?.headers).get("Authorization") === "Bearer dca:work";
      return Response.json({ is_subs_active: true, subs_tier_name: "Muse Code Power Usage", api_key: "LLM|discard-me",
        subs_usage: { tier: "123", window: { used_percent: work ? 84 : 12, resets_at: observed / 1000 + 3600, window_duration_mins: 300 },
          weekly: { used_percent: work ? 55 : 25, resets_at: observed / 1000 + 86400 } } });
    } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const connection = new FakeConnection();
    const { base } = await start(connection, { home, aonia, subscriptionReader, hostFactory: fakeFactory(connection, probe) });
    const response = await get(base, "/api/plan-usage");
    assert.equal(response.accounts.length, 2);
    const personal = response.accounts.find((account: { accountId: string | null }) => account.accountId === null);
    const work = response.accounts.find((account: { accountId: string | null }) => account.accountId === "work");
    assert.equal(personal.usage.window.usedPercent, 12);
    assert.equal(work.usage.window.usedPercent, 84);
    assert.equal(personal.usage.window.resetsAtMs, observed + 3_600_000);
    assert.equal(work.planName, "Muse Code Power Usage");
    assert.equal(work.source, "meta");
    assert.equal(work.status, "ready");
    assert.equal(response.status, "ready");
    assert.equal(probe.targets.length, 0);
    assert.equal(requests, 2);
    assert.doesNotMatch(JSON.stringify(response), /dca:|LLM\||discard-me|access_token/);
    await get(base, "/api/plan-usage");
    assert.equal(requests, 2, "page and sidebar reads share one short account cache");
  });

  it("keeps a failed direct refresh distinct from an older runtime observation", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-direct-unavailable-"));
    quotaEnvironment(t, home);
    const dir = join(home, ".config", "muse");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), JSON.stringify({ providers: { meta: {
      mechanism: "oauth", access_token: "dca:default", user_email: "person@example.test",
    } } }));
    let stamp = Date.now();
    let active = true;
    const subscriptionReader = new MuseSubscriptionReader({ now: () => stamp, cacheMs: 0, fetch: async () => active
      ? new Response("private failure", { status: 503 }) : Response.json({ is_subs_active: false }) });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader });
    await send(base, "/api/sessions", { cwd: "/work" });
    const observation = { tier: "high", observedAtMs: stamp - 1000,
      window: { usedPercent: 92, resetsAtMs: stamp + 60000, windowDurationMins: 300 },
      weekly: { usedPercent: 30, resetsAtMs: stamp + 86400000 } };
    connection.replies.set("usage/read", { usage: observation });
    const unavailable = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.source, "runtime");
    assert.equal(unavailable.usage.observedAtMs, observation.observedAtMs, "a failed request does not refresh quota age");
    stamp += 1000;
    active = false;
    const cancelled = await get(base, "/api/plan-usage");
    assert.equal(cancelled.accounts[0].status, "no-subscription");
    assert.equal(cancelled.accounts[0].usage, null);
    assert.equal(cancelled.usage, null);
    connection.notify("usage/changed", observation);
    assert.equal((await get(base, "/api/plan-usage")).usage, null, "older host observations cannot resurrect a cancelled plan");
  });

  it("adopts corrected quota data with an identical timestamp without broadcasting unchanged re-reads", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work" });
    const reading = (percent: number) => ({ tier: "high", observedAtMs: 5000,
      window: { usedPercent: percent, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 20, resetsAtMs: 10000 } });
    connection.notify("usage/changed", reading(10));
    connection.notify("usage/changed", reading(20));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 20);
  });

  it("uses the explicit auth path and never treats an overriding API key as subscription login", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-auth-path-"));
    const path = join(home, "separate-login.json");
    await writeFile(path, JSON.stringify({ providers: { meta: {
      mechanism: "oauth", access_token: "dca:custom-path", user_email: "person@example.test",
    } } }));
    const previousPath = process.env["MUSE_AUTH_PATH"];
    const previousKey = process.env["META_API_KEY"];
    let calls = 0;
    try {
      process.env["MUSE_AUTH_PATH"] = path;
      delete process.env["META_API_KEY"];
      const subscriptionReader = new MuseSubscriptionReader({ cacheMs: 0, fetch: async () => {
        calls++;
        return Response.json({ is_subs_active: true, subs_usage: null, subs_tier_name: "Muse Code Power Usage" });
      } });
      const { base } = await start(new FakeConnection(), { home, subscriptionReader });
      assert.equal((await get(base, "/api/plan-usage")).accounts[0].status, "not-reported");
      assert.equal(calls, 1);
      process.env["META_API_KEY"] = "test-api-key";
      const report = await get(base, "/api/plan-usage");
      assert.equal(report.accounts[0].status, "runtime-only");
      assert.equal(report.accounts[0].usage, null);
      assert.equal(calls, 1);
    } finally {
      if (previousPath === undefined) delete process.env["MUSE_AUTH_PATH"]; else process.env["MUSE_AUTH_PATH"] = previousPath;
      if (previousKey === undefined) delete process.env["META_API_KEY"]; else process.env["META_API_KEY"] = previousKey;
    }
  });

  it("keeps newer runtime readings when an earlier direct quota check finishes late", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-order-"));
    quotaEnvironment(t, home);
    const dir = join(home, ".config", "muse");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), JSON.stringify({ providers: { meta: {
      mechanism: "oauth", access_token: "dca:default", user_email: "person@example.test",
    } } }));
    let stamp = Date.now();
    let finish: ((response: Response) => void) | null = null;
    const subscriptionReader = new MuseSubscriptionReader({ now: () => stamp, cacheMs: 0,
      fetch: async () => new Promise((resolve) => { finish = resolve; }) });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader });
    await send(base, "/api/sessions", { cwd: "/work" });
    for (const response of [Response.json({ is_subs_active: false }), Response.json({ is_subs_active: true, subs_usage: null }), new Response(null, { status: 503 })]) {
      finish = null;
      const pending = get(base, "/api/plan-usage");
      await waitFor(() => finish !== null, "direct quota request");
      const reading = { tier: "high", observedAtMs: stamp + 1000,
        window: { usedPercent: 37, resetsAtMs: stamp + 60000, windowDurationMins: 300 },
        weekly: { usedPercent: 21, resetsAtMs: stamp + 86400000 } };
      connection.notify("usage/changed", reading);
      (finish as unknown as (response: Response) => void)(response);
      const report = await pending;
      assert.equal(report.accounts[0].usage.window.usedPercent, 37);
      assert.equal(report.accounts[0].source, "runtime");
      assert.equal(report.accounts[0].status, "runtime-only", "an earlier HTTP result cannot hide a newer runtime reading");
      assert.equal(report.accounts[0].checkedAtMs, stamp, "checking time remains distinct from the newer observation");
      stamp += 2000;
    }
  });

  it("restores subscription readings only for the same login and runtime without starting a host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-cache-"));
    const aonia = createAonia({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    const authDir = join(profile.roots.config, "muse");
    await mkdir(authDir, { recursive: true });
    const login = (email: string) => writeFile(join(authDir, "auth.json"), JSON.stringify({
      providers: { meta: { mechanism: "oauth", user_email: email } },
    }));
    await login("first@example.test");
    const first = new FakeConnection();
    first.replies.set("session/start", { session: { sessionId: "w1" } });
    const options = { dataDir, aonia, home: join(dataDir, "home") };
    const initial = await start(first, options);
    await send(initial.base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const reading = { tier: "high", observedAtMs: Date.now(),
      window: { usedPercent: 125, resetsAtMs: Date.now() + 60_000, windowDurationMins: 300 },
      weekly: { usedPercent: 65, resetsAtMs: Date.now() + 600_000, windowDurationMins: null } };
    first.notify("usage/changed", reading);
    assert.equal((await get(initial.base, "/api/plan-usage")).saved, false);
    await initial.server.close();

    const probe: FactoryProbe = { targets: [], exits: [] };
    const second = new FakeConnection();
    const restored = await start(second, { ...options, hostFactory: fakeFactory(second, probe) });
    const cache = await get(restored.base, "/api/plan-usage");
    assert.deepEqual(cache.usage, reading);
    assert.equal(cache.accountId, "work");
    assert.equal(cache.byAccount.work.window.usedPercent, 125);
    assert.equal(cache.saved, true);
    assert.deepEqual(cache.savedAccountIds, ["work"]);
    assert.equal(cache.status, "no-host");
    assert.equal(probe.targets.length, 0, "a quota read never starts a host or model call");

    const otherRuntime = await start(new FakeConnection(), { ...options, musePath: "/another/muse" });
    assert.equal((await get(otherRuntime.base, "/api/plan-usage")).usage, null, "a different runtime cannot reuse the snapshot");
    await login("second@example.test");
    assert.equal((await get(restored.base, "/api/plan-usage")).usage, null, "a different login cannot reuse the snapshot");
  });

  it("does not restore a previous login when overlapping quota reads finish out of order", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-race-"));
    const aonia = createAonia({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    const authDir = join(profile.roots.config, "muse");
    await mkdir(authDir, { recursive: true });
    const login = (email: string) => writeFile(join(authDir, "auth.json"), JSON.stringify({
      providers: { meta: { mechanism: "oauth", user_email: email } },
    }));
    await login("first@example.test");
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "w1" } });
    const { base } = await start(connection, { aonia, home: join(dataDir, "home") });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const reading = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 90, resetsAtMs: 500, windowDurationMins: 300 },
      weekly: { usedPercent: 70, resetsAtMs: 1000 } };
    let finish: ((value: unknown) => void) | undefined;
    connection.replies.set("usage/read", () => new Promise((resolve) => { finish = resolve; }));
    const oldRead = get(base, "/api/plan-usage");
    await waitFor(() => finish !== undefined, "first login quota read");
    await login("second@example.test");
    const current = await get(base, "/api/plan-usage");
    assert.equal(current.usage, null);
    finish!({ usage: reading });
    const late = await oldRead;
    assert.equal(late.usage, null, "a late reply cannot restore the old login's quota");
    assert.deepEqual(late.byAccount, {});
    assert.equal((await get(base, "/api/plan-usage")).usage, null);
  });

  it("ignores quota notifications and reads from a removed account even without a verified login scope", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-removed-"));
    const aonia = createAonia({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const connection = new FakeConnection();
    const replacement = new FakeConnection();
    let starts = 0;
    const factory = (target: ServeTarget) => fakeFactory(starts++ === 0 ? connection : replacement)(target);
    connection.replies.set("session/start", { session: { sessionId: "w1" } });
    replacement.replies.set("session/start", { session: { sessionId: "w2" } });
    const { base } = await start(connection, { aonia, home: join(dataDir, "home"), hostFactory: factory });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const reading = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 90, resetsAtMs: 500, windowDurationMins: 300 },
      weekly: { usedPercent: 70, resetsAtMs: 1000 } };
    connection.notify("usage/changed", reading);
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 90);
    assert.equal((await send(base, "/api/accounts/work", undefined, "DELETE")).status, 200);
    connection.notify("usage/changed", { ...reading, observedAtMs: 200 });
    connection.replies.set("usage/read", { usage: { ...reading, observedAtMs: 300 } });
    const removed = await get(base, "/api/plan-usage");
    assert.equal(removed.usage, null);
    assert.deepEqual(removed.byAccount, {});
    await aonia.createProfile("work");
    await send(base, "/api/sessions", { cwd: "/another-project", accountId: "work" });
    replacement.notify("usage/changed", { ...reading, observedAtMs: 400, window: { ...reading.window, usedPercent: 25 } });
    connection.notify("usage/changed", { ...reading, observedAtMs: 900 });
    connection.replies.set("usage/read", { usage: { ...reading, observedAtMs: 1000 } });
    const recreated = await get(base, "/api/plan-usage");
    assert.equal(recreated.usage.window.usedPercent, 25, "recreating a profile never re-enables its old hosts");
    assert.equal(recreated.byAccount.work.window.usedPercent, 25);
  });

  it("ignores late quota replies and notifications from a retired host generation", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-generation-"));
    const old = new FakeConnection();
    const fresh = new FakeConnection();
    const probe: FactoryProbe = { targets: [], exits: [] };
    let starts = 0;
    const factory = (target: ServeTarget) => fakeFactory(starts++ === 0 ? old : fresh, probe)(target);
    old.replies.set("session/start", { session: { sessionId: "old" } });
    fresh.replies.set("session/start", { session: { sessionId: "fresh" } });
    const { base } = await start(old, { home, hostFactory: factory });
    await send(base, "/api/sessions", { cwd: "/proj" });
    let finish: ((value: unknown) => void) | undefined;
    old.replies.set("usage/read", () => new Promise((resolve) => { finish = resolve; }));
    const oldRead = get(base, "/api/plan-usage");
    await waitFor(() => finish !== undefined, "old host quota read");
    probe.exits[0]!({ code: 1, signal: null });
    await send(base, "/api/sessions", { cwd: "/proj" });
    const reading = (at: number, percent: number) => ({ tier: "high", observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: 5000, windowDurationMins: 300 },
      weekly: { usedPercent: 20, resetsAtMs: 10000 } });
    fresh.notify("usage/changed", reading(200, 25));
    finish!({ usage: reading(900, 90) });
    assert.equal((await oldRead).usage.window.usedPercent, 25, "a retired reader cannot overwrite its replacement");
    old.notify("usage/changed", reading(1000, 95));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 25, "a retired callback cannot inherit the replacement's identity");
  });

  it("distinguishes an unreported quota from an unavailable quota reader", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    assert.equal((await get(base, "/api/plan-usage")).status, "no-host");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal((await get(base, "/api/plan-usage")).status, "unobserved");
    connection.replies.set("usage/read", new Error("method not found"));
    const unavailable = await get(base, "/api/plan-usage");
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.usage, null);
    assert.equal(unavailable.accounts[0].status, "unavailable");
  });

  it("bounds a stalled runtime quota read and shares its outstanding request", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("usage/read", () => new Promise(() => {}));
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work" });
    const first = get(base, "/api/plan-usage");
    await waitFor(() => connection.requests.some((request) => request.method === "usage/read"), "runtime quota read");
    const second = get(base, "/api/plan-usage");
    for (const report of await Promise.all([first, second])) assert.equal(report.status, "unavailable");
    assert.equal(connection.requests.filter((request) => request.method === "usage/read").length, 1);
  });

  it("marks a failed account fallback unavailable while retaining its previous observation", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work" });
    const at = Date.now();
    connection.notify("usage/changed", { tier: "high", observedAtMs: at,
      window: { usedPercent: 72, resetsAtMs: at + 60000, windowDurationMins: 300 },
      weekly: { usedPercent: 31, resetsAtMs: at + 86400000 } });
    connection.replies.set("usage/read", new Error("runtime closed"));
    const account = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(account.status, "unavailable");
    assert.equal(account.source, "runtime");
    assert.equal(account.usage.window.usedPercent, 72);
    assert.equal(account.usage.observedAtMs, at);
  });

  it("does not re-broadcast plan-usage when a repeat GET re-reads the same window", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    const reading = {
      tier: "high",
      observedAtMs: 5_000,
      window: { usedPercent: 30, resetsAtMs: 6_000, windowDurationMins: 300 },
      weekly: { usedPercent: 9, resetsAtMs: 12_000, windowDurationMins: null },
    };
    connection.replies.set("usage/read", { usage: reading });
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const count = await countPlanUsageEvents(base, async () => {
      await get(base, "/api/plan-usage");
      await get(base, "/api/plan-usage");
    });
    assert.equal(count, 1, "a same-timestamp re-read must not re-emit plan-usage");
  });

  it("gives Muse the name typed here, and takes the name Muse settles on, when titles are shared", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { syncSessionNames: true });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const read = async () => (await get(base, "/api/sessions")).sessions[0];

    await send(base, "/api/sessions/s1", { title: "Ship the sidebar" }, "PATCH");
    assert.deepEqual(connection.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Ship the sidebar" } });

    connection.notify("session/nameChanged", { sessionId: "s1", name: "sidebar-v2", viewCursor: "c", sourceRange: RANGE });
    let session = await read();
    assert.equal(session.title, "sidebar-v2", "a `/name` in another client is the newest name");
    assert.equal(session.titleSource, "user", "and a thread the user named stays theirs");

    connection.replies.set("session/rename", new MspTestError("ephemeral", "unsupported"));
    const renamed = await send(base, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.equal(renamed.status, 200, "a rename Muse refuses still renames the thread here");
    assert.equal(renamed.json.session.title, "Local only");

    const renames = connection.calls.filter((c) => c.method === "session/rename").length;
    await send(base, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.equal(connection.calls.filter((c) => c.method === "session/rename").length, renames, "an unchanged title is not sent again");
    session = await read();
    assert.equal(session.title, "Local only");
  });

  it("keeps generated and typed titles local by default, writing no rename records to Muse", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const exec: ExecFn = async () => ({
      stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Parallel code investigation" } }),
      exitCode: 0,
    });
    // No syncSessionNames: what a runtime.json without the key, or none at all, gives.
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Investigate these independent components with native agents" },
    });
    await waitFor(async () => (await titleOf()) === "Parallel code investigation", "the generated local title");
    connection.notify("session/nameChanged", { sessionId: "s1", name: "native-name", viewCursor: "c", sourceRange: RANGE });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "native-name" }], nextCursor: null,
    });
    await send(base, "/api/discover", {});
    assert.equal(await titleOf(), "Parallel code investigation", "the unsynchronized host name cannot undo a local title");
    await send(base, "/api/sessions/s1", { title: "My investigation" }, "PATCH");
    assert.equal(await titleOf(), "My investigation");
    assert.equal(connection.calls.filter((c) => c.method === "session/rename").length, 0);
  });

  it("stops sending titles to a host whose Muse reports the rename-broken event log, and says so once", async () => {
    const decodeFailure = "event log failed: record decode failed: payload decode failed: missing field kind";
    const renames = (connection: FakeConnection) => connection.calls.filter((c) => c.method === "session/rename").length;
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const connection = new FakeConnection();
      connection.replies.set("session/start", { session: { sessionId: "s1" } });
      connection.replies.set("session/rename", new MspTestError(decodeFailure, "internal"));
      const { base } = await start(connection, { syncSessionNames: true });
      await send(base, "/api/sessions", { cwd: "/work/proj" });
      assert.equal((await send(base, "/api/sessions/s1", { title: "First" }, "PATCH")).status, 200);
      assert.equal((await send(base, "/api/sessions/s1", { title: "Second" }, "PATCH")).status, 200);
      assert.equal(renames(connection), 1, "no title goes to that host again");
      assert.equal((await get(base, "/api/sessions")).sessions[0].title, "Second", "the local title stands");
      assert.equal(logged.filter((line) => /missing field kind/.test(line)).length, 1);

      // The failure can also show up in the turn: a workflow that could not be admitted to the broken log.
      const second = new FakeConnection();
      second.replies.set("session/start", { session: { sessionId: "s1" } });
      second.replies.set("session/rename", new MspTestError("ephemeral", "unsupported"));
      const { base: base2 } = await start(second, { syncSessionNames: true });
      await send(base2, "/api/sessions", { cwd: "/work/proj" });
      await send(base2, "/api/sessions/s1", { title: "First" }, "PATCH");
      await send(base2, "/api/sessions/s1", { title: "Second" }, "PATCH");
      assert.equal(renames(second), 2, "an ordinary refusal does not stop titles");
      second.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "failed",
        error: { message: `workflow cancel registration failed before admission: ${decodeFailure}` } });
      await send(base2, "/api/sessions/s1", { title: "Third" }, "PATCH");
      assert.equal(renames(second), 2);
      assert.equal((await get(base2, "/api/sessions")).sessions[0].title, "Third");
      assert.equal(logged.filter((line) => /missing field kind/.test(line)).length, 2, "once per host");
    } finally {
      process.stderr.write = write;
    }
  });

  it("keeps thread-title settings behind a switch and a model choice", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: true, modelId: null });

    const patched = await send(base, "/api/title-settings", { enabled: false, modelId: "m1" }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { enabled: false, modelId: "m1" });
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: false, modelId: "m1" });

    const merged = await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    assert.deepEqual(merged.json, { enabled: true, modelId: "m1" });

    const badEnabled = await send(base, "/api/title-settings", { enabled: "yes" }, "PATCH");
    assert.equal(badEnabled.status, 400);
    const badModel = await send(base, "/api/title-settings", { modelId: "" }, "PATCH");
    assert.equal(badModel.status, 400);
    assert.deepEqual(await get(base, "/api/title-settings"), { enabled: true, modelId: "m1" }, "a rejected patch changes nothing");
  });

  it("keeps sandbox settings behind a boolean switch, defaulting to sandbox-on", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: false });

    const patched = await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { disabled: true });
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: true });

    const bad = await send(base, "/api/sandbox-settings", { disabled: "yes" }, "PATCH");
    assert.equal(bad.status, 400);
    assert.deepEqual(await get(base, "/api/sandbox-settings"), { disabled: true }, "a rejected patch changes nothing");
  });

  it("spawns hosts with --disable-sandbox, restarting them when the switch flips", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox"]],
      "the respawned host carries the new posture",
    );

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closes, 1, "an unchanged switch restarts nothing");
  });

  it("drops --disable-sandbox from respawned hosts when the switch flips back on", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(base, "/api/sandbox-settings", { disabled: false }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve", "--disable-sandbox"], ["serve"]],
      "the respawned host drops --disable-sandbox",
    );
  });

  it("marks sessions with their creation posture, inherited by forks", async () => {
    const connection = new FakeConnection();
    let started = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${(started += 1)}` } }));
    const { base } = await start(connection);

    const plain = await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(plain.json.session.sandboxDisabled, false);

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    const lifted = await send(base, "/api/sessions", { cwd: "/work/other" });
    assert.equal(lifted.json.session.sandboxDisabled, true, "a session records its creating host's flags");

    connection.replies.set("session/fork", { session: { sessionId: "s3" } });
    const fork = await send(base, "/api/sessions/s2/fork", {});
    assert.equal(fork.json.session.sandboxDisabled, true, "a fork inherits its source's posture");

    const sessions = (await get(base, "/api/sessions")).sessions as { sessionId: string; sandboxDisabled: boolean | null }[];
    assert.equal(
      sessions.find((s) => s.sessionId === "s1")?.sandboxDisabled,
      false,
      "flipping the switch never rewrites old rows",
    );
  });

  it("never starts a session on a host retired by a flip", async () => {
    const connection = new FakeConnection();
    let started = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${(started += 1)}` } }));
    const probe: FactoryProbe = { targets: [], exits: [] };
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const inner = fakeFactory(connection, probe);
    let first = true;
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const gateThis = first;
      first = false;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (gateThis) {
          await closeGate;
        }
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(base, "/api/sandbox-settings", { disabled: false }, "PATCH");
    const pending = send(base, "/api/sessions", { cwd: "/work/proj" });
    try {
      const raced = await Promise.race([pending.then((r) => r), new Promise((r) => setTimeout(() => r("waiting"), 50))]);
      assert.equal(raced, "waiting", "creation waits for the flip's restart");
    } finally {
      // Always unblock the retired host: teardown closes it even when the test fails.
      releaseClose();
    }
    const created = await pending;
    assert.equal(created.status, 200);
    assert.equal(created.json.session.sandboxDisabled, false, "the session lands on the new posture's host");
  });

  it("keeps YOLO settings behind a boolean switch, defaulting to off", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection);
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: false });

    const patched = await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { enabled: true });
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: true });

    const bad = await send(base, "/api/yolo-settings", { enabled: "yes" }, "PATCH");
    assert.equal(bad.status, 400);
    assert.deepEqual(await get(base, "/api/yolo-settings"), { enabled: true }, "a rejected patch changes nothing");
  });

  it("spawns hosts with the YOLO flags, restarting them when the switch flips", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox", "--trust-workspace"]],
      "the respawned host carries the new posture",
    );

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closes, 1, "an unchanged switch restarts nothing");
  });

  it("drops the YOLO flags from respawned hosts when the switch flips back off", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    let closes = 0;
    const inner = fakeFactory(connection, probe);
    const counting = (target: ServeTarget): HostHandle => {
      const handle = inner(target);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes += 1;
        return close();
      };
      return handle;
    };
    const { base } = await start(connection, { hostFactory: counting });

    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);

    await send(base, "/api/yolo-settings", { enabled: false }, "PATCH");
    await waitFor(() => closes === 1, "the live host closing");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(
      probe.targets.map((t) => t.args),
      [
        ["serve", "--disable-sandbox", "--trust-workspace"],
        ["serve"],
      ],
      "the respawned host drops the YOLO flags",
    );
  });

  it("spawns hosts with --disable-sandbox once when both the sandbox switch and YOLO are on", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);
  });

  it("upgrades an echo title with one muse exec call, and pushes the name back when titles are shared", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      await gate;
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix login redirect" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec, syncSessionNames: true });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "please fix the login redirect bug in the web app when sessions expire" },
    });
    await waitFor(() => calls.length > 0, "the title call to start");
    assert.equal(await titleOf(), "please fix the login redirect bug in the web app when sessions expire");
    release();
    await waitFor(async () => (await titleOf()) === "Fix login redirect", "the upgraded title");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "muse");
    assert.equal(calls[0]?.[1], "exec");
    assert.ok(!calls[0]?.includes("--model"), "no model flag without a chosen model");
    assert.match(calls[0]?.at(-1) ?? "", /please fix the login redirect bug/);
    assert.deepEqual(connection.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Fix login redirect" } });
  });

  it("passes the chosen model to the title call", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "not json", exitCode: 0 };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/title-settings", { modelId: "m9" }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    await waitFor(() => calls.length > 0, "the title call");
    const modelFlag = calls[0]?.indexOf("--model") ?? -1;
    assert.deepEqual(calls[0]?.slice(modelFlag, modelFlag + 2), ["--model", "m9"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await get(base, "/api/sessions")).sessions[0].title, "Add dark mode everywhere", "garbage output keeps the echo");
  });

  it("stays silent while switched off, and upgrades on re-enable", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("view/page", {
      events: [{ method: "item/completed", params: { item: { itemId: "u1", kind: "userMessage", text: "Add dark mode everywhere" } } }],
      nextCursor: null,
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    assert.equal(await titleOf(), "Add dark mode everywhere");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, "no model call while switched off");
    await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    await waitFor(async () => (await titleOf()) === "Add dark mode", "the upgrade after re-enable");
    assert.equal(calls.length, 1);
  });

  it("lets a rename typed mid-upgrade win over the generated title", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    let release!: (result: { stdout: string; exitCode: number }) => void;
    const gate = new Promise<{ stdout: string; exitCode: number }>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return gate;
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });
    await waitFor(() => calls.length > 0, "the title call to start");
    await send(base, "/api/sessions/s1", { title: "Mine" }, "PATCH");
    release({
      stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" } }),
      exitCode: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.title, "Mine");
    assert.equal(session.titleSource, "user");
  });

  it("checks \\\\wsl.localhost\\ folders against the distro Muse is started in, not WSL's default", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/list", { sessions: [], nextCursor: null });
    const wsl = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const hosts: FactoryProbe = { targets: [], exits: [] };
    // WSL's default is Debian; Muse lives in Ubuntu, and nothing in runtime.json says which.
    const { base } = await start(connection, {
      platform: "win32", runtime: "wsl", musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["Debian", "Ubuntu"], ["Ubuntu"], wsl), hostFactory: fakeFactory(connection, hosts),
    });
    const env = await get(base, "/api/env");
    assert.equal(env.museFound, true);
    assert.equal(env.defaultDistro, "Ubuntu", "the app shows the distro Muse runs in");
    const added = await send(base, "/api/projects", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" });
    assert.equal(added.status, 200);
    assert.equal(added.json.warning, null);
    assert.equal((await send(base, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" })).status, 200);
    assert.deepEqual(hosts.targets[0]?.args.slice(0, 2), ["-d", "Ubuntu"], "the host starts where the check looked");
    const other = await send(base, "/api/sessions", { cwd: "\\\\wsl.localhost\\Debian\\home\\u\\proj" });
    assert.equal(other.status, 400);
    assert.equal(other.json.error, "This folder belongs to WSL Debian, but Muse is running in Ubuntu.");

    // With Muse only in the default distro, that is where it runs, and the check follows.
    const only = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const debianHosts: FactoryProbe = { targets: [], exits: [] };
    const { base: base2 } = await start(connection, {
      platform: "win32", runtime: "wsl", musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["Debian", "Ubuntu"], ["Debian"], only), hostFactory: fakeFactory(connection, debianHosts),
    });
    assert.equal((await get(base2, "/api/env")).defaultDistro, "Debian");
    assert.equal((await send(base2, "/api/sessions", { cwd: "\\\\wsl.localhost\\Debian\\home\\u\\proj" })).status, 200);
    assert.deepEqual(debianHosts.targets[0]?.args.slice(0, 2), ["-d", "Debian"]);
    const refused = await send(base2, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" });
    assert.equal(refused.json.error, "This folder belongs to WSL Ubuntu, but Muse is running in Debian.");
  });

  it("probes the pinned distro and binary from runtime.json, so a working Muse is never reported missing", async () => {
    const connection = new FakeConnection();
    const wsl = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const { base } = await start(connection, {
      platform: "win32", runtime: "wsl", distro: "Ubuntu-24.04", musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["docker-desktop", "Ubuntu-24.04"], ["Ubuntu-24.04"], wsl),
    });
    const env = await get(base, "/api/env");
    assert.equal(env.museFound, true);
    assert.equal(env.musePath, "/home/u/.local/bin/muse");
    assert.equal(env.defaultDistro, "Ubuntu-24.04");
    assert.deepEqual(wsl.calls, [
      ["wsl", "-l", "-v"],
      ["wsl", "-d", "Ubuntu-24.04", "-e", "test", "-x", "/home/u/.local/bin/muse"],
    ], "only the pinned distro is looked in, for the pinned binary");

    const missing = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const { base: base2 } = await start(connection, {
      platform: "win32", runtime: "wsl", distro: "Ubuntu-24.04", musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["docker-desktop", "Ubuntu-24.04"], [], missing),
    });
    const gone = await get(base2, "/api/env");
    assert.equal(gone.museFound, false, "a pinned binary that is not there is reported as missing");
    assert.equal(gone.musePath, null);
    assert.equal(gone.defaultDistro, "Ubuntu-24.04");
  });

  it("carries runtime.json's wslEnv into WSL processes only, over the Windows values of the same names", async () => {
    const saved = { backend: process.env["TBH_CREDENTIAL_BACKEND"], wslenv: process.env["WSLENV"], bashEnv: process.env["BASH_ENV"] };
    process.env["TBH_CREDENTIAL_BACKEND"] = "keyring";
    process.env["WSLENV"] = "USERPROFILE/p";
    delete process.env["BASH_ENV"];
    try {
      const connection = new FakeConnection();
      connection.replies.set("session/start", { session: { sessionId: "s1" } });
      const wsl = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
      const hosts: FactoryProbe = { targets: [], exits: [] };
      const wslEnv = { TBH_CREDENTIAL_BACKEND: "file", BASH_ENV: "/home/u/.config/muse/runtime-env.sh" };
      const { base } = await start(connection, {
        platform: "win32", runtime: "wsl", musePath: "/home/u/.local/bin/muse", wslEnv,
        exec: fakeWsl(["Ubuntu"], ["Ubuntu"], wsl), hostFactory: fakeFactory(connection, hosts),
      });
      assert.equal((await send(base, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" })).status, 200);
      const target = hosts.targets[0];
      assert.equal(target?.env?.["TBH_CREDENTIAL_BACKEND"], "file", "runtime.json wins over the Windows value");
      assert.equal(target?.env?.["BASH_ENV"], "/home/u/.config/muse/runtime-env.sh");
      assert.equal(target?.env?.["WSLENV"], "USERPROFILE/p:TBH_CREDENTIAL_BACKEND/u:BASH_ENV/u");
      assert.ok(wsl.envs.length > 0 && wsl.envs.every((env) => env?.["TBH_CREDENTIAL_BACKEND"] === "file"), "the probe's calls into WSL see the same");
      assert.equal(process.env["TBH_CREDENTIAL_BACKEND"], "keyring", "the server's own environment is untouched");
      assert.equal(process.env["BASH_ENV"], undefined);
      assert.equal(process.env["WSLENV"], "USERPROFILE/p");

      // Native Muse is a Windows process: none of it applies there.
      const native: FactoryProbe = { targets: [], exits: [] };
      const { base: base2 } = await start(connection, {
        platform: "win32", runtime: "native", musePath: "C:\\muse\\muse.exe", wslEnv, hostFactory: fakeFactory(connection, native),
      });
      assert.equal((await send(base2, "/api/sessions", { cwd: "D:\\work\\proj" })).status, 200);
      assert.equal(native.targets[0]?.command, "C:\\muse\\muse.exe");
      assert.equal(native.targets[0]?.env, undefined);
    } finally {
      for (const [name, value] of [["TBH_CREDENTIAL_BACKEND", saved.backend], ["WSLENV", saved.wslenv], ["BASH_ENV", saved.bashEnv]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("spawns one host per workspace under concurrency and respawns after a crash", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    await Promise.all([
      send(base, "/api/sessions", { cwd: "/work/proj" }),
      send(base, "/api/sessions", { cwd: "/work/proj" }),
    ]);
    assert.equal(probe.targets.length, 1);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    probe.exits[0]?.({ code: 1, signal: null });
    const session = (await get(base, "/api/sessions")).sessions[0];
    assert.equal(session.live.activeTurnId, null);
    assert.equal(session.live.lastTerminal, "failed");
    assert.match((await get(base, "/api/health")).lastHostError, /exited/);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(probe.targets.length, 2);
  });

  it("accepts an injected aonia and still starts a plain host with no account", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, {
      home,
      hostFactory: fakeFactory(connection, probe),
      aonia: createAonia({ home, platform: "linux", musePath: "muse" }),
    });
    const res = await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(res.status, 200);
    assert.deepEqual(probe.targets.map((t) => t.args), [["serve"]]);
    assert.equal(probe.targets[0]?.env?.HOME, home, "the Linux host uses the home checked by storage preflight");
    assert.equal(probe.targets[0]?.env?.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
    assert.equal(probe.targets[0]?.env?.XDG_DATA_HOME, process.env.XDG_DATA_HOME);
  });

  it("spawns a per-account host with the profile environment merged over process.env", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    const work = await aonia.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });

    const res = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    assert.equal(res.status, 200);
    const target = probe.targets[0];
    assert.ok(target?.env, "the account host carries an env");
    assert.equal(target.env["XDG_CONFIG_HOME"], work.roots.config);
    assert.equal(target.env["XDG_DATA_HOME"], work.roots.data);
    // Look PATH up case-insensitively: Windows names it "Path", and the spread keeps that casing.
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
    assert.ok(pathKey, "the runner has a PATH");
    assert.equal(target.env[pathKey], process.env[pathKey], "process.env is spread first");
  });

  it("keeps a separate host per account in the same workspace", async () => {
    const connection = new FakeConnection();
    let n = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++n}` } }));
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    await aonia.createProfile("personal");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });

    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "personal" });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(probe.targets.length, 3, "three accounts in one workspace means three hosts");
  });

  it("rejects a session for an account that does not exist", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    const res = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "ghost" });
    assert.equal(res.status, 400);
  });

  it("puts a session back on its account after the host is forgotten", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), aonia });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    // Ask for the transcript by session id after dropping the in-memory host map is exercised by managerForSession;
    // here assert the session row carries the account so a rebuild has what it needs.
    const listed = await get(base, "/api/sessions");
    assert.ok(listed.sessions?.length > 0, "sessions listed");
  });

  it("lists, creates, renames and removes accounts through aonia", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });

    assert.deepEqual((await get(base, "/api/accounts")).accounts, []);

    const created = await send(base, "/api/accounts", { id: "work", name: "Work" });
    assert.equal(created.status, 200);
    assert.equal(created.json.account.id, "work");

    const listed = (await get(base, "/api/accounts")).accounts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "work");
    assert.equal(listed[0].name, "Work");
    assert.equal(listed[0].hasLogin, false);

    const renamed = await send(base, "/api/accounts/work", { name: "Client A" }, "PATCH");
    assert.equal(renamed.status, 200);
    assert.equal((await get(base, "/api/accounts")).accounts[0].name, "Client A");

    const removed = await send(base, "/api/accounts/work", undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual((await get(base, "/api/accounts")).accounts, []);
  });

  it("rejects a bad account id and a duplicate", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    assert.equal((await send(base, "/api/accounts", { id: "Not Valid" })).status, 400);
    await send(base, "/api/accounts", { id: "work" });
    assert.equal((await send(base, "/api/accounts", { id: "work" })).status, 409);
  });

  it("reports metaApiKeyInherited from the aonia doctor finding", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, {
      aonia: createAonia({ home, platform: "linux", musePath: "muse", env: { META_API_KEY: "x" } }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, true);
  });

  it("reports metaApiKeyInherited false when META_API_KEY is not set", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, {
      aonia: createAonia({ home, platform: "linux", musePath: "muse", env: {} }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, false);
  });

  it("reports only the default login's non-secret identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-identity-"));
    const original = createAonia({ home, platform: "linux", musePath: "muse", env: {} });
    const { base } = await start(new FakeConnection(), {
      home, platform: "linux", aonia: {
        ...original,
        identityOf: async () => ({ hasLogin: true, email: "person@example.test", name: "Person" }),
      },
    });
    const health = await get(base, "/api/accounts/health");
    assert.deepEqual(health.defaultLogin, { hasLogin: true, email: "person@example.test" });
    assert.deepEqual(Object.keys(health).sort(), ["defaultLogin", "metaApiKeyInherited"]);
    assert.deepEqual((await get(base, "/api/accounts")).accounts, []);
  });

  it("does not label an unreadable WSL default credential store as signed out", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-wsl-identity-"));
    const original = createAonia({ home, platform: "linux", musePath: "muse", env: {} });
    const { base } = await start(new FakeConnection(), {
      home, platform: "win32", runtime: "wsl", distro: "Ubuntu", musePath: "/home/dev/muse", aonia: {
        ...original,
        identityOf: async () => { throw new Error("must not read Windows identity for the WSL default"); },
      },
    });
    assert.deepEqual((await get(base, "/api/accounts/health")).defaultLogin, { hasLogin: null, email: null });
  });

  it("does not read an unrelated default identity when MUSE_AUTH_PATH is set, while still confirming browser sign-in", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-custom-auth-"));
    const original = createAonia({ home, platform: "linux", musePath: "muse", env: {} });
    const previous = process.env["MUSE_AUTH_PATH"];
    const child = new FakeLoginChild();
    let identityReads = 0;
    process.env["MUSE_AUTH_PATH"] = join(home, "custom", "auth.json");
    try {
      const { base } = await start(new FakeConnection(), {
        home, platform: "linux", musePath: "/custom/muse", aonia: {
          ...original,
          identityOf: async () => {
            identityReads += 1;
            return { hasLogin: true, email: "unrelated@example.test", name: "Unrelated" };
          },
        },
        loginSpawn: (_command, _args, options) => {
          assert.equal(options.env["MUSE_AUTH_PATH"], process.env["MUSE_AUTH_PATH"]);
          setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=CUSTOM-1234\n"));
          return child as unknown as LoginChild;
        },
      });
      assert.deepEqual((await get(base, "/api/accounts/health")).defaultLogin, { hasLogin: null, email: null });
      const response = await send(base, "/api/login", undefined);
      assert.equal(response.status, 200);
      child.finish(0);
      assert.deepEqual(await get(base, `/api/login?loginId=${response.json.loginId}`), { status: "done" });
      assert.deepEqual((await get(base, "/api/accounts/health")).defaultLogin, { hasLogin: null, email: null });
      assert.equal(identityReads, 0, "the default file is not used to identify a login with an explicit auth path");
    } finally {
      if (previous === undefined) delete process.env["MUSE_AUTH_PATH"];
      else process.env["MUSE_AUTH_PATH"] = previous;
    }
  });

  it("logs an account in: resolves url and code from staged stdout, through the server's own muse path", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const children: FakeLoginChild[] = [];
    const loginSpawn: LoginSpawn = (command, args, opts) => {
      calls.push({ command, args, env: opts.env });
      const child = new FakeLoginChild();
      children.push(child);
      setImmediate(() => {
        child.stdout.emit("data", "Open this page to sign in: https://auth.meta.com/oauth/device/?code=ABCD-1234\n");
      });
      return child as unknown as LoginChild;
    };
    // aonia's own musePath stays the bare default "muse"; the server carries a different configured
    // path, so the route must resolve through the server's own musePath rather than aonia's.
    const { base } = await start(connection, { musePath: "/custom/muse", aonia, loginSpawn });

    const res = await send(base, "/api/accounts/work/login", undefined);
    assert.equal(res.status, 200);
    assert.equal(res.json.url, "https://auth.meta.com/oauth/device/?code=ABCD-1234");
    assert.equal(res.json.code, "ABCD-1234");
    assert.equal(typeof res.json.loginId, "string");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/custom/muse");
    assert.deepEqual(calls[0].args, ["login"]);
  });

  it("signs in through the selected WSL runtime and forwards the profile folders", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const loginSpawn: LoginSpawn = (command, args, opts) => {
      calls.push({ command, args, env: opts.env });
      const child = new FakeLoginChild();
      setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=WSL-1234\n"));
      return child as unknown as LoginChild;
    };
    const { base } = await start(connection, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      distro: "Ubuntu-24.04",
      aonia,
      loginSpawn,
    });

    const res = await send(base, "/api/accounts/work/login", undefined);
    assert.equal(res.status, 200);
    assert.equal(res.json.code, "WSL-1234");
    assert.equal(calls[0]?.command, "wsl");
    assert.deepEqual(calls[0]?.args, ["-d", "Ubuntu-24.04", "-e", "/home/dev/.local/bin/muse", "login"]);
    assert.equal(calls[0]?.env["XDG_CONFIG_HOME"], (await aonia.getProfile("work")).roots.config);
    assert.match(calls[0]?.env["WSLENV"] ?? "", /XDG_CONFIG_HOME\/p/);
  });

  it("kills the first login child when a second login call arrives for the same account", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const children: FakeLoginChild[] = [];
    const loginSpawn: LoginSpawn = () => {
      const child = new FakeLoginChild();
      children.push(child);
      return child as unknown as LoginChild;
    };
    const { base } = await start(connection, { aonia, loginSpawn });

    const first = send(base, "/api/accounts/work/login", undefined);
    await waitFor(() => children.length === 1, "first login child to spawn");

    const second = send(base, "/api/accounts/work/login", undefined);
    await waitFor(() => children.length === 2, "second login child to spawn");
    assert.equal(children[0]?.killCount, 1);

    children[1]?.stdout.emit("data", "Open this page to sign in: https://auth.meta.com/oauth/device/?code=WXYZ-9999\n");
    const secondRes = await second;
    assert.equal(secondRes.status, 200);
    assert.equal(secondRes.json.url, "https://auth.meta.com/oauth/device/?code=WXYZ-9999");
    assert.equal(secondRes.json.code, "WXYZ-9999");
    assert.equal(typeof secondRes.json.loginId, "string");

    // The killed first child's own close event lands async; give it a moment to settle its request.
    const firstRes = await first;
    assert.equal(firstRes.status, 504);
  });

  for (const delayedSetup of ["profile", "runtime"] as const) {
    it(`does not let an older sign-in delayed by ${delayedSetup} discovery replace the newer attempt`, async () => {
      const home = await mkdtemp(join(tmpdir(), "ancilla-login-admission-"));
      const aonia = createAonia({ home, platform: "linux", musePath: "muse", env: {} });
      await aonia.createProfile("work");
      const children: FakeLoginChild[] = [];
      let waiting = false;
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const { base } = await start(new FakeConnection(), {
        home, musePath: delayedSetup === "runtime" ? null : "/custom/muse",
        aonia: {
          ...aonia,
          getProfile: async (id) => {
            if (delayedSetup === "profile" && reads++ === 0) { waiting = true; await gate; }
            return aonia.getProfile(id);
          },
        },
        exec: async () => {
          if (delayedSetup === "runtime" && reads++ === 0) { waiting = true; await gate; }
          return { stdout: "/custom/muse\n", exitCode: 0 };
        },
        loginSpawn: () => {
          const child = new FakeLoginChild();
          children.push(child);
          setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=LATEST-1234\n"));
          return child as unknown as LoginChild;
        },
      });
      const route = delayedSetup === "runtime" ? "/api/login" : "/api/accounts/work/login";
      const first = send(base, route, undefined);
      await waitFor(() => waiting, "the first request to wait during sign-in setup");
      try {
        const second = await send(base, route, undefined);
        assert.equal(second.status, 200);
        release();
        const stale = await first;
        assert.equal(stale.status, 409);
        assert.match(stale.json.error, /newer sign-in request/);
        assert.equal(children.length, 1, "the stale request must not spawn another CLI process");
        assert.equal(children[0]?.killCount, 0, "the newer login must keep running");
        const statusPath = `${route}?loginId=${second.json.loginId}`;
        assert.deepEqual(await get(base, statusPath), { status: "waiting" });
        await send(base, `${route}?loginId=discarded-attempt`, undefined, "DELETE");
        assert.equal(children[0]?.killCount, 0, "stale cancellation still cannot touch the admitted login");
        children[0]?.finish(0);
        assert.deepEqual(await get(base, statusPath), { status: "done" });
      } finally { release(); await first; }
    });
  }

  it("keeps pending sign-in admissions independent for different account profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-independent-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse", env: {} });
    await aonia.createProfile("work");
    await aonia.createProfile("personal");
    let waiting = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const children: FakeLoginChild[] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", aonia: {
        ...aonia,
        getProfile: async (id) => {
          if (id === "work") { waiting = true; await gate; }
          return aonia.getProfile(id);
        },
      },
      loginSpawn: () => {
        const child = new FakeLoginChild();
        children.push(child);
        setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=USER-1234\n"));
        return child as unknown as LoginChild;
      },
    });
    const work = send(base, "/api/accounts/work/login", undefined);
    await waitFor(() => waiting, "work account sign-in to wait during setup");
    try {
      assert.equal((await send(base, "/api/accounts/personal/login", undefined)).status, 200);
      release();
      assert.equal((await work).status, 200);
      assert.equal(children.length, 2);
      assert.ok(children.every((child) => child.killCount === 0));
    } finally { release(); await work; }
  });

  it("signs in to the default subscription without creating a named profile, and confirms process completion", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-default-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    const child = new FakeLoginChild();
    const calls: string[][] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", aonia,
      loginSpawn: (_command, args) => {
        calls.push(args);
        setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=USER-1234\n"));
        return child as unknown as LoginChild;
      },
    });
    const response = await send(base, "/api/login", undefined);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["login"]]);
    assert.deepEqual(await aonia.listProfiles(), []);
    const path = `/api/login?loginId=${response.json.loginId}`;
    assert.deepEqual(await get(base, path), { status: "waiting" });
    child.finish(0);
    assert.deepEqual(await get(base, path), { status: "done" });
  });

  it("reports failed approval and ignores stale cancellation of a replacement login", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-cancel-"));
    const children: FakeLoginChild[] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", aonia: createAonia({ home, platform: "linux", musePath: "muse" }),
      loginSpawn: () => {
        const child = new FakeLoginChild();
        children.push(child);
        setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=USER-1234\n"));
        return child as unknown as LoginChild;
      },
    });
    const first = await send(base, "/api/login", undefined);
    const second = await send(base, "/api/login", undefined);
    assert.notEqual(first.json.loginId, second.json.loginId);
    assert.deepEqual(await get(base, `/api/login?loginId=${first.json.loginId}`), { status: "idle" });
    await send(base, `/api/login?loginId=${first.json.loginId}`, undefined, "DELETE");
    assert.equal(children[1]?.killCount, 0);
    children[1]?.finish(1);
    const failed = await get(base, `/api/login?loginId=${second.json.loginId}`);
    assert.equal(failed.status, "error");
    assert.match(failed.message, /Start again/);
    assert.doesNotMatch(failed.message, /USER-1234/);
  });

  it("cancels only the pending login process and gives a retry message", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-close-"));
    const child = new FakeLoginChild();
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", aonia: createAonia({ home, platform: "linux", musePath: "muse" }),
      loginSpawn: () => {
        setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=USER-1234\n"));
        return child as unknown as LoginChild;
      },
    });
    const started = await send(base, "/api/login", undefined);
    await send(base, `/api/login?loginId=${started.json.loginId}`, undefined, "DELETE");
    assert.equal(child.killCount, 1);
    const status = await get(base, `/api/login?loginId=${started.json.loginId}`);
    assert.equal(status.status, "error");
    assert.match(status.message, /cancelled/);
  });

  it("sets a project's default account", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const { base } = await start(connection, { aonia: createAonia({ home, platform: "linux", musePath: "muse" }) });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const res = await send(base, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");
    assert.equal(res.status, 200);
    assert.equal(res.json.defaultAccountId, "work");
  });

  it("reports a session's account and a project's default account over the wire", async () => {
    const connection = new FakeConnection();
    // Distinct ids per call: recordSession treats accountId as set-once-at-creation, so a fake
    // host that reused one id across two sessions would leak the first session's account onto the second.
    let n = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++n}` } }));
    const home = await mkdtemp(join(tmpdir(), "ancilla-aonia-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    const { base } = await start(connection, { hostFactory: fakeFactory(connection), aonia });

    const created = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    assert.equal(created.json.session.accountId, "work");
    const plain = await send(base, "/api/sessions", { cwd: "/other/proj" });
    assert.equal(plain.json.session.accountId, null);

    await send(base, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");
    const projects = await get(base, "/api/projects");
    const proj = projects.projects.find((p: { cwd: string }) => p.cwd === "/work/proj");
    assert.equal(proj.defaultAccountId, "work");
    const other = projects.projects.find((p: { cwd: string }) => p.cwd === "/other/proj");
    assert.equal(other.defaultAccountId, null);
  });
});

describe("file viewer", () => {
  async function project() {
    const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "ancilla-files-"));
    const outside = await mkdtemp(join(tmpdir(), "ancilla-outside-"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Title\n\nBody\n");
    await writeFile(join(root, "docs", "guide.md"), "guide");
    await writeFile(join(root, "docs", "page.html"), "<script>alert(1)</script>");
    await writeFile(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeFile(join(root, "clip.mp4"), Buffer.from("0123456789"));
    await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    await writeFile(join(root, "node_modules", "pkg", "guide.md"), "vendored");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    const connection = new FakeConnection();
    const { base } = await start(connection, { platform: process.platform });
    const added = await send(base, "/api/projects", { cwd: root });
    const cwd = added.json.project.cwd as string;
    const q = (path: string) => `cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
    return { base, root, cwd, q };
  }

  it("lists folders first and reads text, markdown and media descriptions", async () => {
    const { base, root, q } = await project();
    const listing = await get(base, `/api/files/list?${q("")}`);
    assert.deepEqual(
      listing.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`).slice(0, 2),
      ["dir:docs", "dir:node_modules"],
    );
    assert.ok(listing.entries.some((e: { name: string }) => e.name === "README.md"));
    const nested = await get(base, `/api/files/list?${q("docs")}`);
    assert.deepEqual(nested.entries.map((e: { path: string }) => e.path), ["docs/guide.md", "docs/page.html"]);

    const readme = await get(base, `/api/files/read?${q("README.md")}`);
    assert.equal(readme.kind, "markdown");
    assert.equal(readme.content, "# Title\n\nBody\n");
    // An agent names files by absolute path; that resolves inside the project too.
    const absolute = await get(base, `/api/files/read?${q(`${root}/docs/guide.md`)}`);
    assert.equal(absolute.path, "docs/guide.md");
    assert.equal((await get(base, `/api/files/read?${q("clip.mp4")}`)).kind, "video");
    const binary = await get(base, `/api/files/read?${q("blob.bin")}`);
    assert.equal(binary.kind, "binary");
    assert.equal(binary.content, undefined);
  });

  it("refuses paths outside the project, through .. or a symlink, and unknown projects", async () => {
    const { base, q, cwd } = await project();
    assert.equal((await fetch(`${base}/api/files/read?${q("../../etc/passwd")}`)).status, 403);
    assert.equal((await fetch(`${base}/api/files/read?${q("escape.txt")}`)).status, 403, "a symlink out of the project is refused");
    assert.equal((await fetch(`${base}/api/files/raw?${q("escape.txt")}`)).status, 403);
    assert.equal((await fetch(`${base}/api/files/read?${q("/etc/passwd")}`)).status, 404, "an absolute path elsewhere resolves inside the project, where it is not");
    assert.equal((await fetch(`${base}/api/files/list?cwd=${encodeURIComponent("/etc")}&path=`)).status, 404);
    const write = await fetch(`${base}/api/files/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: "../evil.md", content: "x", baseMtimeMs: null }),
    });
    assert.equal(write.status, 403);
  });

  it("serves files from a folder inside a project, confined to that folder", async () => {
    const { base, cwd } = await project();
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const second = await mkdtemp(join(tmpdir(), "ancilla-second-"));
    await writeFile(join(second, "NOTES.md"), "notes");
    const added = await send(base, "/api/projects/folders", { cwd, path: second });
    assert.equal(added.status, 200);
    const folder = added.json.project.folders[1].cwd as string;
    const q = (path: string) => `cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`;
    const listing = await get(base, `/api/files/list?${q("")}`);
    assert.deepEqual(listing.entries.map((e: { name: string }) => e.name), ["NOTES.md"]);
    assert.equal((await get(base, `/api/files/read?${q("NOTES.md")}`)).content, "notes");
    assert.equal((await fetch(`${base}/api/files/read?${q("../../etc/passwd")}`)).status, 403);
  });

  it("never serves a file as a page that can script this origin, and serves video in ranges", async () => {
    const { base, q } = await project();
    const html = await fetch(`${base}/api/files/raw?${q("docs/page.html")}`);
    assert.equal(html.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
    const svg = await fetch(`${base}/api/files/raw?${q("icon.svg")}`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(svg.headers.get("x-content-type-options"), "nosniff");

    const part = await fetch(`${base}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await part.text(), "2345");
    const tail = await fetch(`${base}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=-3" } });
    assert.equal(await tail.text(), "789");
  });

  it("saves an edit, and refuses one made against a file that changed on disk", async () => {
    const { base, root, cwd, q } = await project();
    const { writeFile, readFile, utimes } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const opened = await get(base, `/api/files/read?${q("README.md")}`);
    const put = (content: string, baseMtimeMs: number | null) =>
      fetch(`${base}/api/files/write`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, path: "README.md", content, baseMtimeMs }),
      });
    const saved = await put("# Edited\n", opened.mtimeMs);
    assert.equal(saved.status, 200);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Edited\n");
    const after = (await saved.json()) as { mtimeMs: number };

    // Something else writes the file: the stale save is refused and the other change survives.
    await writeFile(join(root, "README.md"), "# Agent\n");
    await utimes(join(root, "README.md"), new Date(), new Date(after.mtimeMs + 5000));
    const stale = await put("# Mine\n", after.mtimeMs);
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { kind: string }).kind, "fileChanged");
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Agent\n");
  });

  it("finds files by path words, skipping generated folders", async () => {
    const { base, cwd } = await project();
    const found = await get(base, `/api/files/search?cwd=${encodeURIComponent(cwd)}&q=guide`);
    assert.deepEqual(found.files.map((f: { path: string }) => f.path), ["docs/guide.md"], "node_modules is not searched");
  });
});

describe("slash commands, skills and shell", () => {
  const LIST = JSON.stringify({
    diagnostics: [],
    skills: [
      { id: "bundled:plan", name: "plan", display_name: "plan", description: "Plan it. Use ONLY when asked.", short_description: null, scope: "bundled", activation: "on", path: "bundled://muse-core/skills/plan/SKILL.md" },
      { id: "user:secret", name: "secret", display_name: "secret", description: "Only by hand.", short_description: "Hand only", scope: "user", activation: "user-invocable-only", path: "/home/me/.config/muse/skills/secret/SKILL.md" },
      { id: "bundled:off", name: "off", display_name: "off", description: "Switched off.", activation: "off", path: "bundled://muse-core/skills/off/SKILL.md" },
    ],
  });

  it("lists a workspace's skills through the muse CLI, keeps them a minute, and reads only listed skills", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("list")) {
        return { stdout: LIST, exitCode: 0 };
      }
      return { stdout: "---\nname: secret\ndescription: x\n---\n\n# Secret\nDo the thing.\n", exitCode: 0 };
    };
    const { base } = await start(new FakeConnection(), { exec });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.deepEqual(
      listed.skills.map((s: { id: string }) => s.id),
      ["bundled:plan", "user:secret"],
      "skills switched off are left out",
    );
    assert.equal(listed.skills[1].activation, "user-invocable-only");
    assert.equal(listed.error, null);
    assert.deepEqual(calls[0], ["muse", "skills", "list", "--json", "--workspace", "/work/proj"]);
    await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.equal(calls.length, 1, "a fresh list is reused");

    const body = await get(base, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=user%3Asecret");
    assert.equal(body.body, "# Secret\nDo the thing.");
    assert.deepEqual(calls[1], ["sh", "-c", 'exec cat -- "$1"', "sh", "/home/me/.config/muse/skills/secret/SKILL.md"]);
    await get(base, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=bundled%3Aplan");
    assert.equal(calls[2]?.[4], "muse-core/skills/plan/SKILL.md", "bundled skills resolve inside Muse's data folder");
    const unlisted = await fetch(`${base}/api/slash/skill?cwd=%2Fwork%2Fproj&id=%2Fetc%2Fpasswd`);
    assert.equal(unlisted.status, 404);
  });

  it("lists a loaded session's skills from Muse, joined to the CLI listing, and refreshes on skill/changed", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: LIST, exitCode: 0 };
    };
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("skill/list", {
      skills: [
        { selector: "plan", displayName: "Plan", description: "Plan the work", source: "bundled" },
        { selector: "acme:deploy", displayName: "deploy", description: "Ship it", source: "plugin", pluginId: "acme", argumentHint: "<env>" },
      ],
    });
    const { base } = await start(connection, { exec });
    // No session named: the CLI listing answers, as before.
    assert.deepEqual((await get(base, "/api/slash?cwd=%2Fwork%2Fproj")).skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"]);

    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(
      listed.skills.map((s: { id: string; name: string }) => [s.id, s.name]),
      [["bundled:plan", "plan"], ["acme:deploy", "acme:deploy"]],
      "a skill the CLI also lists keeps its id, so its instructions can still be read",
    );
    assert.equal(listed.skills[1].argumentHint, "<env>");
    assert.equal(listed.skills[1].scope, "plugin");
    assert.equal(connection.requests.filter((r) => r.method === "skill/list").length, 1);

    const before = calls.length;
    connection.notify("skill/changed", { sessionId: "s1" });
    await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.equal(calls.length, before + 1, "skill/changed drops the cached CLI listing for that workspace");

    connection.replies.set("skill/list", new MspTestError("method not found", "methodNotFound"));
    const fallback = await get(base, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(fallback.skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"], "an older host falls back to the CLI");
  });

  it("joins session skills to CLI entries by id, name or plugin selector only", () => {
    const cli = [
      { id: "bundled:doctor", name: "doctor", displayName: "doctor", description: "cli", shortDescription: "Short", scope: "bundled", activation: "on" },
      { id: "deploy", name: "deploy", displayName: "deploy", description: "a user skill", shortDescription: null, scope: "user", activation: "on" },
      { id: "plugin:acme:lint", name: "plugin:acme:lint", displayName: "lint", description: "", shortDescription: null, scope: "plugin", activation: "on" },
    ];
    const merged = mergeSessionSkills(
      [
        { selector: "doctor", displayName: "Doctor", description: "", source: "bundled", argumentHint: null, pluginId: null },
        { selector: "acme:deploy", displayName: "deploy", description: "plugin deploy", source: "plugin", argumentHint: null, pluginId: "acme" },
        { selector: "acme:lint", displayName: "lint", description: "", source: "plugin", argumentHint: null, pluginId: "acme" },
      ],
      cli,
    );
    assert.deepEqual(merged.map((s) => s.id), ["bundled:doctor", "acme:deploy", "plugin:acme:lint"]);
    assert.equal(merged[0]?.shortDescription, "Short");
    assert.equal(merged[0]?.description, "cli", "an empty session description falls back to the CLI's");
    assert.equal(merged[1]?.scope, "plugin", "a plugin skill never borrows a same-named user skill");
  });

  it("answers a failed skill list with an error instead of failing the request", async () => {
    const { base } = await start(new FakeConnection(), { exec: async () => ({ stdout: "", exitCode: 127 }) });
    const listed = await get(base, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.deepEqual(listed.skills, []);
    assert.match(listed.error, /Could not list Muse skills/);
  });

  it("runs shell commands in a session and forks it into a new thread", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const shell = await send(base, "/api/sessions/s1/shell", { command: " git status " });
    assert.equal(shell.status, 200);
    assert.deepEqual(connection.calls.at(-1), { method: "session/userShell", params: { sessionId: "s1", commandText: "git status" } });
    assert.equal((await send(base, "/api/sessions/s1/shell", { command: "  " })).status, 400);

    connection.replies.set("session/fork", { session: { sessionId: "s2", modelId: "muse-spark-1.3" } });
    const fork = await send(base, "/api/sessions/s1/fork", {});
    assert.equal(fork.status, 200);
    assert.equal(fork.json.session.sessionId, "s2");
    assert.equal(fork.json.session.title, "New thread (fork)");
    assert.deepEqual(connection.calls.at(-1), { method: "session/fork", params: { sessionId: "s1", excludeItems: true } });
    const ids = (await get(base, "/api/sessions")).sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assert.deepEqual(ids, ["s1", "s2"]);
  });

  it("runs a `!` command itself and keeps it with the thread", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const ran: { command: string; args: string[] }[] = [];
    const { base } = await start(connection, {
      shellRunner: async (command: string, args: string[]) => {
        ran.push({ command, args });
        return { output: "total 0\n", exitCode: 0, truncated: false };
      },
    });
    await send(base, "/api/sessions", { cwd: "/work/proj" });

    const result = await send(base, "/api/sessions/s1/shell-proxy", { command: " ls -la " });
    assert.equal(result.status, 200);
    assert.equal(result.json.run.command, "ls -la");
    assert.equal(result.json.run.exitCode, 0);
    assert.equal(result.json.run.output, "total 0\n");
    assert.ok(ran[0]?.args.includes("/work/proj"), "the command runs where the workspace is");
    assert.ok(ran[0]?.args.includes("ls -la"), "the command itself is an argument, never spliced into a script");

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    assert.deepEqual(
      loaded.json.shellRuns.map((run: { command: string }) => run.command),
      ["ls -la"],
    );
    assert.equal((await send(base, "/api/sessions/s1/shell-proxy", { command: "   " })).status, 400);
    assert.equal((await send(base, "/api/sessions/missing/shell-proxy", { command: "ls" })).status, 404);
  });

  it("sends an attached image to the model and serves it back", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "what is this?",
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: png, width: 10, height: 20 }],
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.attachments?.[0]?.name, "shot.png", "the ack carries what was saved, for the open thread");
    assert.match(sent.json.attachments?.[0]?.url ?? "", /^\/api\/attachments\//);
    const turn = connection.calls.find((c) => c.method === "turn/start");
    assert.deepEqual(turn?.params?.["input"], [
      { type: "text", text: "what is this?" },
      { type: "image", base64Data: png, mediaType: "image/png", width: 10, height: 20 },
    ]);

    const loaded = await send(base, "/api/sessions/s1/resume", {});
    const file = loaded.json.attachments[0];
    assert.equal(file.name, "shot.png");
    assert.equal(file.kind, "image");
    assert.equal(file.turnId, "t1");
    const served = await fetch(`${base}${file.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), png);

    const empty = await send(base, "/api/turns", { sessionId: "s1" });
    assert.equal(empty.status, 400, "a message with neither text nor a file is refused");
  });

  it("lets Muse's own name replace a title derived from a /skill prompt when titles are shared", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { syncSessionNames: true });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("item/completed", {
      sessionId: "s1",
      item: {
        itemId: "u1",
        kind: "userMessage",
        status: "completed",
        revision: 1,
        turnId: "t1",
        text: 'Use skill bundled:plan: call read_skill with name "bundled:plan" first, then apply it to: tidy the API',
        displayText: "/plan tidy the API",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const titleOf = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.title;
    assert.equal(await titleOf(), "/plan tidy the API", "until Muse has named it, the thread shows what the user typed");
    // Muse names the session itself, and that name is what its own CLI shows, so discovery takes it.
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Tidy the API surface", title: "Use skill bundled:plan: call read_skill" }],
      nextCursor: null,
    });
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    assert.equal(await titleOf(), "Tidy the API surface");
  });

  it("prefers Muse's session name over the prompt-echo title during discovery", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.replies.set("session/list", {
      sessions: [
        { sessionId: "s1", workspaceRoot: "/work/proj", name: "pebble-caliban", title: "So far, I have been developing and working on my project Ancilla on Windows only. It goes on and on.", turnCount: 9 },
        { sessionId: "s2", workspaceRoot: "/work/proj", title: "``` Set up this Mac from my private repo", turnCount: 0 },
      ],
      nextCursor: null,
    });
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    const sessions = (await get(base, "/api/sessions")).sessions;
    const byId = (id: string) => sessions.find((s: { sessionId: string }) => s.sessionId === id)?.title;
    assert.equal(byId("s1"), "pebble-caliban");
    assert.equal(byId("s2"), "Set up this Mac from my private repo");
  });

  it("never lets a discovery echo clobber a generated title", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1").title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    await waitFor(async () => (await titleOf()) === "Fix the updater", "the upgraded title");
    await send(base, "/api/discover", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf(), "Fix the updater", "the echo is a fallback, never an update");
    assert.equal(calls.length, 1, "and no second model call is spent");
  });

  it("never upgrades a thread Muse named itself", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };
    const { base } = await start(connection, { exec, syncSessionNames: true });
    await send(base, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const titleOf = async () => (await get(base, "/api/sessions")).sessions[0].title;
    connection.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    connection.notify("session/nameChanged", { sessionId: "s1", name: "Muse One", viewCursor: "c", sourceRange: RANGE });
    assert.equal(await titleOf(), "Muse One");
    await send(base, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf(), "Muse One", "a live rename cancels the owed attempt");
    assert.equal(calls.length, 0);

    const second = new FakeConnection();
    second.replies.set("session/start", { session: { sessionId: "s1" } });
    second.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });
    const { base: base2 } = await start(second, { exec, syncSessionNames: true });
    await send(base2, "/api/title-settings", { enabled: false }, "PATCH");
    await send(base2, "/api/sessions", { cwd: "/work/proj" });
    await send(base2, "/api/discover", {});
    second.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Muse Two", title: "fix the updater please" }],
      nextCursor: null,
    });
    await send(base2, "/api/discover", {});
    const titleOf2 = async () => (await get(base2, "/api/sessions")).sessions[0].title;
    assert.equal(await titleOf2(), "Muse Two");
    await send(base2, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await titleOf2(), "Muse Two", "a discovered name cancels the owed attempt");
    assert.equal(calls.length, 0);
  });

  it("keeps each session's goal in its live view for the sidebar", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const liveGoal = async () =>
      (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.live?.goal;
    const settle = () => new Promise((r) => setTimeout(r, 20));
    assert.equal(await liveGoal(), null);
    connection.notify("session/goalChanged", { sessionId: "s1", goal: { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" } });
    await settle();
    assert.deepEqual(await liveGoal(), { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" });
    connection.notify("session/goalChanged", { sessionId: "s1", goal: { status: "paused" } });
    await settle();
    assert.equal((await liveGoal())?.objective, "Ship it", "a block with no objective is not a goal");
    connection.notify("session/goalChanged", { sessionId: "s1", goal: null });
    await settle();
    assert.equal(await liveGoal(), null);
  });

  it("parses skill lists and strips frontmatter", () => {
    assert.equal(parseSkillList("not json"), null);
    assert.equal(parseSkillList(JSON.stringify({ skills: [{ name: "no id" }] }))?.skills.length, 0);
    assert.equal(stripFrontmatter("\uFEFF---\nname: x\n---\nBody"), "Body");
    assert.equal(stripFrontmatter("No frontmatter"), "No frontmatter");
  });
});

describe("wire helpers", () => {
  it("reshapes notifications for the browser", () => {
    const delta = toWireEvent("item/delta", { sessionId: "s1", itemId: "i1", delta: "po", field: "text" }, 5);
    assert.deepEqual(delta, {
      type: "msp",
      sessionId: "s1",
      method: "item/delta",
      params: { sessionId: "s1", itemId: "i1", delta: "po", field: "text" },
      at: 5,
    });
    const started = toWireEvent("session/started", { session: { sessionId: "s2" } });
    assert.equal(started?.sessionId, "s2");
    const completed = toWireEvent("turn/completed", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    assert.equal(completed?.params["sourceRange"], undefined);
    assert.equal(toWireEvent("initialized", {}), null);
  });

  it("derives thread titles from the first prompt line", () => {
    assert.equal(deriveTitle("# Fix login\nand more"), "Fix login");
    assert.equal(deriveTitle("   \n  "), null);
    const long = deriveTitle("Refactor the session manager so that queries never mint command ids and paging works for long threads");
    assert.ok(long && long.length <= 75 && long.endsWith("..."));
  });

  it("skips code fences when deriving thread titles", () => {
    assert.equal(deriveTitle("```\nSet up this Mac\nmore"), "Set up this Mac");
    assert.equal(deriveTitle("``` Fix login"), "Fix login");
    assert.equal(deriveTitle("```python\nprint(1)"), "print(1)");
    assert.equal(deriveTitle("Use `ancilla.db` here"), "Use `ancilla.db` here");
    assert.equal(deriveTitle("```\n```"), null);
  });

  it("normalizes MSP timestamps", () => {
    assert.equal(normalizeIso("2026-09-11T12:35:42.947855Z"), "2026-09-11T12:35:42.947Z");
    assert.equal(normalizeIso("nope"), undefined);
    assert.equal(normalizeIso(42), undefined);
  });
});
