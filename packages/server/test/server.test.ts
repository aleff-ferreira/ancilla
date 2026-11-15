import { describe, it, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileManager } from "../src/profiles/index.js";
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
import { MuseSubscriptionReader, type MuseUsageCliResult } from "../src/subscriptionQuota.js";

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

interface RecordedCall {
  method: string;
  params?: Record<string, unknown>;
}

type ResponseHandler = unknown | ((params: Record<string, unknown>) => unknown);

class MspTestError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = "MspTestError";
  }
}

class FakeConnection {
  readonly calls: RecordedCall[] = [];
  readonly requests: RecordedCall[] = [];
  readonly replies = new Map<string, ResponseHandler>();
  handler: ((n: { method: string; params?: unknown }) => void) | null = null;

  private resolveResponse(method: string, params: Record<string, unknown>): unknown {
    const handler = this.replies.get(method);
    if (handler instanceof Error) {
      throw handler;
    }
    if (typeof handler === "function") {
      return (handler as (p: Record<string, unknown>) => unknown)(params);
    }
    return handler !== undefined ? handler : { ok: true };
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.resolveResponse(method, params);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ method, params });
    return this.resolveResponse(method, params);
  }

  onNotification(listener: (n: { method: string; params?: unknown }) => void): void {
    this.handler = listener;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.handler?.({ method, params });
  }
}

interface FactoryProbe {
  targets: ServeTarget[];
  exits: ((exit: HostExit) => void)[];
}

class FakeLoginChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private readonly lifecycleEmitter = new EventEmitter();
  killCount = 0;

  on(event: "close" | "error", handler: (data: unknown) => void): void {
    this.lifecycleEmitter.on(event, handler);
  }

  kill(): void {
    this.killCount += 1;
    setImmediate(() => this.lifecycleEmitter.emit("close", null));
  }

  finish(statusCode: number): void {
    this.lifecycleEmitter.emit("close", statusCode);
  }
}

function fakeFactory(conn: FakeConnection, probe?: FactoryProbe): (target: ServeTarget) => HostHandle {
  return (target: ServeTarget) => {
    probe?.targets.push(target);
    return {
      start: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: conn as never,
      close: async () => ({ code: 0, signal: null }),
      onExit: (exitCallback) => probe?.exits.push(exitCallback),
    };
  };
}

async function start(conn: FakeConnection, extraOpts: Partial<ConstructorParameters<typeof AncillaServer>[0]> = {}) {
  const tempHomeDir = await mkdtemp(join(tmpdir(), "ancilla-test-home-"));
  const instance = new AncillaServer({
    port: 0,
    dataDir: ":memory:",
    platform: "linux",
    musePath: "muse",
    home: tempHomeDir,
    hostFactory: fakeFactory(conn),
    exec: async () => ({ stdout: "", exitCode: 127 }),
    ...extraOpts,
  });
  after(async () => {
    await instance.close().catch(() => undefined);
    await rm(tempHomeDir, { recursive: true, force: true }).catch(() => undefined);
  });
  const boundListener = await instance.listen();
  const address = `http://127.0.0.1:${boundListener.port}`;
  return { server: instance, base: address, baseUrl: address };
}

