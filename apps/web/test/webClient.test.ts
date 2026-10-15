import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * `webClient` reads where its daemon lives once, as the module loads, so every case installs its
 * browser first and then imports a fresh copy of the module through a unique specifier.
 */

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

class FakeEventSource {
  static made: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.made.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) {
      existing.push(handler);
    } else {
      this.listeners.set(type, [handler]);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function browser(options: { search?: string; stored?: Record<string, string> } = {}) {
  const storage: Record<string, string> = { ...(options.stored ?? {}) };
  const replaced: string[] = [];
  const calls: Recorded[] = [];
  FakeEventSource.made = [];

  const globals = globalThis as Record<string, unknown>;
  globals["window"] = {
    localStorage: {
      getItem: (key: string) => (key in storage ? (storage[key] as string) : null),
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
    },
    location: { search: options.search ?? "", pathname: "/", hash: "" },
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        replaced.push(next);
      },
    },
  };
  globals["fetch"] = async (target: string, init?: RequestInit) => {
    calls.push({ url: target, init });
    return new Response(JSON.stringify({ ok: true, projects: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globals["EventSource"] = FakeEventSource;

  return { storage, replaced, calls };
}

let seq = 0;
/** A fresh copy of the module, so one case's stored daemon cannot leak into the next. */
async function freshClient() {
  seq += 1;
  return (await import(`../src/webClient.js?case=${seq}`)) as typeof import("../src/webClient.js");
}

describe("web client", () => {
  it("authenticates Linux setup actions and scopes repair/cancellation without sending shell commands", async () => {
    const world = browser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();
    await client.linuxSetup();
    await client.linuxSetup("work/profile");
    await client.installLinuxMuse();
    await client.cancelLinuxMuseInstall("attempt/a b");
    await client.repairLinuxStorage("work/profile");
    assert.deepEqual(world.calls.map((entry) => [entry.init?.method, entry.url]), [
      ["GET", "/api/setup/linux"],
      ["GET", "/api/setup/linux?accountId=work%2Fprofile"],
      ["POST", "/api/setup/linux/install"],
      ["DELETE", "/api/setup/linux/install?attemptId=attempt%2Fa%20b"],
      ["POST", "/api/setup/linux/repair"],
    ]);
    assert.equal(world.calls[2]?.init?.body, "{}");
    assert.equal(world.calls[4]?.init?.body, JSON.stringify({ accountId: "work/profile" }));
    for (const entry of world.calls) assert.equal((entry.init?.headers as Record<string, string>)["authorization"], "Bearer secret");
  });

  it("takes a token out of the address bar and keeps it", async () => {
    const world = browser({ search: "?token=secret" });
    const { currentDaemon } = await freshClient();

    assert.equal(currentDaemon().token, "secret");
    assert.deepEqual(JSON.parse(world.storage["ancilla:daemon"] as string), { base: "", token: "secret" });
    // The whole point: the credential stops being part of a URL anyone could copy.
    assert.deepEqual(world.replaced, ["/"]);
  });

  it("sends the token as a header, never in the path", async () => {
    const world = browser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await freshClient();

    await new WebAncillaClient().listProjects();

    const call = world.calls.at(-1);
    assert.equal(call?.url, "/api/projects");
    assert.match(String((call?.init?.headers as Record<string, string>)["authorization"]), /^Bearer secret$/);
    assert.doesNotMatch(call?.url ?? "", /token=/);
  });

  it("downloads report bytes from the selected daemon using header authentication", async () => {
    browser({ stored: { "ancilla:daemon": JSON.stringify({ base: "https://box.example:3127", token: "secret" }) } });
    const { WebAncillaClient } = await freshClient();
    const bytes = new Uint8Array([80, 75, 3, 4, 255]);
    const fetcher = mock.method(globalThis, "fetch", async (target: string | URL | Request, init?: RequestInit) => {
      assert.equal(target, "https://box.example:3127/api/research/run%2F1/export/report.docx");
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer secret");
      assert.equal(init?.credentials, "include");
      assert.ok(init?.signal);
      return new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    });
    try {
      assert.deepEqual(await new WebAncillaClient().readResearchExport("run/1", "docx"), bytes);
    } finally {
      fetcher.mock.restore();
    }
  });

  it("reports failed document downloads instead of saving the server error as a document", async () => {
    browser();
    const { WebAncillaClient } = await freshClient();
    const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "That export has not been generated yet." }), { status: 404 }));
    try {
      await assert.rejects(new WebAncillaClient().readResearchExport("r1", "pdf"), /That export has not been generated yet/);
    } finally {
      fetcher.mock.restore();
    }
  });

  it("addresses a daemon elsewhere absolutely, and sends its cookie with it", async () => {
    const world = browser({
      stored: { "ancilla:daemon": JSON.stringify({ base: "https://box.example:3127", token: "secret" }) },
    });
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    await client.listProjects();
    assert.equal(world.calls.at(-1)?.url, "https://box.example:3127/api/projects");
    assert.equal(world.calls.at(-1)?.init?.credentials, "include");

    // An image the browser loads itself: absolute, and with nothing secret in it.
    const asset = client.assetUrl("/api/attachments/abc");
    assert.equal(asset, "https://box.example:3127/api/attachments/abc");
    assert.doesNotMatch(asset, /secret/);
  });

  it("starts from the daemon Helicon saved, without writing Helicon's key", async () => {
    const world = browser({
      stored: { "helicon:daemon": JSON.stringify({ base: "https://box.example:3127", token: "secret" }) },
    });
    const { WebAncillaClient, currentDaemon } = await freshClient();

    assert.deepEqual(currentDaemon(), { base: "https://box.example:3127", token: "secret" });
    await new WebAncillaClient().listProjects();
    assert.equal(world.calls.at(-1)?.url, "https://box.example:3127/api/projects");
    assert.equal(world.storage["helicon:daemon"], JSON.stringify({ base: "https://box.example:3127", token: "secret" }));
  });

  it("prefers its own saved daemon over Helicon's", async () => {
    browser({
      stored: {
        "ancilla:daemon": JSON.stringify({ base: "", token: "mine" }),
        "helicon:daemon": JSON.stringify({ base: "https://old.example", token: "theirs" }),
      },
    });
    const { currentDaemon } = await freshClient();

    assert.deepEqual(currentDaemon(), { base: "", token: "mine" });
  });

  it("earns the cookie before opening the stream", async () => {
    const world = browser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await freshClient();

    const stop = new WebAncillaClient().subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // EventSource cannot carry a header, so /api/auth has to come first or the stream is refused.
    assert.equal(world.calls.at(0)?.url, "/api/auth");
    assert.equal(FakeEventSource.made.length, 1);
    assert.equal(FakeEventSource.made[0]?.url, "/api/events");
    // Without this the watchdog's timer outlives the test and the runner never exits.
    stop();
  });

  it("reads and writes the thread-title switch", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    assert.deepEqual(await client.getTitleSettings(), { enabled: true, modelId: null });
    assert.equal(world.calls.at(-1)?.url, "/api/title-settings");

    await client.setTitleSettings({ enabled: false, modelId: "m9" });
    const patch = world.calls.at(-1);
    assert.equal(patch?.url, "/api/title-settings");
    assert.equal(patch?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patch?.init?.body)), { enabled: false, modelId: "m9" });
  });

  it("reads and writes the sandbox switch", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    assert.deepEqual(await client.getSandboxSettings(), { disabled: false });
    assert.equal(world.calls.at(-1)?.url, "/api/sandbox-settings");

    await client.setSandboxSettings({ disabled: true });
    const patch = world.calls.at(-1);
    assert.equal(patch?.url, "/api/sandbox-settings");
    assert.equal(patch?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patch?.init?.body)), { disabled: true });
  });

  it("reads and writes the YOLO switch", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    assert.deepEqual(await client.getYoloSettings(), { enabled: false });
    assert.equal(world.calls.at(-1)?.url, "/api/yolo-settings");

    await client.setYoloSettings({ enabled: true });
    const patch = world.calls.at(-1);
    assert.equal(patch?.url, "/api/yolo-settings");
    assert.equal(patch?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patch?.init?.body)), { enabled: true });
  });

  it("asks for a model list by thread, by account, or for the default login's", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    await client.listModels();
    await client.listModels("s1");
    await client.listModels(undefined, "work");
    await client.listModels(undefined, null);
    await client.listModels("s 2", "a/b");
    assert.deepEqual(world.calls.map((entry) => entry.url), [
      "/api/models",
      "/api/models?sessionId=s1",
      "/api/models?accountId=work",
      "/api/models",
      "/api/models?sessionId=s%202&accountId=a%2Fb",
    ]);
  });

  it("reads a model list with what the host says about it", async () => {
    browser();
    const { WebAncillaClient } = await freshClient();
    const body = {
      models: { source: "bundledCatalog", providerId: "meta", profileId: "tbh", models: [{ modelId: "muse-wonder-1.0", variants: ["minimal", "max"] }] },
      hostVersion: "1.4.0",
    };
    const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const client = new WebAncillaClient();
      const catalog = await client.listModelCatalog(undefined, "work");
      assert.deepEqual(catalog.models.map((m) => [m.modelId, m.efforts]), [["muse-wonder-1.0", ["minimal", "max"]]]);
      assert.equal(catalog.source, "bundledCatalog");
      assert.equal(catalog.profileId, "tbh");
      assert.equal(catalog.hostVersion, "1.4.0");
      assert.deepEqual((await client.listModels()).map((m) => m.modelId), ["muse-wonder-1.0"], "the plain call still returns just the rows");
    } finally {
      fetcher.mock.restore();
    }
  });

  it("restarts Muse through the hosts route", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    await new WebAncillaClient().restartHosts();
    assert.equal(world.calls.at(-1)?.url, "/api/hosts/restart");
    assert.equal(world.calls.at(-1)?.init?.method, "POST");
  });

  it("sends the browser's time zone with a usage request, and none when it cannot say", async () => {
    const world = browser();
    const { WebAncillaClient } = await freshClient();
    const client = new WebAncillaClient();

    await client.usage(7);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.ok(zone, "the test machine has a zone");
    assert.equal(world.calls.at(-1)?.url, `/api/usage?days=7&tz=${encodeURIComponent(zone)}`);
    await client.usage();
    assert.equal(world.calls.at(-1)?.url, `/api/usage?tz=${encodeURIComponent(zone)}`);

    const broken = mock.method(Intl, "DateTimeFormat", () => {
      throw new Error("no Intl here");
    });
    try {
      await client.usage(30);
      assert.equal(world.calls.at(-1)?.url, "/api/usage?days=30");
      await client.usage();
      assert.equal(world.calls.at(-1)?.url, "/api/usage");
    } finally {
      broken.mock.restore();
    }
  });

  it("rebuilds a stream that has gone quiet", async () => {
    browser();
    const { WebAncillaClient } = await freshClient();
    mock.timers.enable({ apis: ["setTimeout"] });
    let stop = () => undefined as void;
    try {
      stop = new WebAncillaClient().subscribe(() => undefined);
      await Promise.resolve();
      assert.equal(FakeEventSource.made.length, 1, "one stream to begin with");

      // Two missed heartbeats: the server would have sent one every 25s.
      mock.timers.tick(70_001);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(FakeEventSource.made[0]?.closed, true, "the dead one is torn down");
      assert.equal(FakeEventSource.made.length, 2, "and another opened in its place");
    } finally {
      // The replacement stream schedules its own watchdog, which would outlive the test.
      stop();
      mock.timers.reset();
    }
  });
});
