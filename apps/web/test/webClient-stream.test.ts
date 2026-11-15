import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { AncillaEvent } from "@ancilla/ui";

/**
 * The browser's event stream as the client wraps it: what a listener that throws costs, how often a retrying
 * EventSource says the connection is lost, and that coming back never sends anything.
 */

class FakeEventSource {
  static made: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  close(): void {
    this.closed = true;
  }

  /** What the browser does: calls every listener of that type. */
  fire(type: string, data?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) });
    }
  }
}

interface Request {
  method: string;
  url: string;
}

function browser() {
  FakeEventSource.made = [];
  const requests: Request[] = [];
  const globals = globalThis as Record<string, unknown>;
  globals["window"] = {
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState: () => {} },
  };
  globals["fetch"] = async (target: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url: String(target) });
    return new Response(JSON.stringify({ ok: true, projects: [], sessions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  globals["EventSource"] = FakeEventSource;
  return { requests };
}

let seq = 0;
async function freshClient() {
  seq += 1;
  const module = (await import(`../src/webClient.js?stream=${seq}`)) as typeof import("../src/webClient.js");
  return new module.WebAncillaClient();
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

async function opened() {
  const world = browser();
  const client = await freshClient();
  const heard: AncillaEvent[] = [];
  const stop = client.subscribe((event) => heard.push(event));
  await flush();
  const source = FakeEventSource.made[0];
  assert.ok(source, "a stream was opened");
  return { world, client, heard, stop, source };
}

afterEach(() => {
  mock.restoreAll();
});

describe("a listener that throws on the event stream", () => {
  it("is logged, spares the other listeners, and leaves the stream open", async () => {
    const { client, stop, source } = await opened();
    const logged = mock.method(console, "error", () => undefined);
    const others: AncillaEvent[] = [];
    const quitFirst = client.subscribe(() => {
      throw new Error("controller exploded");
    });
    const quitSecond = client.subscribe((event) => others.push(event));

    assert.doesNotThrow(() => source.fire("ancilla", { type: "sessions-changed" }));
    assert.equal(logged.mock.calls.length, 1, "logged once");
    assert.match(logged.mock.calls[0]?.arguments.map(String).join(" ") ?? "", /controller exploded/);
    assert.deepEqual(others, [{ type: "sessions-changed" }], "the listener after it still heard the event");
    assert.equal(source.closed, false, "the stream was not torn down");
    assert.equal(FakeEventSource.made.length, 1, "and none was opened in its place");

    source.fire("ancilla", { type: "plan-usage" });
    assert.equal(others.length, 2, "the next event still arrives");
    quitFirst();
    quitSecond();
    stop();
  });

  it("is not mistaken for a frame that could not be read", async () => {
    const { heard, stop, source } = await opened();
    const logged = mock.method(console, "error", () => undefined);
    source.fire("ancilla", "{not json");
    assert.deepEqual(heard, [], "a malformed frame is dropped");
    assert.equal(logged.mock.calls.length, 0, "without noise");
    assert.equal(source.closed, false);
    stop();
  });
});

describe("a stream the browser keeps retrying", () => {
  it("says the connection is lost once, however many times it retries", async () => {
    const { heard, stop, source } = await opened();
    source.fire("error");
    source.fire("error");
    source.fire("error");
    assert.deepEqual(heard, [{ type: "connection", state: "lost" }]);
    stop();
  });

  it("says so again after the stream has been heard from, and lost once more", async () => {
    const { heard, stop, source } = await opened();
    source.fire("error");
    source.fire("open");
    source.fire("ancilla", { type: "hello", version: "1" });
    source.fire("error");
    source.fire("error");
    assert.deepEqual(heard.map((event) => event.type), ["connection", "hello", "connection"]);
    stop();
  });

  it("still says it when a stream that went quiet is rebuilt, and again if the new one cannot connect either", async () => {
    browser();
    const client = await freshClient();
    mock.timers.enable({ apis: ["setTimeout"] });
    const heard: AncillaEvent[] = [];
    let stop = () => undefined as void;
    try {
      stop = client.subscribe((event) => heard.push(event));
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(70_001);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(FakeEventSource.made.length, 2);
      FakeEventSource.made[1]?.fire("error");
      assert.deepEqual(heard, [{ type: "connection", state: "lost" }], "one notice for the quiet stream and the retries after it");
    } finally {
      stop();
      mock.timers.reset();
    }
  });

  it("reconnecting rereads through the app and never sends a prompt", async () => {
    const world = browser();
    const client = await freshClient();
    const { AncillaController } = await import("@ancilla/ui");
    const platform = {
      loadPrefs: () => null,
      savePrefs: () => {},
      readHash: () => "",
      writeHash: () => {},
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => false,
    };
    const controller = new AncillaController(client, platform);
    const stop = controller.start();
    try {
      await flush();
      await flush();
      const source = FakeEventSource.made[0];
      assert.ok(source, "the controller opened the stream");
      assert.equal(controller.store.get().boot, "ready");
      const before = world.requests.length;
      source.fire("error");
      assert.equal(controller.store.get().connection, "lost");
      source.fire("open");
      source.fire("ancilla", { type: "hello", version: "1" });
      await flush();
      await flush();
      assert.equal(controller.store.get().connection, "open");
      const after = world.requests.slice(before);
      assert.ok(after.some((request) => request.url.startsWith("/api/sessions")), "the lists were read again");
      assert.ok(after.every((request) => request.method === "GET"), `only reads: ${JSON.stringify(after)}`);
      assert.equal(world.requests.some((request) => /\/turns/.test(request.url)), false);
    } finally {
      stop();
    }
  });
});