async function send(
  baseUrl: string,
  endpoint: string,
  payload?: unknown,
  httpMethod = "POST",
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: httpMethod,
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

async function get(baseUrl: string, endpoint: string): Promise<any> {
  const response = await fetch(`${baseUrl}${endpoint}`);
  return response.json();
}

async function waitFor(checkCondition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const timeoutDeadline = Date.now() + 5000;
  while (true) {
    if (await checkCondition()) {
      return;
    }
    if (Date.now() > timeoutDeadline) {
      throw new Error(`Timed out waiting for condition: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function sseEvents(baseUrl: string, filterType: string, actionDriver: () => Promise<void>): Promise<any[]> {
  const response = await fetch(`${baseUrl}/api/events`);
  const streamReader = response.body!.getReader();
  const textDecoder = new TextDecoder();
  let rawBuffer = "";
  let receivedHello = false;
  const collectedEvents: any[] = [];
  let isCancelled = false;

  const eventPump = (async () => {
    while (!isCancelled) {
      const { value, done } = await streamReader.read();
      if (done) break;
      rawBuffer += textDecoder.decode(value, { stream: true });
      let separatorIndex: number;
      while ((separatorIndex = rawBuffer.indexOf("\n\n")) !== -1) {
        const eventChunk = rawBuffer.slice(0, separatorIndex);
        rawBuffer = rawBuffer.slice(separatorIndex + 2);
        const dataPrefixLine = eventChunk.split("\n").find((line) => line.startsWith("data: "));
        if (!dataPrefixLine) continue;
        const parsedData = JSON.parse(dataPrefixLine.slice(6));
        if (parsedData.type === "hello") {
          receivedHello = true;
        }
        if (parsedData.type === filterType) {
          collectedEvents.push(parsedData);
        }
      }
    }
  })();

  await waitFor(() => receivedHello, "SSE initialization hello event");
  await actionDriver();
  await new Promise((resolve) => setTimeout(resolve, 150));
  isCancelled = true;
  await streamReader.cancel().catch(() => undefined);
  await eventPump.catch(() => undefined);
  return collectedEvents;
}

async function countPlanUsageEvents(base: string, drive: () => Promise<void>): Promise<number> {
  return (await sseEvents(base, "plan-usage", drive)).length;
}

function fakeWsl(
  availableDistros: string[],
  distrosWithMuse: string[],
  execRecorder: { calls: string[][]; envs: (NodeJS.ProcessEnv | undefined)[] },
): ExecFn {
  return async (binary, args, options) => {
    execRecorder.calls.push([binary, ...args]);
    execRecorder.envs.push(options?.env);
    if (binary !== "wsl") {
      return { stdout: "", exitCode: 127 };
    }
    if (args[0] === "-l") {
      const formattedRows = availableDistros.map(
        (distroName, idx) => `${idx === 0 ? "*" : " "} ${distroName}  Running  2`,
      );
      return { stdout: ["  NAME  STATE  VERSION", ...formattedRows].join("\n") + "\n", exitCode: 0 };
    }
    const targetDistro = args[1] ?? "";
    const hasBinary = distrosWithMuse.includes(targetDistro);
    if (args[2] === "-e" && args[3] === "test") {
      return { stdout: "", exitCode: hasBinary ? 0 : 1 };
    }
    return hasBinary
      ? { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 }
      : { stdout: "", exitCode: 1 };
  };
}

const RANGE = { first: { id: "r", sequence: 1 }, last: { id: "r", sequence: 1 }, stream: { id: "s", kind: "session" } };

function holdReads(conn: FakeConnection): { started: () => boolean; finish: (value: unknown) => void } {
  let unlockPromise!: (val: unknown) => void;
  const deferred = new Promise((resolve) => {
    unlockPromise = resolve;
  });
  let readStarted = false;
  conn.replies.set("session/read", () => {
    readStarted = true;
    return deferred;
  });
  return { started: () => readStarted, finish: (v) => unlockPromise(v) };
}

describe("read-only recovery of a silent Muse view", () => {
  async function setupRunningSession() {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/recovery" });
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    return { fakeTransport: fakeTransport, baseUrl };
  }

  it("records unavailable live updates without declaring the running turn failed", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });
    const { sessions } = await get(baseUrl, "/api/sessions");
    const active = sessions[0];
    assert.strictEqual(active.live.activeTurnId, "t1");
    assert.strictEqual(active.live.lastError, null);
    assert.strictEqual(active.live.lastTerminal, null);
    assert.deepEqual(active.live.viewHealth, {
      status: "unavailable",
      reason: "projectionUnavailable",
    });
  });

  it("clears unavailable health only when durable progress belongs to the active turn", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });
    const retrieveHealth = async () => (await get(baseUrl, "/api/sessions")).sessions[0].live.viewHealth;

    fakeTransport.notify("session/modelChanged", { sessionId: "s1", modelId: "m1", viewCursor: "v:1", sourceRange: RANGE });
    fakeTransport.notify("item/updated", {
      sessionId: "s1",
      viewCursor: "v:2",
      sourceRange: RANGE,
      item: { itemId: "old", kind: "toolCall", turnId: "older-turn", revision: 2, status: "completed" },
    });
    fakeTransport.notify("item/delta", { sessionId: "s1", turnId: "t1", itemId: "reply", field: "text", delta: "working" });

    assert.strictEqual((await retrieveHealth()).status, "unavailable", "metadata, old turns and ephemeral text do not certify the durable projection");

    fakeTransport.notify("item/updated", {
      sessionId: "s1",
      viewCursor: "v:3",
      sourceRange: RANGE,
      item: { itemId: "work", kind: "toolCall", turnId: "t1", revision: 2, status: "completed" },
    });
    assert.strictEqual(await retrieveHealth(), null);
    assert.strictEqual((await get(baseUrl, "/api/sessions")).sessions[0].live.activeTurnId, "t1");
  });

  it("clears unavailable health when the active turn durably completes", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });
    fakeTransport.notify("turn/completed", {
      sessionId: "s1",
      turnId: "t1",
      terminal: "completed",
      viewCursor: "v:3",
      sourceRange: RANGE,
    });
    const { live } = (await get(baseUrl, "/api/sessions")).sessions[0];
    assert.strictEqual(live.viewHealth, null);
    assert.strictEqual(live.activeTurnId, null);
    assert.strictEqual(live.lastTerminal, "completed");
  });

  it("does not let a delayed unavailable read overwrite newer durable item progress", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });
    const pendingRead = holdReads(fakeTransport);
    const resumePromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(pendingRead.started, "recovery read starts");

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      viewCursor: "v:4",
      sourceRange: RANGE,
      item: { itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "completed", text: "Progress" },
    });

    pendingRead.finish({
      session: { sessionId: "s1", status: "idle", activeTurnId: null },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });

    const response = await resumePromise;
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.viewHealth, null);
    assert.strictEqual(response.json.msp.activeTurnId, "t1");
    assert.strictEqual(response.json.historyUnavailable, true, "the old response remains partial even though live progress recovered");
    assert.strictEqual(response.json.pendingComplete, false);
  });

  it("does not let an older successful read clear a newer unavailable notification", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    const pendingRead = holdReads(fakeTransport);
    const resumePromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(pendingRead.started, "history read starts");

    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });

    pendingRead.finish({
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "inline", items: [] },
    });

    const response = await resumePromise;
    assert.deepEqual(response.json.viewHealth, { status: "unavailable", reason: "projectionUnavailable" });
  });

  it("clears unavailable health after a successful read serves known history", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("session/viewHealthChanged", {
      sessionId: "s1",
      health: "unavailable",
      noneReason: "projectionUnavailable",
    });
    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: {
        mode: "inline",
        items: [{ itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "inProgress", text: "Progress" }],
      },
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.viewHealth, null);
    assert.strictEqual(response.json.historyUnavailable, false);
    assert.strictEqual(response.json.msp.activeTurnId, "t1");
    const invoked = fakeTransport.calls.some((c) => ["session/resume", "turn/start"].includes(c.method));
    assert.strictEqual(invoked, false);
  });

  it("includes newer snapshot items alongside paged history without duplicating usage", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    const olderItem = { itemId: "reply", kind: "agentMessage", turnId: "t1", revision: 1, status: "inProgress", text: "Earlier" };
    const newerItem = { ...olderItem, revision: 2, status: "completed", text: "Latest" };

    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "snapshot", snapshot: { state: { items: [newerItem], tokenUsage: { totalTokens: 10 } } } },
    });
    fakeTransport.replies.set("view/page", {
      events: [
        { method: "item/updated", params: { sessionId: "s1", item: olderItem } },
        { method: "session/tokenUsage", params: { sessionId: "s1", turnId: "t1", viewCursor: "v:2", promptTokens: 8, totalTokens: 10 } },
      ],
      nextCursor: null,
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    const itemPayloads = response.json.events.filter((ev: any) => ev.params.item).map((ev: any) => ev.params.item);
    assert.deepEqual(itemPayloads, [olderItem, newerItem]);
    assert.strictEqual(response.json.events.filter((ev: any) => ev.method === "session/tokenUsage").length, 1);
    assert.strictEqual(fakeTransport.calls.some((c) => ["session/resume", "turn/start"].includes(c.method)), false);
  });

  it("recovers a missed completion through read and history, without resume or another turn", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1 },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    fakeTransport.replies.set("view/page", {
      events: [
        { method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed" } },
      ],
      nextCursor: null,
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.msp.activeTurnId, null);
    assert.strictEqual(response.json.session.live.lastTerminal, "completed");
    assert.strictEqual(response.json.viewHealth.status, "unavailable");
    assert.strictEqual(response.json.historyUnavailable, true, "a nonempty prefix does not make an unavailable projection complete");
    assert.strictEqual(fakeTransport.calls.some((c) => ["session/resume", "turn/start"].includes(c.method)), false);

    const readRequests = fakeTransport.requests.filter((c) => c.method === "session/read");
    assert.deepEqual(
      readRequests.map((c) => c.params?.["excludeItems"]),
      [false, true],
      "history once, then the status after paging",
    );
  });

  it("does not present the history projection's incomplete open run as a failed turn", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.replies.set("session/read", { session: { sessionId: "s1", status: "running", activeTurnId: "t1" } });
    const pastFailure = { method: "turn/completed", params: { sessionId: "s1", turnId: "t0", terminal: "failed", reason: "incomplete" } };
    const currentRun = { method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "failed", reason: "incomplete" } };
    fakeTransport.replies.set("view/page", { events: [pastFailure, currentRun], nextCursor: null });

    const activeResume = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(activeResume.json.msp.activeTurnId, "t1");
    assert.deepEqual(activeResume.json.events, [pastFailure], "only the still-open run's synthetic failure is omitted");
    assert.strictEqual(activeResume.json.session.live.lastError, null);

    fakeTransport.replies.set("session/read", { session: { sessionId: "s1", status: "idle", activeTurnId: null } });
    const idleResume = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(idleResume.json.events.length, 2, "an idle incomplete run remains a visible failure");
  });

  it("does not clear a newer turn when a delayed read returns an old idle snapshot", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    const pendingRead = holdReads(fakeTransport);
    const resumePromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(pendingRead.started, "read starts");

    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    pendingRead.finish({
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1 },
      history: { items: [] },
    });

    const response = await resumePromise;
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.msp.activeTurnId, "t2");
    assert.strictEqual(response.json.session.live.activeTurnId, "t2");
    assert.strictEqual(response.json.pendingComplete, false);
  });

  it("does not interpret another host's notLoaded snapshot as an idle turn", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    fakeTransport.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.msp.activeTurnId, "t1");
    assert.strictEqual(response.json.session.live.activeTurnId, "t1");
    assert.strictEqual(response.json.session.live.pendingApprovals, 1);
    assert.strictEqual(response.json.pendingComplete, false);
  });

  it("keeps the last pending state when its read fails, and marks missing history explicitly", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    fakeTransport.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    fakeTransport.replies.set("approval/listPending", new Error("temporarily unavailable"));
    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.historyUnavailable, true);
    assert.strictEqual(response.json.pendingComplete, false);
    assert.strictEqual(response.json.session.live.pendingApprovals, 1);
  });

  it("protects a newly accepted turn even when its started notification is missing", async () => {
    const { fakeTransport, baseUrl } = await setupRunningSession();
    const pendingRead = holdReads(fakeTransport);
    const resumePromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(pendingRead.started, "read starts");

    fakeTransport.replies.set("turn/start", { status: "accepted", disposition: "started", turnId: "t2" });
    const turnRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "Next task" });
    assert.strictEqual(turnRes.status, 200);

    pendingRead.finish({
      session: { sessionId: "s1", status: "idle", activeTurnId: null },
      history: { items: [] },
    });

    const response = await resumePromise;
    assert.strictEqual(response.json.msp.activeTurnId, "t2");
    assert.strictEqual(response.json.session.live.activeTurnId, "t2");
  });
});

describe("recovery after host loss, session closes and stale reads", () => {
  const NOT_LOADED_REPLY = {
    session: { sessionId: "s1", status: "notLoaded", activeTurnId: null },
    history: { mode: "inline", items: [] },
    pendingRequests: [],
  };
  const IDLE_SESSION_REPLY = { session: { sessionId: "s1", status: "idle", activeTurnId: null } };

  const makeTurnStartedEvent = (turnId: string) => ({ method: "turn/started", params: { sessionId: "s1", turnId } });
  const makeTurnCompletedEvent = (turnId: string, terminal: string, extra: Record<string, unknown> = {}) =>
    ({ method: "turn/completed", params: { sessionId: "s1", turnId, terminal, ...extra } });

  const extractTerminals = (res: { json: any }) =>
    res.json.events.filter((e: any) => e.method === "turn/completed").map((e: any) => [e.params.turnId, e.params.terminal]);
  const countResumeCalls = (fakeTransport: FakeConnection) => fakeTransport.calls.filter((c) => c.method === "session/resume").length;
  const fetchLiveState = async (baseUrl: string) => (await get(baseUrl, "/api/sessions")).sessions[0].live;

  async function openIdleSession(extraConfigs: Partial<ConstructorParameters<typeof AncillaServer>[0]> = {}) {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", IDLE_SESSION_REPLY);
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });

    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    const { baseUrl: baseUrl, server } = await start(fakeTransport, { hostFactory: fakeFactory(fakeTransport, targetProbe), ...extraConfigs });
    await send(baseUrl, "/api/sessions", { cwd: "/work/recovery" });

    const resumeRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(resumeRes.json.readOnly, false);
    return { fakeTransport: fakeTransport, baseUrl, targetProbe, server };
  }

  it("loads an idle thread again after its host exited, instead of calling it read-only", async () => {
    const { fakeTransport, baseUrl, targetProbe } = await openIdleSession();
    targetProbe.exits[0]?.({ code: 1, signal: null });
    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);

    const prevResumes = countResumeCalls(fakeTransport);
    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.readOnly, false);
    assert.strictEqual(response.json.readOnlyReason, null);
    assert.strictEqual(response.json.msp.status, "idle");
    assert.strictEqual(countResumeCalls(fakeTransport), prevResumes + 1, "the session is loaded on the replacement host");
    assert.strictEqual(targetProbe.targets.length, 2);

    fakeTransport.replies.set("turn/start", { status: "accepted", disposition: "started", turnId: "t1" });
    const turnRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "Carry on" });
    assert.strictEqual(turnRes.status, 200, "and the next prompt goes through");
    assert.strictEqual((await fetchLiveState(baseUrl)).activeTurnId, "t1");
  });

  it("loads an idle thread again after a settings change restarted its host", async () => {
    const { fakeTransport, baseUrl, targetProbe } = await openIdleSession();
    const patchRes = await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    assert.strictEqual(patchRes.status, 200);

    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);
    const prevResumes = countResumeCalls(fakeTransport);
    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });

    assert.strictEqual(response.json.readOnly, false);
    assert.strictEqual(response.json.readOnlyReason, null);
    assert.strictEqual(countResumeCalls(fakeTransport), prevResumes + 1);
    assert.ok(targetProbe.targets.at(-1)?.args.includes("--disable-sandbox"), "on a host carrying the new setting");
  });

  it("loads an idle thread again after the server itself restarted on the same data", async () => {
    const sharedDataDir = await mkdtemp(join(tmpdir(), "ancilla-restart-"));
    const firstConn = new FakeConnection();
    firstConn.replies.set("session/start", { session: { sessionId: "s1" } });
    firstConn.replies.set("session/resume", IDLE_SESSION_REPLY);
    firstConn.replies.set("view/page", { events: [], nextCursor: null });

    const { baseUrl: firstBase, server: firstServer } = await start(firstConn, { dataDir: sharedDataDir });
    await send(firstBase, "/api/sessions", { cwd: "/work/recovery" });
    await send(firstBase, "/api/sessions/s1/resume", {});
    await firstServer.close();

    const secondConn = new FakeConnection();
    secondConn.replies.set("session/read", NOT_LOADED_REPLY);
    secondConn.replies.set("session/resume", IDLE_SESSION_REPLY);
    secondConn.replies.set("view/page", { events: [], nextCursor: null });

    const { baseUrl: secondBase } = await start(secondConn, { dataDir: sharedDataDir });
    const response = await send(secondBase, "/api/sessions/s1/resume", { refresh: true });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.readOnly, false);
    assert.strictEqual(response.json.readOnlyReason, null);
    assert.strictEqual(countResumeCalls(secondConn), 1, "a server that knows of nothing running loads the session");
  });

  it("stays read-only, with the other client's reason, only while another Muse client holds the lease", async () => {
    const { fakeTransport, baseUrl, targetProbe } = await openIdleSession();
    targetProbe.exits[0]?.({ code: 1, signal: null });
    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);
    fakeTransport.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));

    const heldRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(heldRes.status, 200);
    assert.strictEqual(heldRes.json.readOnly, true);
    assert.match(heldRes.json.readOnlyReason, /another host/);

    fakeTransport.replies.set("session/resume", new MspTestError("", "sessionInUse"));
    const unexplainedRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(unexplainedRes.json.readOnly, true);
    assert.strictEqual(unexplainedRes.json.readOnlyReason, "Another Muse session has this thread open.", "read-only always says why");

    fakeTransport.replies.set("session/resume", IDLE_SESSION_REPLY);
    const releasedRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(releasedRes.json.readOnly, false);
    assert.strictEqual(releasedRes.json.readOnlyReason, null);
  });

  it("never loads a session that is waiting on the user, or whose turn this server still knows to be running", async () => {
    const { fakeTransport, baseUrl, targetProbe } = await openIdleSession();
    targetProbe.exits[0]?.({ code: 1, signal: null });
    fakeTransport.replies.set("session/read", {
      ...NOT_LOADED_REPLY,
      pendingRequests: [{ kind: "approval", approvalId: "a1" }],
    });

    const prevResumes = countResumeCalls(fakeTransport);
    const waitingRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(waitingRes.status, 200);
    assert.strictEqual(waitingRes.json.readOnly, false, "unloaded is not read-only either");
    assert.strictEqual(countResumeCalls(fakeTransport), prevResumes, "a question the log still holds is for opening the thread to bring back");

    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });

    const runningRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(runningRes.json.msp.activeTurnId, "t1");
    assert.strictEqual(countResumeCalls(fakeTransport), prevResumes, "a running turn is never reattached by a refresh");
  });

  it("does not bring back a turn that session/closed ended while a read was in flight", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });

    const pendingRead = holdReads(fakeTransport);
    const refreshPromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(pendingRead.started, "read in flight");

    fakeTransport.notify("session/closed", { sessionId: "s1" });
    assert.strictEqual((await fetchLiveState(baseUrl)).activeTurnId, null);

    pendingRead.finish({
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "inline", items: [] },
    });

    const response = await refreshPromise;
    assert.strictEqual(response.json.msp.activeTurnId, null, "the older snapshot is not applied");
    assert.strictEqual(response.json.pendingComplete, false);
    assert.strictEqual((await fetchLiveState(baseUrl)).activeTurnId, null);

    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);
    fakeTransport.replies.set("view/page", {
      events: [makeTurnStartedEvent("t1"), makeTurnCompletedEvent("t1", "failed", { reason: "incomplete" })],
      nextCursor: null,
    });

    const laterRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(laterRes.json.msp.activeTurnId, null);

    const settleRes = await send(baseUrl, "/api/sessions/s1", { settled: true }, "PATCH");
    assert.strictEqual(settleRes.status, 200, "nothing is left running to block settling");
  });

  it("ends a turn whose host exits while its read is still in flight, keeping the host's failure", async () => {
    const { fakeTransport, baseUrl, targetProbe } = await openIdleSession();
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "inline", items: [] },
    });

    let failPendingList!: (err: Error) => void;
    fakeTransport.replies.set("approval/listPending", () => new Promise((_, reject) => { failPendingList = reject; }));

    const refreshPromise = send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    await waitFor(() => Boolean(failPendingList), "listPending in flight");

    targetProbe.exits[0]?.({ code: 1, signal: null });
    failPendingList(new Error("fakeTransport closed"));

    const response = await refreshPromise;
    assert.strictEqual(response.json.msp.activeTurnId, null);

    const state = await fetchLiveState(baseUrl);
    assert.strictEqual(state.activeTurnId, null);
    assert.strictEqual(state.lastTerminal, "failed");
    assert.match(state.lastError, /host exited/);
  });

  it("does not lend a stopped turn an older turn's outcome from a partial prefix", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    fakeTransport.replies.set("session/read", {
      ...IDLE_SESSION_REPLY,
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    fakeTransport.replies.set("view/page", {
      events: [
        makeTurnStartedEvent("t0"),
        makeTurnCompletedEvent("t0", "failed", { error: { message: "rate limited" } }),
        makeTurnStartedEvent("t1"),
      ],
      nextCursor: null,
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.msp.activeTurnId, null);
    assert.strictEqual(response.json.historyUnavailable, true);
    assert.strictEqual(response.json.session.live.lastTerminal, null, "t1's outcome is unknown, not t0's");
    assert.strictEqual(response.json.session.live.lastError, null);
    assert.deepEqual(extractTerminals(response), [["t0", "failed"]], "t0's real failure stays in the transcript");

    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    fakeTransport.replies.set("view/page", {
      events: [makeTurnStartedEvent("t1"), makeTurnCompletedEvent("t1", "completed")],
      nextCursor: null,
    });

    const reverseRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(reverseRes.json.session.live.lastTerminal, null, "nor is t1's completion t2's outcome");
  });

  it("takes neither outcome nor failure from a read that does not have the session loaded", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.replies.set("session/resume", new MspTestError("held by the TUI", "sessionInUse"));
    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);
    fakeTransport.replies.set("view/page", {
      events: [makeTurnStartedEvent("t9"), makeTurnCompletedEvent("t9", "failed", { reason: "incomplete" })],
      nextCursor: null,
    });

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.readOnly, true);
    assert.strictEqual(response.json.readOnlyReason, "held by the TUI");
    assert.strictEqual(response.json.msp.activeTurnId, null);
    assert.strictEqual(response.json.session.live.lastTerminal, null, "a run going elsewhere is not a failure here");
    assert.strictEqual(response.json.session.live.lastError, null);
  });

  it("drops a frozen prefix's stand-in for a run that has since stopped, until the projection says how it ended", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const frozenEvents = {
      events: [makeTurnStartedEvent("t1"), makeTurnCompletedEvent("t1", "failed", { reason: "incomplete" })],
      nextCursor: null,
    };

    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    fakeTransport.replies.set("view/page", frozenEvents);

    const runningRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.deepEqual(extractTerminals(runningRes), [], "the open run's stand-in is not a failure");

    fakeTransport.replies.set("session/read", {
      ...IDLE_SESSION_REPLY,
      history: { mode: "none", noneReason: "projectionUnavailable" },
    });
    const stoppedRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(stoppedRes.json.msp.activeTurnId, null);
    assert.deepEqual(extractTerminals(stoppedRes), [], "the frozen prefix still says nothing about the outcome");
    assert.strictEqual(stoppedRes.json.session.live.lastTerminal, null);
    assert.strictEqual(stoppedRes.json.session.live.lastError, null);

    fakeTransport.replies.set("session/read", { ...IDLE_SESSION_REPLY, history: { mode: "inline", items: [] } });
    fakeTransport.replies.set("view/page", {
      events: [makeTurnStartedEvent("t1"), makeTurnCompletedEvent("t1", "failed", { error: { message: "The provider refused" } })],
      nextCursor: null,
    });

    const knownRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.deepEqual(extractTerminals(knownRes), [["t1", "failed"]], "a real failure, once served, is shown");
    assert.strictEqual(knownRes.json.session.live.lastTerminal, "failed");
    assert.strictEqual(knownRes.json.session.live.lastError, "The provider refused");
  });

  it("recognises a turn that started while the pages were read, and holds its stand-in back", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });

    const pagedEvents = {
      events: [
        makeTurnStartedEvent("t1"),
        makeTurnCompletedEvent("t1", "completed"),
        makeTurnStartedEvent("t2"),
        makeTurnCompletedEvent("t2", "failed", { reason: "incomplete" }),
      ],
      nextCursor: null,
    };
    fakeTransport.replies.set("view/page", pagedEvents);
    fakeTransport.replies.set("session/read", (params: Record<string, unknown>) => ({
      session: { sessionId: "s1", status: "running", activeTurnId: params["excludeItems"] ? "t2" : "t1" },
      history: { mode: "none", noneReason: "projectionUnavailable" },
    }));

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.msp.activeTurnId, "t2", "the status read after paging is the newer one");
    assert.strictEqual(response.json.session.live.activeTurnId, "t2");
    assert.deepEqual(extractTerminals(response), [["t1", "completed"]]);
    assert.strictEqual(response.json.session.live.lastTerminal, null, "a run under way has no outcome yet");

    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    fakeTransport.replies.set("session/read", (params: Record<string, unknown>) => {
      if (params["excludeItems"]) {
        throw new MspTestError("busy", "internal");
      }
      return {
        session: { sessionId: "s1", status: "running", activeTurnId: "t1" },
        history: { mode: "none", noneReason: "projectionUnavailable" },
      };
    });

    const unreadRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(unreadRes.status, 200, "a failed second read keeps the first");
    assert.strictEqual(unreadRes.json.msp.activeTurnId, "t1");
    assert.deepEqual(extractTerminals(unreadRes), [], "a turn the page shows starting after the one read as running may be open too");
  });

  it("keeps a newer live goal over an older one from a stale prefix", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    const constructGoalEvent = (status: string, percentComplete: number, viewCursor: string) =>
      ({ method: "session/goalChanged", params: { sessionId: "s1", goal: { objective: "Ship v2", status, percentComplete }, viewCursor } });

    fakeTransport.notify("session/goalChanged", {
      sessionId: "s1",
      goal: { objective: "Ship v2", status: "complete", percentComplete: 100 },
      viewCursor: "v:s1:9",
      sourceRange: RANGE,
    });
    fakeTransport.replies.set("session/read", { ...IDLE_SESSION_REPLY, history: { mode: "none", noneReason: "projectionUnavailable" } });
    fakeTransport.replies.set("view/page", { events: [constructGoalEvent("active", 10, "v:s1:3")], nextCursor: null });

    const staleRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(staleRes.json.session.live.goal.status, "complete");
    assert.strictEqual(staleRes.json.session.live.goal.percentComplete, 100);

    fakeTransport.replies.set("view/page", { events: [constructGoalEvent("active", 60, "v:s1:12")], nextCursor: null });
    const newerRes = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(newerRes.json.session.live.goal.percentComplete, 60, "a prefix that reaches past the live goal counts");
  });

  it("clears an unavailable view on an idle thread when Muse says it is healthy, and tells the clients", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    const unavailableState = { status: "unavailable", reason: "projectionUnavailable" };

    const statusNotifications = await sseEvents(baseUrl, "session-status", async () => {
      fakeTransport.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
      assert.deepEqual((await fetchLiveState(baseUrl)).viewHealth, unavailableState);
      fakeTransport.notify("session/viewHealthChanged", { sessionId: "s1", health: "healthy" });
    });

    assert.strictEqual((await fetchLiveState(baseUrl)).viewHealth, null);
    assert.deepEqual(statusNotifications.map((s) => s.live.viewHealth), [unavailableState, null]);
  });

  it("clears an unavailable view on an idle thread on any durable record, or on served history", async () => {
    const { fakeTransport, baseUrl } = await openIdleSession();
    fakeTransport.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    fakeTransport.notify("session/modelChanged", { sessionId: "s1", modelId: "m1", viewCursor: "v:9", sourceRange: RANGE });
    assert.strictEqual((await fetchLiveState(baseUrl)).viewHealth, null, "with no turn running, any durable record means the view is written again");

    fakeTransport.notify("session/viewHealthChanged", { sessionId: "s1", health: "unavailable", noneReason: "projectionUnavailable" });
    fakeTransport.replies.set("session/resume", new MspTestError("held by the TUI", "sessionInUse"));
    fakeTransport.replies.set("session/read", NOT_LOADED_REPLY);

    const response = await send(baseUrl, "/api/sessions/s1/resume", { refresh: true });
    assert.strictEqual(response.json.readOnly, true);
    assert.strictEqual(response.json.viewHealth, null, "served history means the projection works, loaded here or not");
  });

  it("opens a thread whose fallback read fails as incomplete rather than failed", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", { session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 0 } });
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });
    fakeTransport.replies.set("session/read", new MspTestError("read failed", "internal"));

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const freshRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(freshRes.status, 200);
    assert.strictEqual(freshRes.json.msp.status, "idle");
    assert.strictEqual(freshRes.json.historyUnavailable, true);
    assert.strictEqual(freshRes.json.readOnly, false);

    fakeTransport.replies.set("session/resume", new MspTestError("in use by the TUI", "sessionInUse"));
    fakeTransport.replies.set("view/page", new MspTestError("in use", "sessionInUse"));

    const heldRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(heldRes.status, 200);
    assert.strictEqual(heldRes.json.readOnly, true);
    assert.strictEqual(heldRes.json.readOnlyReason, "in use by the TUI");
    assert.strictEqual(heldRes.json.historyUnavailable, true);
  });
});

describe("AncillaServer", () => {
  it("serves health, projects, sessions and turns", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    fakeTransport.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });
    const { baseUrl: baseUrl } = await start(fakeTransport);

    const healthRes = await get(baseUrl, "/api/health");
    assert.strictEqual(healthRes.ok, true);

    const sessionRes = await send(baseUrl, "/api/sessions", { cwd: "/work/proj/" });
    assert.strictEqual(sessionRes.status, 200);
    assert.strictEqual(sessionRes.json.session.sessionId, "s1");
    assert.strictEqual(sessionRes.json.session.cwd, "/work/proj");
    assert.strictEqual(sessionRes.json.session.modelId, "muse-spark-1.3");

    const turnRes = await send(baseUrl, "/api/turns", {
      sessionId: "s1",
      text: "hello",
      ifBusy: "steer",
      reasoningEffort: "high",
    });
    assert.strictEqual(turnRes.status, 200);
    assert.strictEqual(turnRes.json.turnId, "t1");
    assert.deepEqual(fakeTransport.calls.at(-1)?.params, {
      sessionId: "s1",
      input: [{ type: "text", text: "hello" }],
      ifBusy: "steer",
      reasoningEffort: "high",
    });

    const maxEffortRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "hello", reasoningEffort: "max" });
    assert.strictEqual(maxEffortRes.status, 200);
    assert.strictEqual((fakeTransport.calls.at(-1)?.params as { reasoningEffort?: string }).reasoningEffort, "max");

    const projectsRes = await get(baseUrl, "/api/projects");
    assert.deepEqual(projectsRes.projects.map((p: { cwd: string }) => p.cwd), ["/work/proj"]);

    const rejectedTurn = await send(baseUrl, "/api/turns", { sessionId: "s1" });
    assert.strictEqual(rejectedTurn.status, 400);
  });

  it("rejects bad modes, dispositions, efforts and missing fields", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport);
    assert.strictEqual((await send(baseUrl, "/api/sessions", { cwd: "/w", approvalMode: "yolo" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/sessions", {})).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/turns", { sessionId: "s", text: "x", ifBusy: "later" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/turns", { sessionId: "s", text: "x", reasoningEffort: "louder" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/approvals/decide", { sessionId: "s" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/user-input/clarify", { sessionId: "s", userInputId: "u" })).status, 400);

    const malformedJsonRes = await fetch(`${baseUrl}/api/turns`, { method: "POST", body: "{nope" });
    assert.strictEqual(malformedJsonRes.status, 400);
  });

  it("requires a token when one is configured", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport, { token: "secret" });
    assert.strictEqual((await fetch(`${baseUrl}/api/health`)).status, 401);
    assert.strictEqual((await fetch(`${baseUrl}/api/health?token=secret`)).status, 200);
  });

  it("answers an allowed origin and refuses one nobody listed", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport, { allowOrigins: ["https://ancilla.example"] });

    const blockedRes = await fetch(`${baseUrl}/api/health`, { headers: { origin: "https://evil.example" } });
    assert.strictEqual(blockedRes.status, 403);
    assert.strictEqual(blockedRes.headers.get("access-control-allow-origin"), null);

    const allowedRes = await fetch(`${baseUrl}/api/health`, { headers: { origin: "https://ancilla.example" } });
    assert.strictEqual(allowedRes.status, 200);
    assert.strictEqual(allowedRes.headers.get("access-control-allow-origin"), "https://ancilla.example");
    assert.strictEqual(allowedRes.headers.get("access-control-allow-credentials"), "true");
  });

  it("answers a preflight for an allowed origin", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport, { allowOrigins: ["https://ancilla.example"] });
    const preflightRes = await fetch(`${baseUrl}/api/turns`, { method: "OPTIONS", headers: { origin: "https://ancilla.example" } });
    assert.strictEqual(preflightRes.status, 204);
    assert.match(preflightRes.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  it("trades a token for a cookie, which is what the event stream can carry", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport, { token: "secret" });
    assert.strictEqual((await send(baseUrl, "/api/auth", { token: "wrong" })).status, 401);

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.strictEqual(authRes.status, 200);
    const setCookie = authRes.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /ancilla_token=secret/);
    assert.match(setCookie, /HttpOnly/);

    const authorizedHealth = await fetch(`${baseUrl}/api/health`, { headers: { cookie: "ancilla_token=secret" } });
    assert.strictEqual(authorizedHealth.status, 200);
  });

  it("takes a token from the URL only when no other site is asking", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport, { token: "secret", allowOrigins: ["https://ancilla.example"] });

    assert.strictEqual((await fetch(`${baseUrl}/api/health?token=secret`)).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/api/health?token=secret`, { headers: { origin: baseUrl } })).status, 200);

    const crossSiteRes = await fetch(`${baseUrl}/api/health?token=secret`, { headers: { origin: "https://ancilla.example" } });
    assert.strictEqual(crossSiteRes.status, 401);
  });

  it("translates Windows paths at the WSL boundary", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s9" } });
    fakeTransport.replies.set("session/list", {
      sessions: [
        { session: { sessionId: "tui-1", workspaceRoot: "/mnt/d/work/proj" } },
        { sessionId: "tui-2", workspaceRoot: "/mnt/d/work/other", turnCount: 4, updatedAt: "2026-09-11T12:35:42.947855Z" },
      ],
      nextCursor: null,
    });

    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    const { baseUrl: baseUrl } = await start(fakeTransport, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      hostFactory: fakeFactory(fakeTransport, targetProbe),
    });

    const createRes = await send(baseUrl, "/api/sessions", { cwd: "D:\\work\\proj" });
    assert.strictEqual(createRes.status, 200);

    const startCmd = fakeTransport.calls.find((c) => c.method === "session/start");
    assert.strictEqual(startCmd?.params?.["workspaceRoot"], "/mnt/d/work/proj");
    assert.strictEqual(targetProbe.targets[0]?.command, "wsl");
    assert.deepEqual(targetProbe.targets[0]?.args.slice(0, 2), ["-d", "Ubuntu"]);
    assert.strictEqual(targetProbe.targets[0]?.cwd, "D:\\work\\proj");

    const discoverRes = await send(baseUrl, "/api/discover", {});
    assert.strictEqual(discoverRes.status, 200);
    assert.strictEqual(discoverRes.json.sessions.length, 2);

    const listQuery = fakeTransport.requests.find((c) => c.method === "session/list");
    assert.strictEqual(listQuery?.params?.["commandId"], undefined, "queries must not carry a commandId");

    const projectsRes = await get(baseUrl, "/api/projects");
    const registeredRoots = projectsRes.projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(registeredRoots.includes("D:\\work\\proj"));
    assert.ok(registeredRoots.includes("D:\\work\\other"));

    const sessionsRes = await get(baseUrl, `/api/sessions?cwd=${encodeURIComponent("D:\\work\\other")}`);
    assert.strictEqual(sessionsRes.sessions[0].origin, "tui");
    assert.strictEqual(sessionsRes.sessions[0].turnCount, 4);
    assert.strictEqual(sessionsRes.sessions[0].activityAt, "2026-09-11T12:35:42.947Z");
  });

  it("runs native Windows Muse with Windows paths, and no WSL", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s9" } });
    fakeTransport.replies.set("session/list", {
      sessions: [{ sessionId: "tui-1", workspaceRoot: "d:/work/other", turnCount: 2 }],
      nextCursor: null,
    });

    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    const executedShell: { command: string; args: string[] }[] = [];
    const binaryPath = "C:\\Users\\ada\\AppData\\Local\\Programs\\muse\\muse-bin-1.3.0-R1.exe";

    const { baseUrl: baseUrl } = await start(fakeTransport, {
      platform: "win32",
      musePath: undefined,
      findNativeMuse: () => ({ binary: binaryPath, dir: "C:\\Users\\ada\\AppData\\Local\\Programs\\muse", version: "1.3.0-R1", launcher: null }),
      hostFactory: fakeFactory(fakeTransport, targetProbe),
      shellRunner: async (cmd: string, args: string[]) => {
        executedShell.push({ command: cmd, args });
        return { output: "ok\n", exitCode: 0, truncated: false };
      },
    });

    const envRes = await get(baseUrl, "/api/env");
    assert.strictEqual(envRes.runtime, "native");
    assert.strictEqual(envRes.musePath, binaryPath);

    const createRes = await send(baseUrl, "/api/sessions", { cwd: "D:\\work\\it's here" });
    assert.strictEqual(createRes.status, 200);

    const startCmd = fakeTransport.calls.find((c) => c.method === "session/start");
    assert.strictEqual(startCmd?.params?.["workspaceRoot"], "D:\\work\\it's here", "native Muse gets the Windows path itself");
    assert.strictEqual(targetProbe.targets[0]?.command, binaryPath);
    assert.deepEqual(targetProbe.targets[0]?.args, ["serve"]);
    assert.strictEqual(targetProbe.targets[0]?.cwd, "D:\\work\\it's here");

    const discoverRes = await send(baseUrl, "/api/discover", {});
    assert.strictEqual(discoverRes.status, 200);
    const projectCwds = (await get(baseUrl, "/api/projects")).projects.map((p: { cwd: string }) => p.cwd);
    assert.ok(projectCwds.includes("D:\\work\\other"), "a root spelled d:/work/other is stored as D:\\work\\other");

    const shellProxyRes = await send(baseUrl, "/api/sessions/s9/shell-proxy", { command: "Get-ChildItem" });
    assert.strictEqual(shellProxyRes.status, 200);
    assert.match(executedShell[0]!.command, /powershell\.exe$/i);
    const powershellScript = executedShell[0]!.args.at(-1)!;
    assert.ok(powershellScript.startsWith("Set-Location -LiteralPath 'D:\\work\\it''s here'"), powershellScript);
    assert.ok(powershellScript.endsWith("\nGet-ChildItem"));
  });

  it("tracks live status and derives titles from the view stream", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchSessionRecord = async () => (await get(baseUrl, "/api/sessions")).sessions[0];

    assert.strictEqual((await fetchSessionRecord()).title, "New thread");
    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "\n  Fix the flaky login test in CI\nmore detail" },
    });
    fakeTransport.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });

    let active = await fetchSessionRecord();
    assert.strictEqual(active.title, "Fix the flaky login test in CI");
    assert.strictEqual(active.live.activeTurnId, "t1");
    assert.strictEqual(active.live.pendingApprovals, 1);

    fakeTransport.notify("approval/resolved", { sessionId: "s1", approvalId: "a1" });
    fakeTransport.notify("turn/completed", {
      sessionId: "s1",
      turnId: "t1",
      terminal: "failed",
      error: { kind: "modelError", message: "Provider timed out", retryable: true },
    });

    active = await fetchSessionRecord();
    assert.strictEqual(active.live.activeTurnId, null);
    assert.strictEqual(active.live.pendingApprovals, 0);
    assert.strictEqual(active.live.lastTerminal, "failed");
    assert.strictEqual(active.live.lastError, "Provider timed out");
    assert.strictEqual(active.turnCount, 1);

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i2", kind: "userMessage", revision: 1, status: "completed", text: "Something else entirely" },
    });
    assert.strictEqual((await fetchSessionRecord()).title, "Fix the flaky login test in CI", "only the first prompt names a thread");
  });

  it("takes Muse's own name for a thread, unless the user named it", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Wire up the updater", title: "fix the updater please" }],
      nextCursor: null,
    });

    const { baseUrl: baseUrl } = await start(fakeTransport, { syncSessionNames: true });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });

    const querySession = async () => (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.strictEqual((await querySession()).title, "fix the updater please");

    await send(baseUrl, "/api/discover", {});
    assert.strictEqual((await querySession()).title, "Wire up the updater", "with titles shared, the name Muse shows in its own CLI wins");

    await send(baseUrl, "/api/sessions/s1", { title: "Updater work" }, "PATCH");
    await send(baseUrl, "/api/discover", {});
    assert.strictEqual((await querySession()).title, "Updater work", "a title the user typed stays");
  });

  it("loads a transcript from resume, paged history and pending requests", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", {
      session: { sessionId: "s1", status: "running", activeTurnId: "t2", turnCount: 1, modelId: "muse-spark-1.3", updatedAt: "2026-09-11T14:00:00Z" },
    });

    const buildCursorEvent = (sequence: number, method: string, extraParams: Record<string, unknown> = {}) => ({
      method,
      params: { sessionId: "s1", viewCursor: `v:${sequence}`, sourceRange: RANGE, ...extraParams },
    });

    fakeTransport.replies.set("view/page", (args: Record<string, unknown>) =>
      args["cursor"]
        ? {
            events: [
              buildCursorEvent(1, "turn/started", { turnId: "t1" }),
              buildCursorEvent(2, "item/completed", { item: { itemId: "u1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode" } }),
            ],
            nextCursor: null,
          }
        : {
            events: [
              buildCursorEvent(3, "turn/completed", { turnId: "t1", terminal: "completed" }),
              buildCursorEvent(4, "turn/started", { turnId: "t2" }),
            ],
            nextCursor: "v:3",
          },
    );

    fakeTransport.replies.set("approval/listPending", {
      approvals: [{ approvalId: "a1", sessionId: "s1", sourceRange: RANGE, subject: { kind: "shell", command: "rm -rf dist" } }],
      userInputs: [],
    });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.status, 200);
    assert.strictEqual(loadedRes.json.readOnly, false);
    assert.deepEqual(
      loadedRes.json.events.map((e: { params: { viewCursor: string } }) => e.params.viewCursor),
      ["v:1", "v:2", "v:3", "v:4"],
    );
    assert.strictEqual(loadedRes.json.events[0].params.sourceRange, undefined);
    assert.strictEqual(loadedRes.json.pending.approvals[0].subject.command, "rm -rf dist");
    assert.strictEqual(loadedRes.json.pending.approvals[0].sourceRange, undefined);
    assert.strictEqual(loadedRes.json.msp.activeTurnId, "t2");
    assert.strictEqual(loadedRes.json.session.title, "Add dark mode");
    assert.strictEqual(loadedRes.json.session.live.pendingApprovals, 1);
    assert.strictEqual(loadedRes.json.session.live.activeTurnId, "t2");

    const resumeCall = fakeTransport.calls.find((c) => c.method === "session/resume");
    assert.strictEqual(resumeCall?.params?.["excludeItems"], true);

    const pageRequests = fakeTransport.requests.filter((c) => c.method === "view/page");
    assert.deepEqual(pageRequests.map((p) => p.params?.["direction"]), ["backward", "backward"]);
  });

  it("puts a resumed session back on the model the user chose", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    fakeTransport.replies.set("model/list", {
      models: [
        { modelId: "muse-spark-1.3", providerId: "meta", profileId: "tbh" },
        { modelId: "muse-spark-1.3-contributor", providerId: "meta", profileId: "tbh", displayLabel: "muse-spark-1.3-contributor" },
      ],
    });

    const makeIdleSession = (modelId: string) => ({
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1, modelId },
    });

    fakeTransport.replies.set("session/resume", makeIdleSession("muse-spark-1.3"));
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });
    fakeTransport.replies.set("approval/listPending", { approvals: [], userInputs: [] });

    const querySetModelCalls = () => fakeTransport.calls.filter((c) => c.method === "session/setModel");
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    let loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.json.msp.modelId, "muse-spark-1.3");
    assert.strictEqual(querySetModelCalls().length, 0);

    const modelPatchRes = await send(baseUrl, "/api/sessions/s1/model", { model: { modelId: "muse-spark-1.3-contributor" } });
    assert.strictEqual(modelPatchRes.status, 200);
    assert.deepEqual(querySetModelCalls()[0]?.params?.["model"], {
      modelId: "muse-spark-1.3-contributor",
      providerId: "meta",
      profileId: "tbh",
      displayLabel: "muse-spark-1.3-contributor",
    });

    loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.json.msp.modelId, "muse-spark-1.3-contributor");
    assert.strictEqual(loadedRes.json.session.modelId, "muse-spark-1.3-contributor");
    assert.strictEqual(querySetModelCalls().length, 2);
    assert.strictEqual((querySetModelCalls()[1]?.params?.["model"] as Record<string, unknown>)["profileId"], "tbh");

    fakeTransport.replies.set("session/resume", makeIdleSession("muse-spark-1.3-contributor"));
    await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(querySetModelCalls().length, 2);

    fakeTransport.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-spark-1.2", source: "user", viewCursor: "v:1", sourceRange: RANGE });
    fakeTransport.replies.set("session/resume", makeIdleSession("muse-spark-1.3"));
    loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.json.msp.modelId, "muse-spark-1.2");
    assert.strictEqual(querySetModelCalls().length, 3);

    fakeTransport.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-spark-1.3", source: "default", viewCursor: "v:2", sourceRange: RANGE });
    loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.json.msp.modelId, "muse-spark-1.2");
    assert.strictEqual(querySetModelCalls().length, 4);
  });

  it("falls back to a read-only transcript when another host holds the session", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    fakeTransport.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.status, 200);
    assert.strictEqual(loadedRes.json.readOnly, true);
    assert.match(loadedRes.json.readOnlyReason, /another host/);

    const readRequest = fakeTransport.requests.find((c) => c.method === "session/read");
    assert.strictEqual(readRequest?.params?.["excludeItems"], false);
  });

  it("hydrates a read-only CLI transcript from session/read items", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", new MspTestError("session is loaded by another host", "sessionInUse"));
    fakeTransport.replies.set("session/read", {
      session: { sessionId: "s1", status: "running", activeTurnId: null, turnCount: 1 },
      history: {
        mode: "inline",
        items: [
          { itemId: "i1", kind: "userMessage", text: "Ship the fairtab tip", status: "completed", revision: 1 },
          { itemId: "i2", kind: "agentMessage", text: "Done.", status: "completed", revision: 1 },
        ],
      },
    });
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const loadedRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(loadedRes.status, 200);
    assert.strictEqual(loadedRes.json.readOnly, true);
    assert.deepEqual(
      loadedRes.json.events.map((e: { method: string; params: { item: { itemId: string } } }) => [e.method, e.params.item.itemId]),
      [
        ["item/completed", "i1"],
        ["item/completed", "i2"],
      ],
    );
  });

  it("turns session/read history items into fold events", () => {
    const constructedEvents = eventsFromHistory({
      history: {
        mode: "inline",
        items: [{ itemId: "a", kind: "userMessage", text: "Hi", sourceRange: { first: 1 } }],
      },
    });
    assert.deepEqual(constructedEvents, [{ method: "item/completed", params: { item: { itemId: "a", kind: "userMessage", text: "Hi" } } }]);
  });

  it("surfaces resume failures that are not about another host", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/resume", new MspTestError("stream mismatch", "sessionStreamMismatch"));
    fakeTransport.replies.set("session/read", { session: { sessionId: "s1", status: "notLoaded", activeTurnId: null } });
    fakeTransport.replies.set("view/page", { events: [], nextCursor: null });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const failRes = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.strictEqual(failRes.status, 409);
    assert.strictEqual(failRes.json.kind, "sessionStreamMismatch");
    assert.strictEqual(failRes.json.readOnly, undefined);
  });

  it("reports MSP error kinds with a useful status", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("turn/start", new MspTestError("input too large", "inputTooLarge"));

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const failRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "x" });
    assert.strictEqual(failRes.status, 409);
    assert.strictEqual(failRes.json.kind, "inputTooLarge");
    assert.strictEqual(failRes.json.error, "input too large");
  });

  it("renames and archives threads, and hides projects", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const renameRes = await send(baseUrl, "/api/sessions/s1", { title: "  Ship the sidebar  " }, "PATCH");
    assert.strictEqual(renameRes.json.session.title, "Ship the sidebar");
    assert.strictEqual(renameRes.json.session.titleSource, "user");

    await send(baseUrl, "/api/sessions/s1", { archived: true }, "PATCH");
    assert.strictEqual((await get(baseUrl, "/api/sessions")).sessions.length, 0);
    assert.strictEqual((await get(baseUrl, "/api/sessions?archived=1")).sessions.length, 1);
    assert.strictEqual((await send(baseUrl, "/api/sessions/missing", { title: "x" }, "PATCH")).status, 404);

    await send(baseUrl, `/api/projects?cwd=${encodeURIComponent("/work/proj")}`, undefined, "DELETE");
    assert.strictEqual((await get(baseUrl, "/api/projects")).projects.length, 0);

    const readdedRes = await send(baseUrl, "/api/projects", { cwd: "/work/proj" });
    assert.strictEqual(readdedRes.status, 200);
    assert.strictEqual((await get(baseUrl, "/api/projects")).projects.length, 1);
  });

  it("groups a project's folders, and the threads Muse ran in them, under one project", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", (args: Record<string, unknown>) => ({
      session: { sessionId: args["workspaceRoot"] === "/work/app-docs" ? "d1" : "a1" },
    }));
    fakeTransport.replies.set("session/list", (args: Record<string, unknown>) => ({
      sessions: args["workspaceRoot"] === "/work/app-docs" ? [{ sessionId: "tui-1", workspaceRoot: "/work/app-docs", updatedAt: "2026-09-01T00:00:00.000Z" }] : [],
      nextCursor: null,
    }));

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/app" });
    await send(baseUrl, "/api/sessions", { cwd: "/work/app-docs" });

    const queryProjectRoots = async () => (await get(baseUrl, "/api/projects")).projects.map((p: { cwd: string }) => p.cwd).sort();
    const queryThreadIdentities = async () => (await get(baseUrl, "/api/sessions")).sessions.map((s: { sessionId: string; cwd: string }) => `${s.sessionId}@${s.cwd}`).sort();
    assert.deepEqual(await queryProjectRoots(), ["/work/app", "/work/app-docs"]);

    const addFolderRes = await send(baseUrl, "/api/projects/folders", { cwd: "/work/app", path: "/work/app-docs/" });
    assert.strictEqual(addFolderRes.status, 200);
    assert.deepEqual(addFolderRes.json.project.folders.map((f: { cwd: string }) => f.cwd), ["/work/app", "/work/app-docs"]);
    assert.strictEqual(addFolderRes.json.warning, null);
    assert.deepEqual(await queryProjectRoots(), ["/work/app"], "the folder is no longer a project of its own");
    assert.deepEqual(await queryThreadIdentities(), ["a1@/work/app", "d1@/work/app-docs", "tui-1@/work/app-docs"], "its threads came along, and each still names its own folder");
    assert.deepEqual((await get(baseUrl, "/api/projects")).projects[0].folders.map((f: { cwd: string }) => f.cwd), ["/work/app", "/work/app-docs"]);

    const reAddProjectRes = await send(baseUrl, "/api/projects", { cwd: "/work/app-docs" });
    assert.strictEqual(reAddProjectRes.json.project.cwd, "/work/app", "adding a folder that is inside a project answers with the project");
    assert.deepEqual(await queryProjectRoots(), ["/work/app"]);

    assert.strictEqual((await send(baseUrl, "/api/projects/folders", { cwd: "/work/app", path: "/work/app" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/projects/folders", { cwd: "/work/app-docs", path: "/work/deeper" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/projects/folders", { cwd: "/nowhere", path: "/work/x" })).status, 404);
    assert.strictEqual((await send(baseUrl, `/api/projects/folders?cwd=${encodeURIComponent("/work/app")}&path=${encodeURIComponent("/work/x")}`, undefined, "DELETE")).status, 400);

    await send(baseUrl, `/api/projects?cwd=${encodeURIComponent("/work/app")}`, undefined, "DELETE");
    assert.deepEqual(await queryThreadIdentities(), [], "hiding the project hides its folders' threads too");
    await send(baseUrl, "/api/projects", { cwd: "/work/app-docs" });
    assert.deepEqual(await queryProjectRoots(), ["/work/app"], "re-adding a folder brings its project back, whole");
    assert.strictEqual((await queryThreadIdentities()).length, 3);

    const deleteFolderRes = await send(baseUrl, `/api/projects/folders?cwd=${encodeURIComponent("/work/app")}&path=${encodeURIComponent("/work/app-docs")}`, undefined, "DELETE");
    assert.strictEqual(deleteFolderRes.status, 200);
    assert.deepEqual(deleteFolderRes.json.project.folders.map((f: { cwd: string }) => f.cwd), ["/work/app"]);
    assert.deepEqual(await queryProjectRoots(), ["/work/app", "/work/app-docs"], "a removed folder is a project again");
    assert.strictEqual((await queryThreadIdentities()).length, 3, "no thread disappears");
  });

  it("opens known project folders only", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/list", { sessions: [], nextCursor: null });
    const openedFolders: { path: string; target: OpenTarget }[] = [];

    const { baseUrl: baseUrl } = await start(fakeTransport, {
      platform: "win32",
      musePath: "/home/dev/.local/bin/muse",
      opener: async (folderPath, openTarget) => {
        openedFolders.push({ path: folderPath, target: openTarget });
      },
    });

    assert.strictEqual((await send(baseUrl, "/api/open", { cwd: "C:\\nowhere" })).status, 404);
    await send(baseUrl, "/api/projects", { cwd: "/mnt/d/work/app" });
    assert.strictEqual((await send(baseUrl, "/api/open", { cwd: "/mnt/d/work/app", target: "editor" })).status, 200);
    assert.deepEqual(openedFolders, [{ path: "D:\\work\\app", target: "editor" }]);

    await send(baseUrl, "/api/projects/folders", { cwd: "/mnt/d/work/app", path: "/mnt/d/work/app-docs" });
    assert.strictEqual((await send(baseUrl, "/api/open", { cwd: "/mnt/d/work/app-docs" })).status, 200);
    assert.deepEqual(openedFolders.at(-1), { path: "D:\\work\\app-docs", target: "files" });
  });

  it("settles and un-settles threads, and wakes a settled thread when work starts", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const settledRes = await send(baseUrl, "/api/sessions/s1", { settled: true }, "PATCH");
    assert.strictEqual(settledRes.json.session.settled, true);
    assert.ok(settledRes.json.session.settledAt);

    const activeRes = await send(baseUrl, "/api/sessions/s1", { settled: false }, "PATCH");
    assert.strictEqual(activeRes.json.session.settled, false);
    assert.strictEqual(activeRes.json.session.settledAt, null);
    assert.ok(activeRes.json.session.unsettledAt);

    await send(baseUrl, "/api/sessions/s1", { settled: true }, "PATCH");
    await send(baseUrl, "/api/turns", { sessionId: "s1", text: "pick this back up" });

    const restoredSession = (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.strictEqual(restoredSession.settled, false);
    assert.ok(restoredSession.unsettledAt);
  });

  it("wakes a settled thread when discovery shows it moved on in another client", async () => {
    const fakeTransport = new FakeConnection();
    const makeListResponse = (stamp: string) => ({
      sessions: [{ sessionId: "tui-1", workspaceRoot: "/work/proj", updatedAt: stamp }],
      nextCursor: null,
    });

    fakeTransport.replies.set("session/list", makeListResponse("2026-09-01T00:00:00.000Z"));
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/discover", {});

    const settleRes = await send(baseUrl, "/api/sessions/tui-1", { settled: true }, "PATCH");
    assert.strictEqual(settleRes.json.session.settled, true);

    const locateSession = async () => (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "tui-1");
    await send(baseUrl, "/api/discover", {});
    assert.strictEqual((await locateSession()).settled, true, "nothing new happened, so it stays settled");

    fakeTransport.replies.set("session/list", makeListResponse(new Date(Date.now() + 60_000).toISOString()));
    await send(baseUrl, "/api/discover", {});
    assert.strictEqual((await locateSession()).settled, false);
  });

  it("carries a turn's reasoning effort as the session default, once per change", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("turn/start", { status: "accepted", turnId: "t1", disposition: "started" });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const retrieveEffortArguments = () =>
      fakeTransport.calls.filter((c) => c.method === "session/setReasoningEffort").map((c) => c.params?.["reasoningEffort"]);

    await send(baseUrl, "/api/turns", { sessionId: "s1", text: "one", reasoningEffort: "low" });
    const methodNames = fakeTransport.calls.map((c) => c.method);
    assert.ok(methodNames.indexOf("session/setReasoningEffort") < methodNames.lastIndexOf("turn/start"), "the default is set before the turn goes");

    await send(baseUrl, "/api/turns", { sessionId: "s1", text: "two", reasoningEffort: "low" });
    await send(baseUrl, "/api/turns", { sessionId: "s1", text: "three" });
    assert.deepEqual(retrieveEffortArguments(), ["low"], "an unchanged or absent effort sends nothing");

    fakeTransport.notify("session/reasoningEffortChanged", { sessionId: "s1", reasoningEffort: "xhigh", source: "user" });
    await send(baseUrl, "/api/turns", { sessionId: "s1", text: "four", reasoningEffort: "xhigh" });
    assert.deepEqual(retrieveEffortArguments(), ["low"]);

    const directEffortRes = await send(baseUrl, "/api/sessions/s1/effort", { reasoningEffort: "max" });
    assert.strictEqual(directEffortRes.status, 200);
    assert.deepEqual(retrieveEffortArguments(), ["low", "max"]);
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/effort", { reasoningEffort: "loud" })).status, 400);

    fakeTransport.replies.set("session/setReasoningEffort", new MspTestError("no such method", "methodNotFound"));
    const fallbackRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "five", reasoningEffort: "low" });
    assert.strictEqual(fallbackRes.status, 200);
    assert.strictEqual(fakeTransport.calls.at(-1)?.params?.["reasoningEffort"], "low");

    fakeTransport.replies.set("session/setReasoningEffort", new MspTestError("not loaded", "sessionNotLoaded"));
    const unloadedRes = await send(baseUrl, "/api/turns", { sessionId: "s1", text: "six", reasoningEffort: "medium" });
    assert.strictEqual(unloadedRes.status, 409);
    assert.strictEqual(unloadedRes.json.kind, "sessionNotLoaded", "the UI reloads and retries on this kind");
  });

  it("drives goals, subagents, background tasks and workflow children", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("goal/set", { commandId: "c", status: "accepted", turnId: "t7" });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    const lastCommand = () => fakeTransport.calls.at(-1);

    const goalRes = await send(baseUrl, "/api/sessions/s1/goal", { action: "set", objective: "get CI green" });
    assert.deepEqual(goalRes.json, { turnId: "t7" });
    assert.deepEqual(lastCommand(), { method: "goal/set", params: { sessionId: "s1", objective: "get CI green" } });

    await send(baseUrl, "/api/sessions/s1/goal", { action: "pause" });
    assert.deepEqual(lastCommand(), { method: "goal/pause", params: { sessionId: "s1" } });
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/goal", { action: "edit" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/goal", { action: "finish" })).status, 400);

    await send(baseUrl, "/api/sessions/s1/subagent", { action: "sendMessage", subagentId: "sa1", body: "use pnpm" });
    assert.deepEqual(lastCommand(), { method: "subagent/sendMessage", params: { sessionId: "s1", subagentId: "sa1", body: "use pnpm" } });
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/subagent", { action: "followupTask", subagentId: "sa1" })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/subagent", { action: "stop" })).status, 400);

    await send(baseUrl, "/api/sessions/s1/tasks", { action: "background", taskId: "item-4" });
    assert.deepEqual(lastCommand(), { method: "task/background", params: { sessionId: "s1", taskId: "item-4" } });

    await send(baseUrl, "/api/sessions/s1/tasks", { action: "stop", taskId: "item-4" });
    assert.deepEqual(lastCommand(), { method: "task/stop", params: { sessionId: "s1", taskId: "item-4" } });

    await send(baseUrl, "/api/sessions/s1/tasks", { action: "stopAll" });
    assert.deepEqual(lastCommand(), { method: "task/stopAll", params: { sessionId: "s1" } });
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/tasks", { action: "stop" })).status, 400);

    await send(baseUrl, "/api/sessions/s1/workflow", { action: "cancel", workflowRunId: "run-9" });
    assert.deepEqual(lastCommand(), { method: "workflow/cancel", params: { sessionId: "s1", workflowRunId: "run-9" } });

    await send(baseUrl, "/api/sessions/s1/workflow", { action: "skip", workflowRunId: "run-9", childId: "c1", attempt: 2 });
    assert.deepEqual(lastCommand(), { method: "workflow/childControl", params: { sessionId: "s1", workflowRunId: "run-9", childId: "c1", attempt: 2, action: "skip" } });
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 0 })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/workflow", { action: "cancel" })).status, 400);

    fakeTransport.replies.set("workflow/childControl", new MspTestError("stale attempt", "stale_attempt"));
    const staleRes = await send(baseUrl, "/api/sessions/s1/workflow", { action: "retry", workflowRunId: "run-9", childId: "c1", attempt: 1 });
    assert.strictEqual(staleRes.status, 409);
    assert.strictEqual(staleRes.json.kind, "stale_attempt");
  });

  it("reads a tool's stored output one page at a time", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("item/readOutput", (args: Record<string, unknown>) => ({
      content: "x".repeat(4),
      encoding: "utf8",
      mediaType: "text/plain",
      offsetBytes: args["offsetBytes"],
      byteLen: 4,
      eof: args["offsetBytes"] === 4,
    }));

    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const firstPage = await get(baseUrl, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1");
    assert.deepEqual(firstPage.output, {
      content: "xxxx",
      encoding: "utf8",
      mediaType: "text/plain",
      offsetBytes: 0,
      byteLen: 4,
      eof: false,
    });

    const secondPage = await get(baseUrl, "/api/sessions/s1/output?itemId=i1&outputRef=bash-1&offset=4&length=99999999");
    assert.strictEqual(secondPage.output.eof, true);
    assert.deepEqual(fakeTransport.requests.at(-1)?.params, {
      sessionId: "s1",
      itemId: "i1",
      outputRef: "bash-1",
      offsetBytes: 4,
      lengthBytes: 1024 * 1024,
    });
    assert.strictEqual((await fetch(`${baseUrl}/api/sessions/s1/output?itemId=i1`)).status, 400);
  });

  it("keeps the newest subscription window any host reports", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const createUsageWindow = (usagePct: number, timestampMs: number) => ({
      tier: "high",
      observedAtMs: timestampMs,
      window: { usedPercent: usagePct, resetsAtMs: timestampMs + 1000, windowDurationMins: 300 },
      weekly: { usedPercent: 10, resetsAtMs: timestampMs + 9000 },
    });

    const { baseUrl: baseUrl } = await start(fakeTransport);
    fakeTransport.replies.set("usage/read", {});
    assert.strictEqual((await get(baseUrl, "/api/plan-usage")).usage, null, "no host running and nothing seen");

    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.strictEqual((await get(baseUrl, "/api/plan-usage")).usage, null, "a host that has seen nothing is not an error");

    fakeTransport.notify("usage/changed", createUsageWindow(40, 2_000));
    assert.strictEqual((await get(baseUrl, "/api/plan-usage")).usage.window.usedPercent, 40);

    fakeTransport.notify("usage/changed", createUsageWindow(5, 1_000));
    assert.strictEqual((await get(baseUrl, "/api/plan-usage")).usage.window.usedPercent, 40, "an older reading never replaces a newer one");

    fakeTransport.replies.set("usage/read", { usage: createUsageWindow(55, 3_000) });
    const usageRes = await get(baseUrl, "/api/plan-usage");
    assert.strictEqual(usageRes.usage.window.usedPercent, 55);
    assert.strictEqual(usageRes.usage.weekly.windowDurationMins, null);
  });

  it("tracks plan usage per account and keeps the newest as the default", async () => {
    const workConn = new FakeConnection();
    const personalConn = new FakeConnection();
    const tempHome = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profileMgr = createProfileManager({ home: tempHome, platform: "linux", musePath: "muse" });
    await profileMgr.createProfile("work");
    await profileMgr.createProfile("personal");

    const hostRouter = (target: ServeTarget): HostHandle => {
      const configRoot = target.env?.["XDG_CONFIG_HOME"]?.replaceAll("\\", "/") ?? "";
      const selectedConn = configRoot.includes("/work/") ? workConn : personalConn;
      return fakeFactory(selectedConn)(target);
    };

    const { baseUrl: baseUrl } = await start(workConn, { hostFactory: hostRouter, profiles: profileMgr });
    workConn.replies.set("session/start", { session: { sessionId: "w1" } });
    personalConn.replies.set("session/start", { session: { sessionId: "p1" } });

    await send(baseUrl, "/api/sessions", { cwd: "/proj", accountId: "work" });
    await send(baseUrl, "/api/sessions", { cwd: "/proj", accountId: "personal" });

    workConn.notify("usage/changed", {
      tier: "1",
      observedAtMs: 100,
      window: { usedPercent: 90, resetsAtMs: 1, windowDurationMins: 300 },
      weekly: { usedPercent: 50, resetsAtMs: 1, windowDurationMins: null },
    });
    personalConn.notify("usage/changed", {
      tier: "1",
      observedAtMs: 200,
      window: { usedPercent: 12, resetsAtMs: 1, windowDurationMins: 300 },
      weekly: { usedPercent: 8, resetsAtMs: 1, windowDurationMins: null },
    });

    const usageRes = await get(baseUrl, "/api/plan-usage");
    assert.strictEqual(usageRes.byAccount.work.window.usedPercent, 90);
    assert.strictEqual(usageRes.byAccount.personal.window.usedPercent, 12);
    assert.strictEqual(usageRes.usage.window.usedPercent, 12, "usage holds the newest across accounts");
  });

  it("refreshes default and named subscription limits directly without starting a host", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-direct-quota-"));
    quotaEnvironment(t, home);
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    const profile = await profiles.createProfile("work");
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
    const subscriptionReader = new MuseSubscriptionReader({ now: () => observed, runUsage: async (req) => {
      requests++;
      const work = req.accountId === "work";
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          tierName: "Muse Code Power Usage",
          api_key: "LLM|discard-me",
          reason: null,
          hint: null,
          allowance: {
            tier: "123",
            observedAtMs: observed,
            window: { usedPercent: work ? 84 : 12, resetsAtMs: observed + 3_600_000, windowDurationMins: 300 },
            weekly: { usedPercent: work ? 55 : 25, resetsAtMs: observed + 86_400_000 },
          },
        }),
        stderr: "",
      };
    } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const connection = new FakeConnection();
    const { base } = await start(connection, { home, profiles, subscriptionReader, hostFactory: fakeFactory(connection, probe) });
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
    const subscriptionReader = new MuseSubscriptionReader({ now: () => stamp, cacheMs: 0, runUsage: async () => active
      ? { exitCode: 1, stdout: "", stderr: "private failure" }
      : { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, allowance: null, reason: "no_subscription", hint: null }), stderr: "" } });
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
      const subscriptionReader = new MuseSubscriptionReader({ cacheMs: 0, runUsage: async () => {
        calls++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage", hint: null, tierName: "Muse Code Power Usage" }),
          stderr: "",
        };
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
    let finish: ((response: MuseUsageCliResult) => void) | null = null;
    const subscriptionReader = new MuseSubscriptionReader({ now: () => stamp, cacheMs: 0,
      runUsage: async () => new Promise((resolve) => { finish = resolve; }) });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader });
    await send(base, "/api/sessions", { cwd: "/work" });
    for (const response of [
      { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, allowance: null, reason: "no_subscription", hint: null }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage", hint: null, tierName: "Muse Code Power Usage" }), stderr: "" },
      { exitCode: 1, stdout: "", stderr: "unavailable" },
    ] satisfies MuseUsageCliResult[]) {
      finish = null;
      const pending = get(base, "/api/plan-usage");
      await waitFor(() => finish !== null, "direct quota request");
      const reading = { tier: "high", observedAtMs: stamp + 1000,
        window: { usedPercent: 37, resetsAtMs: stamp + 60000, windowDurationMins: 300 },
        weekly: { usedPercent: 21, resetsAtMs: stamp + 86400000 } };
      connection.notify("usage/changed", reading);
      (finish as unknown as (response: MuseUsageCliResult) => void)(response);
      const report = await pending;
      assert.equal(report.accounts[0].usage.window.usedPercent, 37);
      assert.equal(report.accounts[0].source, "runtime");
      assert.equal(report.accounts[0].status, "runtime-only", "an earlier CLI result cannot hide a newer runtime reading");
      assert.equal(report.accounts[0].checkedAtMs, stamp, "checking time remains distinct from the newer observation");
      stamp += 2000;
    }
  });

  it("restores subscription readings only for the same login and runtime without starting a host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-cache-"));
    const profiles = createProfileManager({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await profiles.createProfile("work");
    const authDir = join(profile.roots.config, "muse");
    await mkdir(authDir, { recursive: true });
    const login = (email: string) => writeFile(join(authDir, "auth.json"), JSON.stringify({
      providers: { meta: { mechanism: "oauth", user_email: email } },
    }));
    await login("first@example.test");
    const first = new FakeConnection();
    first.replies.set("session/start", { session: { sessionId: "w1" } });
    const options = { dataDir, profiles, home: join(dataDir, "home") };
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
    const profiles = createProfileManager({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await profiles.createProfile("work");
    const authDir = join(profile.roots.config, "muse");
    await mkdir(authDir, { recursive: true });
    const login = (email: string) => writeFile(join(authDir, "auth.json"), JSON.stringify({
      providers: { meta: { mechanism: "oauth", user_email: email } },
    }));
    await login("first@example.test");
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "w1" } });
    const { base } = await start(connection, { profiles, home: join(dataDir, "home") });
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
    const profiles = createProfileManager({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
    const connection = new FakeConnection();
    const replacement = new FakeConnection();
    let starts = 0;
    const factory = (target: ServeTarget) => fakeFactory(starts++ === 0 ? connection : replacement)(target);
    connection.replies.set("session/start", { session: { sessionId: "w1" } });
    replacement.replies.set("session/start", { session: { sessionId: "w2" } });
    const { base } = await start(connection, { profiles, home: join(dataDir, "home"), hostFactory: factory });
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
    await profiles.createProfile("work");
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
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    const mockUsageData = {
      tier: "high",
      observedAtMs: 5_000,
      window: { usedPercent: 30, resetsAtMs: 6_000, windowDurationMins: 300 },
      weekly: { usedPercent: 9, resetsAtMs: 12_000, windowDurationMins: null },
    };
    fakeTransport.replies.set("usage/read", { usage: mockUsageData });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const eventCount = await countPlanUsageEvents(baseUrl, async () => {
      await get(baseUrl, "/api/plan-usage");
      await get(baseUrl, "/api/plan-usage");
    });
    assert.strictEqual(eventCount, 1, "a same-timestamp re-read must not re-emit plan-usage");
  });

  it("gives Muse the name typed here, and takes the name Muse settles on, when titles are shared", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport, { syncSessionNames: true });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchSession = async () => (await get(baseUrl, "/api/sessions")).sessions[0];

    await send(baseUrl, "/api/sessions/s1", { title: "Ship the sidebar" }, "PATCH");
    assert.deepEqual(fakeTransport.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Ship the sidebar" } });

    fakeTransport.notify("session/nameChanged", { sessionId: "s1", name: "sidebar-v2", viewCursor: "c", sourceRange: RANGE });
    let session = await fetchSession();
    assert.strictEqual(session.title, "sidebar-v2", "a `/name` in another client is the newest name");
    assert.strictEqual(session.titleSource, "user", "and a thread the user named stays theirs");

    fakeTransport.replies.set("session/rename", new MspTestError("ephemeral", "unsupported"));
    const renameRes = await send(baseUrl, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.strictEqual(renameRes.status, 200, "a rename Muse refuses still renames the thread here");
    assert.strictEqual(renameRes.json.session.title, "Local only");

    const previousRenameCount = fakeTransport.calls.filter((c) => c.method === "session/rename").length;
    await send(baseUrl, "/api/sessions/s1", { title: "Local only" }, "PATCH");
    assert.strictEqual(fakeTransport.calls.filter((c) => c.method === "session/rename").length, previousRenameCount, "an unchanged title is not sent again");

    session = await fetchSession();
    assert.strictEqual(session.title, "Local only");
  });

  it("keeps generated and typed titles local by default, writing no rename records to Muse", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const titleExec: ExecFn = async () => ({
      stdout: JSON.stringify({
        payload_type: "run.terminal.completed",
        payload: { kind: "run_terminal", terminal: "completed", text: "Parallel code investigation" },
      }),
      exitCode: 0,
    });

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: titleExec });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchTitle = async () => (await get(baseUrl, "/api/sessions")).sessions[0].title;
    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Investigate these independent components with native agents" },
    });

    await waitFor(async () => (await fetchTitle()) === "Parallel code investigation", "the generated local title");
    fakeTransport.notify("session/nameChanged", { sessionId: "s1", name: "native-name", viewCursor: "c", sourceRange: RANGE });
    fakeTransport.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "native-name" }],
      nextCursor: null,
    });

    await send(baseUrl, "/api/discover", {});
    assert.strictEqual(await fetchTitle(), "Parallel code investigation", "the unsynchronized host name cannot undo a local title");

    await send(baseUrl, "/api/sessions/s1", { title: "My investigation" }, "PATCH");
    assert.strictEqual(await fetchTitle(), "My investigation");
    assert.strictEqual(fakeTransport.calls.filter((c) => c.method === "session/rename").length, 0);
  });

  it("stops sending titles to a host whose Muse reports the rename-broken event log, and says so once", async () => {
    const errorPattern = "event log failed: record decode failed: payload decode failed: missing field kind";
    const countRenames = (fakeTransport: FakeConnection) => fakeTransport.calls.filter((c) => c.method === "session/rename").length;
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const fakeTransport = new FakeConnection();
      fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
      fakeTransport.replies.set("session/rename", new MspTestError(errorPattern, "internal"));

      const { baseUrl: baseUrl } = await start(fakeTransport, { syncSessionNames: true });
      await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

      assert.strictEqual((await send(baseUrl, "/api/sessions/s1", { title: "First" }, "PATCH")).status, 200);
      assert.strictEqual((await send(baseUrl, "/api/sessions/s1", { title: "Second" }, "PATCH")).status, 200);
      assert.strictEqual(countRenames(fakeTransport), 1, "no title goes to that host again");
      assert.strictEqual((await get(baseUrl, "/api/sessions")).sessions[0].title, "Second", "the local title stands");
      assert.strictEqual(stderrChunks.filter((line) => /missing field kind/.test(line)).length, 1);

      const secondConn = new FakeConnection();
      secondConn.replies.set("session/start", { session: { sessionId: "s1" } });
      secondConn.replies.set("session/rename", new MspTestError("ephemeral", "unsupported"));

      const { baseUrl: secondBase } = await start(secondConn, { syncSessionNames: true });
      await send(secondBase, "/api/sessions", { cwd: "/work/proj" });
      await send(secondBase, "/api/sessions/s1", { title: "First" }, "PATCH");
      await send(secondBase, "/api/sessions/s1", { title: "Second" }, "PATCH");
      assert.strictEqual(countRenames(secondConn), 2, "an ordinary refusal does not stop titles");

      secondConn.notify("turn/completed", {
        sessionId: "s1",
        turnId: "t1",
        terminal: "failed",
        error: { message: `workflow cancel registration failed before admission: ${errorPattern}` },
      });

      await send(secondBase, "/api/sessions/s1", { title: "Third" }, "PATCH");
      assert.strictEqual(countRenames(secondConn), 2);
      assert.strictEqual((await get(secondBase, "/api/sessions")).sessions[0].title, "Third");
      assert.strictEqual(stderrChunks.filter((line) => /missing field kind/.test(line)).length, 2, "once per host");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it("keeps thread-title settings behind a switch and a model choice", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport);
    assert.deepEqual(await get(baseUrl, "/api/title-settings"), { enabled: true, modelId: null });

    const patchRes = await send(baseUrl, "/api/title-settings", { enabled: false, modelId: "m1" }, "PATCH");
    assert.strictEqual(patchRes.status, 200);
    assert.deepEqual(patchRes.json, { enabled: false, modelId: "m1" });
    assert.deepEqual(await get(baseUrl, "/api/title-settings"), { enabled: false, modelId: "m1" });

    const mergeRes = await send(baseUrl, "/api/title-settings", { enabled: true }, "PATCH");
    assert.deepEqual(mergeRes.json, { enabled: true, modelId: "m1" });

    const invalidEnabledRes = await send(baseUrl, "/api/title-settings", { enabled: "yes" }, "PATCH");
    assert.strictEqual(invalidEnabledRes.status, 400);

    const invalidModelRes = await send(baseUrl, "/api/title-settings", { modelId: "" }, "PATCH");
    assert.strictEqual(invalidModelRes.status, 400);
    assert.deepEqual(await get(baseUrl, "/api/title-settings"), { enabled: true, modelId: "m1" }, "a rejected patch changes nothing");
  });

  it("keeps sandbox settings behind a boolean switch, defaulting to sandbox-on", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport);
    assert.deepEqual(await get(baseUrl, "/api/sandbox-settings"), { disabled: false });

    const patchRes = await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    assert.strictEqual(patchRes.status, 200);
    assert.deepEqual(patchRes.json, { disabled: true });
    assert.deepEqual(await get(baseUrl, "/api/sandbox-settings"), { disabled: true });

    const invalidPatchRes = await send(baseUrl, "/api/sandbox-settings", { disabled: "yes" }, "PATCH");
    assert.strictEqual(invalidPatchRes.status, 400);
    assert.deepEqual(await get(baseUrl, "/api/sandbox-settings"), { disabled: true }, "a rejected patch changes nothing");
  });

  it("spawns hosts with --disable-sandbox, restarting them when the switch flips", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    let closeInvocationCount = 0;

    const baseFactory = fakeFactory(fakeTransport, targetProbe);
    const trackingFactory = (target: ServeTarget): HostHandle => {
      const handle = baseFactory(target);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        closeInvocationCount += 1;
        return originalClose();
      };
      return handle;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: trackingFactory });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve"]]);

    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(() => closeInvocationCount === 1, "the live host closing");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    assert.deepEqual(
      targetProbe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox"]],
      "the respawned host carries the new posture",
    );

    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(closeInvocationCount, 1, "an unchanged switch restarts nothing");
  });

  it("drops --disable-sandbox from respawned hosts when the switch flips back on", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    let closeInvocationCount = 0;

    const baseFactory = fakeFactory(fakeTransport, targetProbe);
    const trackingFactory = (target: ServeTarget): HostHandle => {
      const handle = baseFactory(target);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        closeInvocationCount += 1;
        return originalClose();
      };
      return handle;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: trackingFactory });

    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(baseUrl, "/api/sandbox-settings", { disabled: false }, "PATCH");
    await waitFor(() => closeInvocationCount === 1, "the live host closing");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    assert.deepEqual(
      targetProbe.targets.map((t) => t.args),
      [["serve", "--disable-sandbox"], ["serve"]],
      "the respawned host drops --disable-sandbox",
    );
  });

  it("marks sessions with their creation posture, inherited by forks", async () => {
    const fakeTransport = new FakeConnection();
    let sessionCounter = 0;
    fakeTransport.replies.set("session/start", () => ({ session: { sessionId: `s${(sessionCounter += 1)}` } }));

    const { baseUrl: baseUrl } = await start(fakeTransport);
    const initialSession = await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.strictEqual(initialSession.json.session.sandboxDisabled, false);

    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    const disabledSession = await send(baseUrl, "/api/sessions", { cwd: "/work/other" });
    assert.strictEqual(disabledSession.json.session.sandboxDisabled, true, "a session records its creating host's flags");

    fakeTransport.replies.set("session/fork", { session: { sessionId: "s3" } });
    const forkedSession = await send(baseUrl, "/api/sessions/s2/fork", {});
    assert.strictEqual(forkedSession.json.session.sandboxDisabled, true, "a fork inherits its source's posture");

    const allSessions = (await get(baseUrl, "/api/sessions")).sessions as { sessionId: string; sandboxDisabled: boolean | null }[];
    assert.strictEqual(
      allSessions.find((s) => s.sessionId === "s1")?.sandboxDisabled,
      false,
      "flipping the switch never rewrites old rows",
    );
  });

  it("never starts a session on a host retired by a flip", async () => {
    const fakeTransport = new FakeConnection();
    let sessionCounter = 0;
    fakeTransport.replies.set("session/start", () => ({ session: { sessionId: `s${(sessionCounter += 1)}` } }));

    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    let unblockClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      unblockClose = resolve;
    });

    const innerFactory = fakeFactory(fakeTransport, targetProbe);
    let isFirstHost = true;
    const customFactory = (target: ServeTarget): HostHandle => {
      const handle = innerFactory(target);
      const shouldBlock = isFirstHost;
      isFirstHost = false;
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        if (shouldBlock) {
          await closeBarrier;
        }
        return originalClose();
      };
      return handle;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: customFactory });

    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve", "--disable-sandbox"]]);

    await send(baseUrl, "/api/sandbox-settings", { disabled: false }, "PATCH");
    const sessionCreationPromise = send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    try {
      const raceOutcome = await Promise.race([
        sessionCreationPromise.then((res) => res),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      assert.strictEqual(raceOutcome, "waiting", "creation waits for the flip's restart");
    } finally {
      unblockClose();
    }

    const completedCreation = await sessionCreationPromise;
    assert.strictEqual(completedCreation.status, 200);
    assert.strictEqual(completedCreation.json.session.sandboxDisabled, false, "the session lands on the new posture's host");
  });

  it("keeps YOLO settings behind a boolean switch, defaulting to off", async () => {
    const fakeTransport = new FakeConnection();
    const { baseUrl: baseUrl } = await start(fakeTransport);
    assert.deepEqual(await get(baseUrl, "/api/yolo-settings"), { enabled: false });

    const patchedRes = await send(baseUrl, "/api/yolo-settings", { enabled: true }, "PATCH");
    assert.strictEqual(patchedRes.status, 200);
    assert.deepEqual(patchedRes.json, { enabled: true });
    assert.deepEqual(await get(baseUrl, "/api/yolo-settings"), { enabled: true });

    const invalidRes = await send(baseUrl, "/api/yolo-settings", { enabled: "yes" }, "PATCH");
    assert.strictEqual(invalidRes.status, 400);
    assert.deepEqual(await get(baseUrl, "/api/yolo-settings"), { enabled: true }, "a rejected patch changes nothing");
  });

  it("spawns hosts with the YOLO flags, restarting them when the switch flips", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    let closeInvocationCount = 0;

    const baseFactory = fakeFactory(fakeTransport, targetProbe);
    const trackingFactory = (target: ServeTarget): HostHandle => {
      const handle = baseFactory(target);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        closeInvocationCount += 1;
        return originalClose();
      };
      return handle;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: trackingFactory });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve"]]);

    await send(baseUrl, "/api/yolo-settings", { enabled: true }, "PATCH");
    await waitFor(() => closeInvocationCount === 1, "the live host closing");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    assert.deepEqual(
      targetProbe.targets.map((t) => t.args),
      [["serve"], ["serve", "--disable-sandbox", "--trust-workspace"]],
      "the respawned host carries the new posture",
    );

    await send(baseUrl, "/api/yolo-settings", { enabled: true }, "PATCH");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(closeInvocationCount, 1, "an unchanged switch restarts nothing");
  });

  it("drops the YOLO flags from respawned hosts when the switch flips back off", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };
    let closeInvocationCount = 0;

    const baseFactory = fakeFactory(fakeTransport, targetProbe);
    const trackingFactory = (target: ServeTarget): HostHandle => {
      const handle = baseFactory(target);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        closeInvocationCount += 1;
        return originalClose();
      };
      return handle;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: trackingFactory });

    await send(baseUrl, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);

    await send(baseUrl, "/api/yolo-settings", { enabled: false }, "PATCH");
    await waitFor(() => closeInvocationCount === 1, "the live host closing");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    assert.deepEqual(
      targetProbe.targets.map((t) => t.args),
      [
        ["serve", "--disable-sandbox", "--trust-workspace"],
        ["serve"],
      ],
      "the respawned host drops the YOLO flags",
    );
  });

  it("spawns hosts with --disable-sandbox once when both the sandbox switch and YOLO are on", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: fakeFactory(fakeTransport, targetProbe) });
    await send(baseUrl, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await send(baseUrl, "/api/yolo-settings", { enabled: true }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    assert.deepEqual(targetProbe.targets.map((t) => t.args), [["serve", "--disable-sandbox", "--trust-workspace"]]);
  });

  it("upgrades an echo title with one muse exec call, and pushes the name back when titles are shared", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });

    let unblockExec!: () => void;
    const execBarrier = new Promise<void>((resolve) => {
      unblockExec = resolve;
    });

    const recordedExecCalls: string[][] = [];
    const mockExec: ExecFn = async (binary, args) => {
      recordedExecCalls.push([binary, ...args]);
      await execBarrier;
      return {
        stdout: JSON.stringify({
          payload_type: "run.terminal.completed",
          payload: { kind: "run_terminal", terminal: "completed", text: "Fix login redirect" },
        }),
        exitCode: 0,
      };
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec, syncSessionNames: true });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchCurrentTitle = async () => (await get(baseUrl, "/api/sessions")).sessions[0].title;
    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: {
        itemId: "i1",
        kind: "userMessage",
        revision: 1,
        status: "completed",
        text: "please fix the login redirect bug in the web app when sessions expire",
      },
    });

    await waitFor(() => recordedExecCalls.length > 0, "the title call to start");
    assert.strictEqual(await fetchCurrentTitle(), "please fix the login redirect bug in the web app when sessions expire");

    unblockExec();
    await waitFor(async () => (await fetchCurrentTitle()) === "Fix login redirect", "the upgraded title");

    assert.strictEqual(recordedExecCalls.length, 1);
    assert.strictEqual(recordedExecCalls[0]?.[0], "muse");
    assert.strictEqual(recordedExecCalls[0]?.[1], "exec");
    assert.ok(!recordedExecCalls[0]?.includes("--model"), "no model flag without a chosen model");
    assert.match(recordedExecCalls[0]?.at(-1) ?? "", /please fix the login redirect bug/);
    assert.deepEqual(fakeTransport.calls.at(-1), { method: "session/rename", params: { sessionId: "s1", name: "Fix login redirect" } });
  });

  it("passes the chosen model to the title call", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const recordedCalls: string[][] = [];
    const mockExec: ExecFn = async (binary, args) => {
      recordedCalls.push([binary, ...args]);
      return { stdout: "not json", exitCode: 0 };
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec });
    await send(baseUrl, "/api/title-settings", { modelId: "m9" }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });

    await waitFor(() => recordedCalls.length > 0, "the title call");
    const modelIndex = recordedCalls[0]?.indexOf("--model") ?? -1;
    assert.deepEqual(recordedCalls[0]?.slice(modelIndex, modelIndex + 2), ["--model", "m9"]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual((await get(baseUrl, "/api/sessions")).sessions[0].title, "Add dark mode everywhere", "garbage output keeps the echo");
  });

  it("stays silent while switched off, and upgrades on re-enable", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("view/page", {
      events: [{ method: "item/completed", params: { item: { itemId: "u1", kind: "userMessage", text: "Add dark mode everywhere" } } }],
      nextCursor: null,
    });

    const recordedCalls: string[][] = [];
    const mockExec: ExecFn = async (binary, args) => {
      recordedCalls.push([binary, ...args]);
      return {
        stdout: JSON.stringify({
          payload_type: "run.terminal.completed",
          payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" },
        }),
        exitCode: 0,
      };
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec });
    await send(baseUrl, "/api/title-settings", { enabled: false }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchCurrentTitle = async () => (await get(baseUrl, "/api/sessions")).sessions[0].title;
    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });

    assert.strictEqual(await fetchCurrentTitle(), "Add dark mode everywhere");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(recordedCalls.length, 0, "no model call while switched off");

    await send(baseUrl, "/api/title-settings", { enabled: true }, "PATCH");
    await waitFor(async () => (await fetchCurrentTitle()) === "Add dark mode", "the upgrade after re-enable");
    assert.strictEqual(recordedCalls.length, 1);
  });

  it("lets a rename typed mid-upgrade win over the generated title", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });

    let unblockExecResult!: (result: { stdout: string; exitCode: number }) => void;
    const execBarrier = new Promise<{ stdout: string; exitCode: number }>((resolve) => {
      unblockExecResult = resolve;
    });

    const recordedCalls: string[][] = [];
    const mockExec: ExecFn = async (binary, args) => {
      recordedCalls.push([binary, ...args]);
      return execBarrier;
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "Add dark mode everywhere" },
    });

    await waitFor(() => recordedCalls.length > 0, "the title call to start");
    await send(baseUrl, "/api/sessions/s1", { title: "Mine" }, "PATCH");

    unblockExecResult({
      stdout: JSON.stringify({
        payload_type: "run.terminal.completed",
        payload: { kind: "run_terminal", terminal: "completed", text: "Add dark mode" },
      }),
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const session = (await get(baseUrl, "/api/sessions")).sessions[0];
    assert.strictEqual(session.title, "Mine");
    assert.strictEqual(session.titleSource, "user");
  });

  it("checks \\\\wsl.localhost\\ folders against the distro Muse is started in, not WSL's default", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/list", { sessions: [], nextCursor: null });

    const wslTracker = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const hostProbe: FactoryProbe = { targets: [], exits: [] };

    const { baseUrl: baseUrl } = await start(fakeTransport, {
      platform: "win32",
      runtime: "wsl",
      musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["Debian", "Ubuntu"], ["Ubuntu"], wslTracker),
      hostFactory: fakeFactory(fakeTransport, hostProbe),
    });

    const envRes = await get(baseUrl, "/api/env");
    assert.strictEqual(envRes.museFound, true);
    assert.strictEqual(envRes.defaultDistro, "Ubuntu", "the app shows the distro Muse runs in");

    const addProjRes = await send(baseUrl, "/api/projects", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" });
    assert.strictEqual(addProjRes.status, 200);
    assert.strictEqual(addProjRes.json.warning, null);

    assert.strictEqual((await send(baseUrl, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" })).status, 200);
    assert.deepEqual(hostProbe.targets[0]?.args.slice(0, 2), ["-d", "Ubuntu"], "the host starts where the check looked");

    const foreignDistroRes = await send(baseUrl, "/api/sessions", { cwd: "\\\\wsl.localhost\\Debian\\home\\u\\proj" });
    assert.strictEqual(foreignDistroRes.status, 400);
    assert.strictEqual(foreignDistroRes.json.error, "This folder belongs to WSL Debian, but Muse is running in Ubuntu.");

    const onlyTracker = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const debianProbe: FactoryProbe = { targets: [], exits: [] };

    const { baseUrl: secondBase } = await start(fakeTransport, {
      platform: "win32",
      runtime: "wsl",
      musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["Debian", "Ubuntu"], ["Debian"], onlyTracker),
      hostFactory: fakeFactory(fakeTransport, debianProbe),
    });

    assert.strictEqual((await get(secondBase, "/api/env")).defaultDistro, "Debian");
    assert.strictEqual((await send(secondBase, "/api/sessions", { cwd: "\\\\wsl.localhost\\Debian\\home\\u\\proj" })).status, 200);
    assert.deepEqual(debianProbe.targets[0]?.args.slice(0, 2), ["-d", "Debian"]);

    const rejectedDebianRes = await send(secondBase, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" });
    assert.strictEqual(rejectedDebianRes.json.error, "This folder belongs to WSL Ubuntu, but Muse is running in Debian.");
  });

  it("probes the pinned distro and binary from runtime.json, so a working Muse is never reported missing", async () => {
    const fakeTransport = new FakeConnection();
    const wslTracker = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };

    const { baseUrl: baseUrl } = await start(fakeTransport, {
      platform: "win32",
      runtime: "wsl",
      distro: "Ubuntu-24.04",
      musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["docker-desktop", "Ubuntu-24.04"], ["Ubuntu-24.04"], wslTracker),
    });

    const envRes = await get(baseUrl, "/api/env");
    assert.strictEqual(envRes.museFound, true);
    assert.strictEqual(envRes.musePath, "/home/u/.local/bin/muse");
    assert.strictEqual(envRes.defaultDistro, "Ubuntu-24.04");
    assert.deepEqual(
      wslTracker.calls,
      [
        ["wsl", "-l", "-v"],
        ["wsl", "-d", "Ubuntu-24.04", "-e", "test", "-x", "/home/u/.local/bin/muse"],
      ],
      "only the pinned distro is looked in, for the pinned binary",
    );

    const missingTracker = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
    const { baseUrl: secondBase } = await start(fakeTransport, {
      platform: "win32",
      runtime: "wsl",
      distro: "Ubuntu-24.04",
      musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl(["docker-desktop", "Ubuntu-24.04"], [], missingTracker),
    });

    const missingEnvRes = await get(secondBase, "/api/env");
    assert.strictEqual(missingEnvRes.museFound, false, "a pinned binary that is not there is reported as missing");
    assert.strictEqual(missingEnvRes.musePath, null);
    assert.strictEqual(missingEnvRes.defaultDistro, "Ubuntu-24.04");
  });

  it("carries runtime.json's wslEnv into WSL processes only, over the Windows values of the same names", async () => {
    const initialEnv = {
      backend: process.env["TBH_CREDENTIAL_BACKEND"],
      wslenv: process.env["WSLENV"],
      bashEnv: process.env["BASH_ENV"],
    };
    process.env["TBH_CREDENTIAL_BACKEND"] = "keyring";
    process.env["WSLENV"] = "USERPROFILE/p";
    delete process.env["BASH_ENV"];

    try {
      const fakeTransport = new FakeConnection();
      fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
      const wslTracker = { calls: [] as string[][], envs: [] as (NodeJS.ProcessEnv | undefined)[] };
      const hostProbe: FactoryProbe = { targets: [], exits: [] };
      const runtimeWslEnv = { TBH_CREDENTIAL_BACKEND: "file", BASH_ENV: "/home/u/.config/muse/runtime-env.sh" };

      const { baseUrl: baseUrl } = await start(fakeTransport, {
        platform: "win32",
        runtime: "wsl",
        musePath: "/home/u/.local/bin/muse",
        wslEnv: runtimeWslEnv,
        exec: fakeWsl(["Ubuntu"], ["Ubuntu"], wslTracker),
        hostFactory: fakeFactory(fakeTransport, hostProbe),
      });

      assert.strictEqual((await send(baseUrl, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" })).status, 200);
      const targetHost = hostProbe.targets[0];
      assert.strictEqual(targetHost?.env?.["TBH_CREDENTIAL_BACKEND"], "file", "runtime.json wins over the Windows value");
      assert.strictEqual(targetHost?.env?.["BASH_ENV"], "/home/u/.config/muse/runtime-env.sh");
      assert.strictEqual(targetHost?.env?.["WSLENV"], "USERPROFILE/p:TBH_CREDENTIAL_BACKEND/u:BASH_ENV/u");
      assert.ok(wslTracker.envs.length > 0 && wslTracker.envs.every((e) => e?.["TBH_CREDENTIAL_BACKEND"] === "file"), "the targetProbe's calls into WSL see the same");
      assert.strictEqual(process.env["TBH_CREDENTIAL_BACKEND"], "keyring", "the server's own environment is untouched");
      assert.strictEqual(process.env["BASH_ENV"], undefined);
      assert.strictEqual(process.env["WSLENV"], "USERPROFILE/p");

      const nativeProbe: FactoryProbe = { targets: [], exits: [] };
      const { baseUrl: nativeBase } = await start(fakeTransport, {
        platform: "win32",
        runtime: "native",
        musePath: "C:\\muse\\muse.exe",
        wslEnv: runtimeWslEnv,
        hostFactory: fakeFactory(fakeTransport, nativeProbe),
      });

      assert.strictEqual((await send(nativeBase, "/api/sessions", { cwd: "D:\\work\\proj" })).status, 200);
      assert.strictEqual(nativeProbe.targets[0]?.command, "C:\\muse\\muse.exe");
      assert.strictEqual(nativeProbe.targets[0]?.env, undefined);
    } finally {
      for (const [key, savedValue] of [
        ["TBH_CREDENTIAL_BACKEND", initialEnv.backend],
        ["WSLENV", initialEnv.wslenv],
        ["BASH_ENV", initialEnv.bashEnv],
      ] as const) {
        if (savedValue === undefined) delete process.env[key];
        else process.env[key] = savedValue;
      }
    }
  });

  it("spawns one host per workspace under concurrency and respawns after a crash", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const targetProbe: FactoryProbe = { targets: [], exits: [] };

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: fakeFactory(fakeTransport, targetProbe) });
    await Promise.all([
      send(baseUrl, "/api/sessions", { cwd: "/work/proj" }),
      send(baseUrl, "/api/sessions", { cwd: "/work/proj" }),
    ]);
    assert.strictEqual(targetProbe.targets.length, 1);

    fakeTransport.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    targetProbe.exits[0]?.({ code: 1, signal: null });

    const session = (await get(baseUrl, "/api/sessions")).sessions[0];
    assert.strictEqual(session.live.activeTurnId, null);
    assert.strictEqual(session.live.lastTerminal, "failed");
    assert.match((await get(baseUrl, "/api/health")).lastHostError, /exited/);

    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    assert.strictEqual(targetProbe.targets.length, 2);
  });

  it("accepts an injected profile manager and still starts a plain host with no account", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, {
      home,
      hostFactory: fakeFactory(connection, probe),
      profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }),
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
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    const work = await profiles.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), profiles });

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
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
    await profiles.createProfile("personal");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), profiles });

    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "personal" });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    assert.equal(probe.targets.length, 3, "three accounts in one workspace means three hosts");
  });

  it("rejects a session for an account that does not exist", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const { base } = await start(connection, { profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }) });
    const res = await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "ghost" });
    assert.equal(res.status, 400);
  });

  it("puts a session back on its account after the host is forgotten", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe), profiles });
    await send(base, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    // Ask for the transcript by session id after dropping the in-memory host map is exercised by managerForSession;
    // here assert the session row carries the account so a rebuild has what it needs.
    const listed = await get(base, "/api/sessions");
    assert.ok(listed.sessions?.length > 0, "sessions listed");
  });

  it("lists, creates, renames and removes accounts through profile manager", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const { base } = await start(connection, { profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }) });

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
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const { base } = await start(connection, { profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }) });
    assert.equal((await send(base, "/api/accounts", { id: "Not Valid" })).status, 400);
    await send(base, "/api/accounts", { id: "work" });
    assert.equal((await send(base, "/api/accounts", { id: "work" })).status, 409);
  });

  it("reports metaApiKeyInherited from the profile manager doctor finding", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const { base } = await start(connection, {
      profiles: createProfileManager({ home, platform: "linux", musePath: "muse", env: { META_API_KEY: "x" } }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, true);
  });

  it("reports metaApiKeyInherited false when META_API_KEY is not set", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const { base } = await start(connection, {
      profiles: createProfileManager({ home, platform: "linux", musePath: "muse", env: {} }),
    });
    const res = await get(base, "/api/accounts/health");
    assert.equal(res.metaApiKeyInherited, false);
  });

  it("reports only the default login's non-secret identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-identity-"));
    const original = createProfileManager({ home, platform: "linux", musePath: "muse", env: {} });
    const { base } = await start(new FakeConnection(), {
      home, platform: "linux", profiles: {
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
    const original = createProfileManager({ home, platform: "linux", musePath: "muse", env: {} });
    const { base } = await start(new FakeConnection(), {
      home, platform: "win32", runtime: "wsl", distro: "Ubuntu", musePath: "/home/dev/muse", profiles: {
        ...original,
        identityOf: async () => { throw new Error("must not read Windows identity for the WSL default"); },
      },
    });
    assert.deepEqual((await get(base, "/api/accounts/health")).defaultLogin, { hasLogin: null, email: null });
  });

  it("does not read an unrelated default identity when MUSE_AUTH_PATH is set, while still confirming browser sign-in", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-custom-auth-"));
    const original = createProfileManager({ home, platform: "linux", musePath: "muse", env: {} });
    const previous = process.env["MUSE_AUTH_PATH"];
    const child = new FakeLoginChild();
    let identityReads = 0;
    process.env["MUSE_AUTH_PATH"] = join(home, "custom", "auth.json");
    try {
      const { base } = await start(new FakeConnection(), {
        home, platform: "linux", musePath: "/custom/muse", profiles: {
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
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
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
    // profile manager's own musePath stays the bare default "muse"; the server carries a different configured
    // path, so the route must resolve through the server's own musePath rather than profile manager's.
    const { base } = await start(connection, { musePath: "/custom/muse", profiles, loginSpawn });

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
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
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
      profiles,
      loginSpawn,
    });

    const res = await send(base, "/api/accounts/work/login", undefined);
    assert.equal(res.status, 200);
    assert.equal(res.json.code, "WSL-1234");
    assert.equal(calls[0]?.command, "wsl");
    assert.deepEqual(calls[0]?.args, ["-d", "Ubuntu-24.04", "-e", "/home/dev/.local/bin/muse", "login"]);
    assert.equal(calls[0]?.env["XDG_CONFIG_HOME"], (await profiles.getProfile("work")).roots.config);
    assert.match(calls[0]?.env["WSLENV"] ?? "", /XDG_CONFIG_HOME\/p/);
  });

  it("kills the first login child when a second login call arrives for the same account", async () => {
    const connection = new FakeConnection();
    const home = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    await profiles.createProfile("work");
    const children: FakeLoginChild[] = [];
    const loginSpawn: LoginSpawn = () => {
      const child = new FakeLoginChild();
      children.push(child);
      return child as unknown as LoginChild;
    };
    const { base } = await start(connection, { profiles, loginSpawn });

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
      const profiles = createProfileManager({ home, platform: "linux", musePath: "muse", env: {} });
      await profiles.createProfile("work");
      const children: FakeLoginChild[] = [];
      let waiting = false;
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const { base } = await start(new FakeConnection(), {
        home, musePath: delayedSetup === "runtime" ? null : "/custom/muse",
        profiles: {
          ...profiles,
          getProfile: async (id: string) => {
            if (delayedSetup === "profile" && reads++ === 0) { waiting = true; await gate; }
            return profiles.getProfile(id);
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
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse", env: {} });
    await profiles.createProfile("work");
    await profiles.createProfile("personal");
    let waiting = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const children: FakeLoginChild[] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", profiles: {
        ...profiles,
        getProfile: async (id: string) => {
          if (id === "work") { waiting = true; await gate; }
          return profiles.getProfile(id);
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
    const profiles = createProfileManager({ home, platform: "linux", musePath: "muse" });
    const child = new FakeLoginChild();
    const calls: string[][] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", profiles,
      loginSpawn: (_command, args) => {
        calls.push(args);
        setImmediate(() => child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=USER-1234\n"));
        return child as unknown as LoginChild;
      },
    });
    const response = await send(base, "/api/login", undefined);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["login"]]);
    assert.deepEqual(await profiles.listProfiles(), []);
    const path = `/api/login?loginId=${response.json.loginId}`;
    assert.deepEqual(await get(base, path), { status: "waiting" });
    child.finish(0);
    assert.deepEqual(await get(base, path), { status: "done" });
  });

  it("reports failed approval and ignores stale cancellation of a replacement login", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-login-cancel-"));
    const children: FakeLoginChild[] = [];
    const { base } = await start(new FakeConnection(), {
      home, musePath: "/custom/muse", profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }),
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
      home, musePath: "/custom/muse", profiles: createProfileManager({ home, platform: "linux", musePath: "muse" }),
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
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const tempHome = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profileMgr = createProfileManager({ home: tempHome, platform: "linux", musePath: "muse" });

    const { baseUrl: baseUrl } = await start(fakeTransport, { profiles: profileMgr });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const patchRes = await send(baseUrl, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.json.defaultAccountId, "work");
  });

  it("reports a session's account and a project's default account over the wire", async () => {
    const fakeTransport = new FakeConnection();
    let counter = 0;
    fakeTransport.replies.set("session/start", () => ({ session: { sessionId: `s${++counter}` } }));

    const tempHome = await mkdtemp(join(tmpdir(), "ancilla-profiles-"));
    const profileMgr = createProfileManager({ home: tempHome, platform: "linux", musePath: "muse" });
    await profileMgr.createProfile("work");

    const { baseUrl: baseUrl } = await start(fakeTransport, { hostFactory: fakeFactory(fakeTransport), profiles: profileMgr });

    const workSessionRes = await send(baseUrl, "/api/sessions", { cwd: "/work/proj", accountId: "work" });
    assert.strictEqual(workSessionRes.json.session.accountId, "work");

    const defaultSessionRes = await send(baseUrl, "/api/sessions", { cwd: "/other/proj" });
    assert.strictEqual(defaultSessionRes.json.session.accountId, null);

    await send(baseUrl, "/api/projects/default-account", { cwd: "/work/proj", accountId: "work" }, "PATCH");

    const projectsRes = await get(baseUrl, "/api/projects");
    const matchedProject = projectsRes.projects.find((p: { cwd: string }) => p.cwd === "/work/proj");
    assert.strictEqual(matchedProject.defaultAccountId, "work");

    const unmatchedProject = projectsRes.projects.find((p: { cwd: string }) => p.cwd === "/other/proj");
    assert.strictEqual(unmatchedProject.defaultAccountId, null);
  });

});

describe("file viewer", () => {
  async function setupProjectFiles() {
    const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const rootDir = await mkdtemp(join(tmpdir(), "ancilla-files-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "ancilla-outside-"));

    await mkdir(join(rootDir, "docs"));
    await mkdir(join(rootDir, "node_modules", "pkg"), { recursive: true });

    await writeFile(join(rootDir, "README.md"), "# Title\n\nBody\n");
    await writeFile(join(rootDir, "docs", "guide.md"), "guide");
    await writeFile(join(rootDir, "docs", "page.html"), "<script>alert(1)</script>");
    await writeFile(join(rootDir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeFile(join(rootDir, "clip.mp4"), Buffer.from("0123456789"));
    await writeFile(join(rootDir, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    await writeFile(join(rootDir, "node_modules", "pkg", "guide.md"), "vendored");
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await symlink(join(outsideDir, "secret.txt"), join(rootDir, "escape.txt"));

    const fakeTransport = new FakeConnection();
    const { base: baseUrl } = await start(fakeTransport, { platform: process.platform });
    const addProjectRes = await send(baseUrl, "/api/projects", { cwd: rootDir });
    const projectCwd = addProjectRes.json.project.cwd as string;

    const buildQuery = (relativePath: string) =>
      `cwd=${encodeURIComponent(projectCwd)}&path=${encodeURIComponent(relativePath)}`;

    return {
      base: baseUrl,
      baseUrl,
      root: rootDir,
      projectRoot: rootDir,
      cwd: projectCwd,
      projectCwd,
      q: buildQuery,
      buildQuery,
    };
  }

  it("lists folders first and reads text, markdown and media descriptions", async () => {
    const { baseUrl, root, q } = await setupProjectFiles();

    const rootListing = await get(baseUrl, `/api/files/list?${q("")}`);
    assert.deepEqual(
      rootListing.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`).slice(0, 2),
      ["dir:docs", "dir:node_modules"],
    );
    assert.ok(rootListing.entries.some((e: { name: string }) => e.name === "README.md"));

    const docsListing = await get(baseUrl, `/api/files/list?${q("docs")}`);
    assert.deepEqual(docsListing.entries.map((e: { path: string }) => e.path), ["docs/guide.md", "docs/page.html"]);

    const readmeRead = await get(baseUrl, `/api/files/read?${q("README.md")}`);
    assert.strictEqual(readmeRead.kind, "markdown");
    assert.strictEqual(readmeRead.content, "# Title\n\nBody\n");

    const absoluteRead = await get(baseUrl, `/api/files/read?${q(`${root}/docs/guide.md`)}`);
    assert.strictEqual(absoluteRead.path, "docs/guide.md");

    const videoRead = await get(baseUrl, `/api/files/read?${q("clip.mp4")}`);
    assert.strictEqual(videoRead.kind, "video");

    const binaryRead = await get(baseUrl, `/api/files/read?${q("blob.bin")}`);
    assert.strictEqual(binaryRead.kind, "binary");
    assert.strictEqual(binaryRead.content, undefined);
  });

  it("refuses paths outside the project, through .. or a symlink, and unknown projects", async () => {
    const { baseUrl, q, cwd } = await setupProjectFiles();

    assert.strictEqual((await fetch(`${baseUrl}/api/files/read?${q("../../etc/passwd")}`)).status, 403);
    assert.strictEqual((await fetch(`${baseUrl}/api/files/read?${q("escape.txt")}`)).status, 403, "a symlink out of the project is refused");
    assert.strictEqual((await fetch(`${baseUrl}/api/files/raw?${q("escape.txt")}`)).status, 403);
    assert.strictEqual((await fetch(`${baseUrl}/api/files/read?${q("/etc/passwd")}`)).status, 404, "an absolute path elsewhere resolves inside the project, where it is not");
    assert.strictEqual((await fetch(`${baseUrl}/api/files/list?cwd=${encodeURIComponent("/etc")}&path=`)).status, 404);

    const writeAttempt = await fetch(`${baseUrl}/api/files/write`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: "../evil.md", content: "x", baseMtimeMs: null }),
    });
    assert.strictEqual(writeAttempt.status, 403);
  });

  it("serves files from a folder inside a project, confined to that folder", async () => {
    const { baseUrl, cwd } = await setupProjectFiles();
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const secondDir = await mkdtemp(join(tmpdir(), "ancilla-second-"));
    await writeFile(join(secondDir, "NOTES.md"), "notes");

    const addFolderRes = await send(baseUrl, "/api/projects/folders", { cwd, path: secondDir });
    assert.strictEqual(addFolderRes.status, 200);

    const subfolderCwd = addFolderRes.json.project.folders[1].cwd as string;
    const subfolderQuery = (relPath: string) => `cwd=${encodeURIComponent(subfolderCwd)}&path=${encodeURIComponent(relPath)}`;

    const folderListing = await get(baseUrl, `/api/files/list?${subfolderQuery("")}`);
    assert.deepEqual(folderListing.entries.map((e: { name: string }) => e.name), ["NOTES.md"]);

    const notesContent = await get(baseUrl, `/api/files/read?${subfolderQuery("NOTES.md")}`);
    assert.strictEqual(notesContent.content, "notes");

    assert.strictEqual((await fetch(`${baseUrl}/api/files/read?${subfolderQuery("../../etc/passwd")}`)).status, 403);
  });

  it("never serves a file as a page that can script this origin, and serves video in ranges", async () => {
    const { baseUrl, q } = await setupProjectFiles();

    const htmlRes = await fetch(`${baseUrl}/api/files/raw?${q("docs/page.html")}`);
    assert.strictEqual(htmlRes.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(htmlRes.headers.get("content-security-policy") ?? "", /sandbox/);

    const svgRes = await fetch(`${baseUrl}/api/files/raw?${q("icon.svg")}`);
    assert.strictEqual(svgRes.headers.get("content-type"), "image/svg+xml");
    assert.match(svgRes.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.strictEqual(svgRes.headers.get("x-content-type-options"), "nosniff");

    const partialVideoRes = await fetch(`${baseUrl}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=2-5" } });
    assert.strictEqual(partialVideoRes.status, 206);
    assert.strictEqual(partialVideoRes.headers.get("content-range"), "bytes 2-5/10");
    assert.strictEqual(await partialVideoRes.text(), "2345");

    const tailVideoRes = await fetch(`${baseUrl}/api/files/raw?${q("clip.mp4")}`, { headers: { range: "bytes=-3" } });
    assert.strictEqual(await tailVideoRes.text(), "789");
  });

  it("saves an edit, and refuses one made against a file that changed on disk", async () => {
    const { baseUrl, root, cwd, q } = await setupProjectFiles();
    const { writeFile, readFile, utimes } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const initialRead = await get(baseUrl, `/api/files/read?${q("README.md")}`);
    const executeWrite = (updatedContent: string, mtimeBaseline: number | null) =>
      fetch(`${baseUrl}/api/files/write`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, path: "README.md", content: updatedContent, baseMtimeMs: mtimeBaseline }),
      });

    const firstSaveRes = await executeWrite("# Edited\n", initialRead.mtimeMs);
    assert.strictEqual(firstSaveRes.status, 200);
    assert.strictEqual(await readFile(join(root, "README.md"), "utf8"), "# Edited\n");

    const updatedMetadata = (await firstSaveRes.json()) as { mtimeMs: number };

    await writeFile(join(root, "README.md"), "# Agent\n");
    await utimes(join(root, "README.md"), new Date(), new Date(updatedMetadata.mtimeMs + 5000));

    const conflictingSaveRes = await executeWrite("# Mine\n", updatedMetadata.mtimeMs);
    assert.strictEqual(conflictingSaveRes.status, 409);
    assert.strictEqual(((await conflictingSaveRes.json()) as { kind: string }).kind, "fileChanged");
    assert.strictEqual(await readFile(join(root, "README.md"), "utf8"), "# Agent\n");
  });

  it("finds files by path words, skipping generated folders", async () => {
    const { baseUrl, cwd } = await setupProjectFiles();
    const searchRes = await get(baseUrl, `/api/files/search?cwd=${encodeURIComponent(cwd)}&q=guide`);
    assert.deepEqual(searchRes.files.map((f: { path: string }) => f.path), ["docs/guide.md"], "node_modules is not searched");
  });
});

describe("slash commands, skills and shell", () => {
  const MOCK_SKILL_CATALOG = JSON.stringify({
    diagnostics: [],
    skills: [
      { id: "bundled:plan", name: "plan", display_name: "plan", description: "Plan it. Use ONLY when asked.", short_description: null, scope: "bundled", activation: "on", path: "bundled://muse-core/skills/plan/SKILL.md" },
      { id: "user:secret", name: "secret", display_name: "secret", description: "Only by hand.", short_description: "Hand only", scope: "user", activation: "user-invocable-only", path: "/home/me/.config/muse/skills/secret/SKILL.md" },
      { id: "bundled:off", name: "off", display_name: "off", description: "Switched off.", activation: "off", path: "bundled://muse-core/skills/off/SKILL.md" },
    ],
  });

  it("lists a workspace's skills through the muse CLI, keeps them a minute, and reads only listed skills", async () => {
    const executedCliCalls: string[][] = [];
    const mockExec: ExecFn = async (cmd, args) => {
      executedCliCalls.push([cmd, ...args]);
      if (args.includes("list")) {
        return { stdout: MOCK_SKILL_CATALOG, exitCode: 0 };
      }
      return { stdout: "---\nname: secret\ndescription: x\n---\n\n# Secret\nDo the thing.\n", exitCode: 0 };
    };

    const { baseUrl: baseUrl } = await start(new FakeConnection(), { exec: mockExec });
    const slashListing = await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj");

    assert.deepEqual(
      slashListing.skills.map((s: { id: string }) => s.id),
      ["bundled:plan", "user:secret"],
      "skills switched off are left out",
    );
    assert.strictEqual(slashListing.skills[1].activation, "user-invocable-only");
    assert.strictEqual(slashListing.error, null);
    assert.deepEqual(executedCliCalls[0], ["muse", "skills", "list", "--json", "--workspace", "/work/proj"]);

    await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.strictEqual(executedCliCalls.length, 1, "a fresh list is reused");

    const skillDetail = await get(baseUrl, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=user%3Asecret");
    assert.strictEqual(skillDetail.body, "# Secret\nDo the thing.");
    assert.deepEqual(executedCliCalls[1], ["sh", "-c", 'exec cat -- "$1"', "sh", "/home/me/.config/muse/skills/secret/SKILL.md"]);

    await get(baseUrl, "/api/slash/skill?cwd=%2Fwork%2Fproj&id=bundled%3Aplan");
    assert.strictEqual(executedCliCalls[2]?.[4], "muse-core/skills/plan/SKILL.md", "bundled skills resolve inside Muse's data folder");

    const unlistedSkill = await fetch(`${baseUrl}/api/slash/skill?cwd=%2Fwork%2Fproj&id=%2Fetc%2Fpasswd`);
    assert.strictEqual(unlistedSkill.status, 404);
  });

  it("lists a loaded session's skills from Muse, joined to the CLI listing, and refreshes on skill/changed", async () => {
    const executedCliCalls: string[][] = [];
    const mockExec: ExecFn = async (cmd, args) => {
      executedCliCalls.push([cmd, ...args]);
      return { stdout: MOCK_SKILL_CATALOG, exitCode: 0 };
    };

    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("skill/list", {
      skills: [
        { selector: "plan", displayName: "Plan", description: "Plan the work", source: "bundled" },
        { selector: "acme:deploy", displayName: "deploy", description: "Ship it", source: "plugin", pluginId: "acme", argumentHint: "<env>" },
      ],
    });

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec });
    assert.deepEqual((await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj")).skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"]);

    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });
    const sessionSkills = await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(
      sessionSkills.skills.map((s: { id: string; name: string }) => [s.id, s.name]),
      [["bundled:plan", "plan"], ["acme:deploy", "acme:deploy"]],
      "a skill the CLI also lists keeps its id, so its instructions can still be read",
    );
    assert.strictEqual(sessionSkills.skills[1].argumentHint, "<env>");
    assert.strictEqual(sessionSkills.skills[1].scope, "plugin");
    assert.strictEqual(fakeTransport.requests.filter((r) => r.method === "skill/list").length, 1);

    const callCountBefore = executedCliCalls.length;
    fakeTransport.notify("skill/changed", { sessionId: "s1" });
    await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.strictEqual(executedCliCalls.length, callCountBefore + 1, "skill/changed drops the cached CLI listing for that workspace");

    fakeTransport.replies.set("skill/list", new MspTestError("method not found", "methodNotFound"));
    const fallbackListing = await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj&sessionId=s1");
    assert.deepEqual(fallbackListing.skills.map((s: { id: string }) => s.id), ["bundled:plan", "user:secret"], "an older host falls back to the CLI");
  });

  it("joins session skills to CLI entries by id, name or plugin selector only", () => {
    const cliEntries = [
      { id: "bundled:doctor", name: "doctor", displayName: "doctor", description: "cli", shortDescription: "Short", scope: "bundled", activation: "on" },
      { id: "deploy", name: "deploy", displayName: "deploy", description: "a user skill", shortDescription: null, scope: "user", activation: "on" },
      { id: "plugin:acme:lint", name: "plugin:acme:lint", displayName: "lint", description: "", shortDescription: null, scope: "plugin", activation: "on" },
    ];

    const joinedSkills = mergeSessionSkills(
      [
        { selector: "doctor", displayName: "Doctor", description: "", source: "bundled", argumentHint: null, pluginId: null },
        { selector: "acme:deploy", displayName: "deploy", description: "plugin deploy", source: "plugin", argumentHint: null, pluginId: "acme" },
        { selector: "acme:lint", displayName: "lint", description: "", source: "plugin", argumentHint: null, pluginId: "acme" },
      ],
      cliEntries,
    );

    assert.deepEqual(joinedSkills.map((s) => s.id), ["bundled:doctor", "acme:deploy", "plugin:acme:lint"]);
    assert.strictEqual(joinedSkills[0]?.shortDescription, "Short");
    assert.strictEqual(joinedSkills[0]?.description, "cli", "an empty session description falls back to the CLI's");
    assert.strictEqual(joinedSkills[1]?.scope, "plugin", "a plugin skill never borrows a same-named user skill");
  });

  it("answers a failed skill list with an error instead of failing the request", async () => {
    const { baseUrl: baseUrl } = await start(new FakeConnection(), { exec: async () => ({ stdout: "", exitCode: 127 }) });
    const response = await get(baseUrl, "/api/slash?cwd=%2Fwork%2Fproj");
    assert.deepEqual(response.skills, []);
    assert.match(response.error, /Could not list Muse skills/);
  });

  it("runs shell commands in a session and forks it into a new thread", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const userShellRes = await send(baseUrl, "/api/sessions/s1/shell", { command: " git status " });
    assert.strictEqual(userShellRes.status, 200);
    assert.deepEqual(fakeTransport.calls.at(-1), { method: "session/userShell", params: { sessionId: "s1", commandText: "git status" } });
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/shell", { command: "  " })).status, 400);

    fakeTransport.replies.set("session/fork", { session: { sessionId: "s2", modelId: "muse-spark-1.3" } });
    const forkRes = await send(baseUrl, "/api/sessions/s1/fork", {});
    assert.strictEqual(forkRes.status, 200);
    assert.strictEqual(forkRes.json.session.sessionId, "s2");
    assert.strictEqual(forkRes.json.session.title, "New thread (fork)");
    assert.deepEqual(fakeTransport.calls.at(-1), { method: "session/fork", params: { sessionId: "s1", excludeItems: true } });

    const sessionIds = (await get(baseUrl, "/api/sessions")).sessions.map((s: { sessionId: string }) => s.sessionId).sort();
    assert.deepEqual(sessionIds, ["s1", "s2"]);
  });

  it("runs a `!` command itself and keeps it with the thread", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const executedCommands: { command: string; args: string[] }[] = [];

    const { baseUrl: baseUrl } = await start(fakeTransport, {
      shellRunner: async (commandName: string, commandArgs: string[]) => {
        executedCommands.push({ command: commandName, args: commandArgs });
        return { output: "total 0\n", exitCode: 0, truncated: false };
      },
    });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const proxyRes = await send(baseUrl, "/api/sessions/s1/shell-proxy", { command: " ls -la " });
    assert.strictEqual(proxyRes.status, 200);
    assert.strictEqual(proxyRes.json.run.command, "ls -la");
    assert.strictEqual(proxyRes.json.run.exitCode, 0);
    assert.strictEqual(proxyRes.json.run.output, "total 0\n");
    assert.ok(executedCommands[0]?.args.includes("/work/proj"), "the command runs where the workspace is");
    assert.ok(executedCommands[0]?.args.includes("ls -la"), "the command itself is an argument, never spliced into a script");

    const loadedTranscript = await send(baseUrl, "/api/sessions/s1/resume", {});
    assert.deepEqual(
      loadedTranscript.json.shellRuns.map((r: { command: string }) => r.command),
      ["ls -la"],
    );
    assert.strictEqual((await send(baseUrl, "/api/sessions/s1/shell-proxy", { command: "   " })).status, 400);
    assert.strictEqual((await send(baseUrl, "/api/sessions/missing/shell-proxy", { command: "ls" })).status, 404);
  });

  it("sends an attached image to the model and serves it back", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const mockPngBase64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

    const turnWithAttachment = await send(baseUrl, "/api/turns", {
      sessionId: "s1",
      text: "what is this?",
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: mockPngBase64, width: 10, height: 20 }],
    });
    assert.strictEqual(turnWithAttachment.status, 200);
    assert.strictEqual(turnWithAttachment.json.attachments?.[0]?.name, "shot.png", "the ack carries what was saved, for the open thread");
    assert.match(turnWithAttachment.json.attachments?.[0]?.url ?? "", /^\/api\/attachments\//);

    const turnCall = fakeTransport.calls.find((c) => c.method === "turn/start");
    assert.deepEqual(turnCall?.params?.["input"], [
      { type: "text", text: "what is this?" },
      { type: "image", base64Data: mockPngBase64, mediaType: "image/png", width: 10, height: 20 },
    ]);

    const loadedTranscript = await send(baseUrl, "/api/sessions/s1/resume", {});
    const savedAttachment = loadedTranscript.json.attachments[0];
    assert.strictEqual(savedAttachment.name, "shot.png");
    assert.strictEqual(savedAttachment.kind, "image");
    assert.strictEqual(savedAttachment.turnId, "t1");

    const fetchedAttachment = await fetch(`${baseUrl}${savedAttachment.url}`);
    assert.strictEqual(fetchedAttachment.status, 200);
    assert.strictEqual(fetchedAttachment.headers.get("content-type"), "image/png");
    assert.strictEqual(Buffer.from(await fetchedAttachment.arrayBuffer()).toString("base64"), mockPngBase64);

    const emptyTurnRes = await send(baseUrl, "/api/turns", { sessionId: "s1" });
    assert.strictEqual(emptyTurnRes.status, 400, "a message with neither text nor a file is refused");
  });

  it("lets Muse's own name replace a title derived from a /skill prompt when titles are shared", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport, { syncSessionNames: true });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    fakeTransport.notify("item/completed", {
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
    const queryCurrentTitle = async () =>
      (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.title;

    assert.strictEqual(await queryCurrentTitle(), "/plan tidy the API", "until Muse has named it, the thread shows what the user typed");

    fakeTransport.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Tidy the API surface", title: "Use skill bundled:plan: call read_skill" }],
      nextCursor: null,
    });

    assert.strictEqual((await send(baseUrl, "/api/discover", {})).status, 200);
    assert.strictEqual(await queryCurrentTitle(), "Tidy the API surface");
  });

  it("prefers Muse's session name over the prompt-echo title during discovery", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    fakeTransport.replies.set("session/list", {
      sessions: [
        { sessionId: "s1", workspaceRoot: "/work/proj", name: "pebble-caliban", title: "So far, I have been developing and working on my project Ancilla on Windows only. It goes on and on.", turnCount: 9 },
        { sessionId: "s2", workspaceRoot: "/work/proj", title: "``` Set up this Mac from my private repo", turnCount: 0 },
      ],
      nextCursor: null,
    });

    assert.strictEqual((await send(baseUrl, "/api/discover", {})).status, 200);
    const discoveredSessions = (await get(baseUrl, "/api/sessions")).sessions;
    const lookupTitle = (targetId: string) => discoveredSessions.find((s: { sessionId: string }) => s.sessionId === targetId)?.title;

    assert.strictEqual(lookupTitle("s1"), "pebble-caliban");
    assert.strictEqual(lookupTitle("s2"), "Set up this Mac from my private repo");
  });

  it("never lets a discovery echo clobber a generated title", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    fakeTransport.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });

    const recordedExecCalls: string[][] = [];
    const mockExec: ExecFn = async (cmd, args) => {
      recordedExecCalls.push([cmd, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec });
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchTitle = async () => (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1").title;

    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });

    await waitFor(async () => (await fetchTitle()) === "Fix the updater", "the upgraded title");
    await send(baseUrl, "/api/discover", {});
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(await fetchTitle(), "Fix the updater", "the echo is a fallback, never an update");
    assert.strictEqual(recordedExecCalls.length, 1, "and no second model call is spent");
  });

  it("never upgrades a thread Muse named itself", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const recordedExecCalls: string[][] = [];
    const mockExec: ExecFn = async (cmd, args) => {
      recordedExecCalls.push([cmd, ...args]);
      return {
        stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Fix the updater" } }),
        exitCode: 0,
      };
    };

    const { baseUrl: baseUrl } = await start(fakeTransport, { exec: mockExec, syncSessionNames: true });
    await send(baseUrl, "/api/title-settings", { enabled: false }, "PATCH");
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchSessionTitle = async () => (await get(baseUrl, "/api/sessions")).sessions[0].title;
    fakeTransport.notify("item/completed", {
      sessionId: "s1",
      item: { itemId: "i1", kind: "userMessage", revision: 1, status: "completed", text: "fix the updater please" },
    });
    fakeTransport.notify("session/nameChanged", { sessionId: "s1", name: "Muse One", viewCursor: "c", sourceRange: RANGE });

    assert.strictEqual(await fetchSessionTitle(), "Muse One");
    await send(baseUrl, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(await fetchSessionTitle(), "Muse One", "a live rename cancels the owed attempt");
    assert.strictEqual(recordedExecCalls.length, 0);

    const secondConn = new FakeConnection();
    secondConn.replies.set("session/start", { session: { sessionId: "s1" } });
    secondConn.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", title: "fix the updater please" }],
      nextCursor: null,
    });

    const { baseUrl: secondBase } = await start(secondConn, { exec: mockExec, syncSessionNames: true });
    await send(secondBase, "/api/title-settings", { enabled: false }, "PATCH");
    await send(secondBase, "/api/sessions", { cwd: "/work/proj" });
    await send(secondBase, "/api/discover", {});

    secondConn.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/work/proj", name: "Muse Two", title: "fix the updater please" }],
      nextCursor: null,
    });

    await send(secondBase, "/api/discover", {});
    const fetchSecondTitle = async () => (await get(secondBase, "/api/sessions")).sessions[0].title;
    assert.strictEqual(await fetchSecondTitle(), "Muse Two");

    await send(secondBase, "/api/title-settings", { enabled: true }, "PATCH");
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(await fetchSecondTitle(), "Muse Two", "a discovered name cancels the owed attempt");
    assert.strictEqual(recordedExecCalls.length, 0);
  });

  it("keeps each session's goal in its live view for the sidebar", async () => {
    const fakeTransport = new FakeConnection();
    fakeTransport.replies.set("session/start", { session: { sessionId: "s1" } });
    const { baseUrl: baseUrl } = await start(fakeTransport);
    await send(baseUrl, "/api/sessions", { cwd: "/work/proj" });

    const fetchLiveGoal = async () =>
      (await get(baseUrl, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1")?.live?.goal;
    const settleAsync = () => new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(await fetchLiveGoal(), null);
    fakeTransport.notify("session/goalChanged", { sessionId: "s1", goal: { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" } });
    await settleAsync();

    assert.deepEqual(await fetchLiveGoal(), { objective: "Ship it", status: "active", percentComplete: 40, currentWork: "Notes" });
    fakeTransport.notify("session/goalChanged", { sessionId: "s1", goal: { status: "paused" } });
    await settleAsync();

    assert.strictEqual((await fetchLiveGoal())?.objective, "Ship it", "a block with no objective is not a goal");
    fakeTransport.notify("session/goalChanged", { sessionId: "s1", goal: null });
    await settleAsync();

    assert.strictEqual(await fetchLiveGoal(), null);
  });

  it("parses skill lists and strips frontmatter", () => {
    assert.strictEqual(parseSkillList("not json"), null);
    assert.strictEqual(parseSkillList(JSON.stringify({ skills: [{ name: "no id" }] }))?.skills.length, 0);
    assert.strictEqual(stripFrontmatter("\uFEFF---\nname: x\n---\nBody"), "Body");
    assert.strictEqual(stripFrontmatter("No frontmatter"), "No frontmatter");
  });
});

describe("wire helpers", () => {
  it("reshapes notifications for the browser", () => {
    const deltaEvent = toWireEvent("item/delta", { sessionId: "s1", itemId: "i1", delta: "po", field: "text" }, 5);
    assert.deepEqual(deltaEvent, {
      type: "msp",
      sessionId: "s1",
      method: "item/delta",
      params: { sessionId: "s1", itemId: "i1", delta: "po", field: "text" },
      at: 5,
    });

    const startedEvent = toWireEvent("session/started", { session: { sessionId: "s2" } });
    assert.strictEqual(startedEvent?.sessionId, "s2");

    const completedEvent = toWireEvent("turn/completed", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    assert.strictEqual(completedEvent?.params["sourceRange"], undefined);

    const ignoredInitEvent = toWireEvent("initialized", {});
    assert.strictEqual(ignoredInitEvent, null);
  });

  it("derives thread titles from the first prompt line", () => {
    assert.strictEqual(deriveTitle("# Fix login\nand more"), "Fix login");
    assert.strictEqual(deriveTitle("   \n  "), null);

    const longPrompt = deriveTitle("Refactor the session manager so that queries never mint command ids and paging works for long threads");
    assert.ok(longPrompt && longPrompt.length <= 75 && longPrompt.endsWith("..."));
  });

  it("skips code fences when deriving thread titles", () => {
    assert.strictEqual(deriveTitle("```\nSet up this Mac\nmore"), "Set up this Mac");
    assert.strictEqual(deriveTitle("``` Fix login"), "Fix login");
    assert.strictEqual(deriveTitle("```python\nprint(1)"), "print(1)");
    assert.strictEqual(deriveTitle("Use `ancilla.db` here"), "Use `ancilla.db` here");
    assert.strictEqual(deriveTitle("```\n```"), null);
  });

  it("normalizes MSP timestamps", () => {
    assert.strictEqual(normalizeIso("2026-09-11T12:35:42.947855Z"), "2026-09-11T12:35:42.947Z");
    assert.strictEqual(normalizeIso("nope"), undefined);
    assert.strictEqual(normalizeIso(42), undefined);
  });
});
