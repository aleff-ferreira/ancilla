// Ancilla Web Client Unit Test Suite
// Verifies HTTP/SSE communication, credential storage, daemon address resolution,
// settings negotiation, and event stream reconnect resilience.
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
/** Mock HTTP call record captured by simulated browser fetch. */
interface CapturedHttpRequest {
  readonly url: string;
  readonly init?: RequestInit;
}
/** Simulated EventSource connection recording listeners and termination state. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly registry = new Map<string, ((payload: unknown) => void)[]>();
  isClosed: boolean = false;

  public constructor(
    public readonly url: string,
    public readonly init?: { withCredentials?: boolean },
  ) {
    MockEventSource.instances.push(this);
  }

  public get closed(): boolean {
    return this.isClosed;
  }

  public addEventListener(eventName: string, callback: (payload: unknown) => void): void {
    const handlers = this.registry.get(eventName) ?? [];
    handlers.push(callback);
    this.registry.set(eventName, handlers);
  }

  public close(): void {
    this.isClosed = true;
  }
}
/** Sets up global browser environment mocks for window, localStorage, fetch and EventSource. */
function setupMockBrowser(config: { search?: string; stored?: Record<string, string> } = {}) {
  const store: Record<string, string> = { ...(config.stored ?? {}) };
  const routeReplacements: string[] = [];
  const interceptedCalls: CapturedHttpRequest[] = [];
  MockEventSource.instances = [];

  const mockLocalStorage = {
    getItem: (storageKey: string) => (storageKey in store ? (store[storageKey] as string) : null),
    setItem: (storageKey: string, storageValue: string) => {
      store[storageKey] = storageValue;
    },
  };
  const mockHistory = {
    replaceState: (_historyData: unknown, _historyTitle: string, destinationUrl: string) => {
      routeReplacements.push(destinationUrl);
    },
  };

  const hostContext = globalThis as Record<string, unknown>;
  hostContext["window"] = {
    localStorage: mockLocalStorage,
    location: {
      search: config.search ?? "",
      pathname: "/",
      hash: "",
    },
    history: mockHistory,
  };
  // Stub global fetch implementation
  hostContext["fetch"] = async (target: string, init?: RequestInit) => {
    interceptedCalls.push({ url: target, init });
    const responsePayload = JSON.stringify({ ok: true, projects: [] });
    return new Response(responsePayload, {
      status: 200 as const,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Register mock EventSource constructor
  hostContext["EventSource"] = MockEventSource;
  // Return test harness control handles
  return {
    storage: store,
    replaced: routeReplacements,
    calls: interceptedCalls,
  };
}
let importSequence = 0;
// Counter tracking dynamic import sequences
/** Loads a fresh webClient module instance to prevent cross-test state leakage. */
async function loadFreshWebClient() {
  importSequence += 1;
  return (await import(`../src/webClient.js?seq=${importSequence}`)) as typeof import("../src/webClient.js");
}
describe("web client transport suite", () => {
  it("authenticates Linux setup actions and scopes repair/cancellation without sending shell commands", async () => {
    const env = setupMockBrowser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await loadFreshWebClient();
    const client = new WebAncillaClient();

    await client.linuxSetup();
    await client.linuxSetup("work/profile");
    await client.installLinuxMuse();
    await client.cancelLinuxMuseInstall("attempt/a b");
    await client.repairLinuxStorage("work/profile");
    // Assert expected setup route endpoints were invoked
    assert.deepEqual(
      env.calls.map((c) => [c.init?.method, c.url]),
      [
        ["GET", "/api/setup/linux"],
        ["GET", "/api/setup/linux?accountId=work%2Fprofile"],
        ["POST", "/api/setup/linux/install"],
        ["DELETE", "/api/setup/linux/install?attemptId=attempt%2Fa%20b"],
        ["POST", "/api/setup/linux/repair"],
      ],
    );
    assert.equal(env.calls[2]?.init?.body, "{}");
    assert.equal(env.calls[4]?.init?.body, JSON.stringify({ accountId: "work/profile" }));
    for (const record of env.calls) {
      assert.equal((record.init?.headers as Record<string, string>)["authorization"], "Bearer secret");
    }
  });
  it("persists token retrieved from address bar query", async () => {
    const env = setupMockBrowser({ search: "?token=secret" });
    const { currentDaemon: resolveDaemon } = await loadFreshWebClient();
    // Validate stored token matches address bar param
    assert.equal(resolveDaemon().token, "secret");
    assert.deepEqual(JSON.parse(env.storage["ancilla:daemon"] as string), { base: "", token: "secret" });
    assert.deepEqual(env.replaced, ["/"]);
  });
  it("sends authentication token via header rather than path query", async () => {
    const env = setupMockBrowser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await loadFreshWebClient();
    // Dispatch query with configured auth token
    const client = new WebAncillaClient();
    await client.listProjects();
    const lastCall = env.calls.at(-1);
    assert.equal(lastCall?.url, "/api/projects");
    assert.match(String((lastCall?.init?.headers as Record<string, string>)["authorization"]), /^Bearer secret$/);
    assert.doesNotMatch(lastCall?.url ?? "", /token=/);
  });
  it("downloads report bytes from the selected daemon using header authentication", async () => {
    setupMockBrowser({ stored: { "ancilla:daemon": JSON.stringify({ base: "https://box.example:3127", token: "secret" }) } });
    const { WebAncillaClient } = await loadFreshWebClient();
    const payloadBytes = new Uint8Array([80, 75, 3, 4, 255]);

    const fetchInterceptor = mock.method(globalThis, "fetch", async (target: string | URL | Request, init?: RequestInit) => {
      assert.equal(target, "https://box.example:3127/api/research/run%2F1/export/report.docx");
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer secret");
      assert.equal(init?.credentials, "include");
      assert.ok(init?.signal);
      return new Response(payloadBytes, {
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      });
    });

    try {
      assert.deepEqual(await new WebAncillaClient().readResearchExport("run/1", "docx"), payloadBytes);
    } finally {
      fetchInterceptor.mock.restore();
    }
  });

  it("reports failed document downloads instead of saving the server error as a document", async () => {
    setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const fetchInterceptor = mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ error: "That export has not been generated yet." }), { status: 404 }),
    );

    try {
      await assert.rejects(new WebAncillaClient().readResearchExport("r1", "pdf"), /That export has not been generated yet/);
    } finally {
      fetchInterceptor.mock.restore();
    }
  });

  it("addresses remote daemon absolutely and includes credentials", async () => {
    const env = setupMockBrowser({
      stored: { ["ancilla:daemon"]: JSON.stringify({ base: "https://box.example:3127", token: "secret" }) },
    });
    const { WebAncillaClient } = await loadFreshWebClient();
    const webClient = new WebAncillaClient();
    // Dispatch call to remote host
    const projects = await webClient.listProjects();
    assert.ok(projects);
    assert.equal(env.calls.at(-1)?.url, "https://box.example:3127/api/projects");
    assert.equal(env.calls.at(-1)?.init?.credentials, "include");
    // Verify asset URL generation
    const assetUri = webClient.assetUrl("/api/attachments/abc");
    assert.equal(assetUri, "https://box.example:3127/api/attachments/abc");
    assert.doesNotMatch(assetUri, /secret/);
  });

  it("restores daemon connection from stored configuration", async () => {
    const env = setupMockBrowser({
      stored: { ["ancilla:daemon"]: JSON.stringify({ base: "https://box.example:3127", token: "secret" }) },
    });
    const { WebAncillaClient, currentDaemon: resolveDaemon } = await loadFreshWebClient();
    // Verify loaded daemon state
    assert.deepEqual(resolveDaemon(), { base: "https://box.example:3127", token: "secret" });
    const restoredClient = new WebAncillaClient();
    await restoredClient.listProjects();
    assert.equal(env.calls.at(-1)?.url, "https://box.example:3127/api/projects");
    assert.equal(env.storage["ancilla:daemon"], JSON.stringify({ base: "https://box.example:3127", token: "secret" }));
  });

  it("starts with default daemon when no configuration is stored", async () => {
    setupMockBrowser();
    const { currentDaemon: resolveDaemon } = await loadFreshWebClient();
    assert.deepEqual(resolveDaemon(), { base: "", token: null });
  });

  it("authenticates credentials before establishing SSE stream", async () => {
    const env = setupMockBrowser({ stored: { "ancilla:daemon": JSON.stringify({ base: "", token: "secret" }) } });
    const { WebAncillaClient } = await loadFreshWebClient();
    // Open stream subscription
    const teardown = new WebAncillaClient().subscribe(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Verify auth call preceded stream connection
    assert.equal(env.calls.at(0)?.url, "/api/auth");
    assert.equal(MockEventSource.instances.length, 1);
    assert.equal(MockEventSource.instances[0]?.url, "/api/events");
    teardown();
  });

  it("reads and toggles thread-title auto generation setting", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const titleClient = new WebAncillaClient();
    // Verify initial title setting
    const titleSettings = await titleClient.getTitleSettings();
    assert.deepEqual(titleSettings, { enabled: true, modelId: null });
    assert.equal(env.calls.at(-1)?.url, "/api/title-settings");
    // Modify title settings
    await titleClient.setTitleSettings({ enabled: false, modelId: "m9" as const });
    const patchReq = env.calls.at(-1);
    assert.equal(patchReq?.url, "/api/title-settings");
    assert.equal(patchReq?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patchReq?.init?.body)), { enabled: false, modelId: "m9" });
  });

  it("reads and toggles execution sandbox disabled setting", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const sandboxClient = new WebAncillaClient();
    // Verify initial sandbox status
    const sandboxSettings = await sandboxClient.getSandboxSettings();
    assert.deepEqual(sandboxSettings, { disabled: false });
    assert.equal(env.calls.at(-1)?.url, "/api/sandbox-settings");
    // Modify sandbox settings
    await sandboxClient.setSandboxSettings({ disabled: true as const });
    const patchReq = env.calls.at(-1);
    assert.equal(patchReq?.url, "/api/sandbox-settings");
    assert.equal(patchReq?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patchReq?.init?.body)), { disabled: true });
  });

  it("reads and toggles autonomous YOLO execution setting", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const yoloClient = new WebAncillaClient();
    // Verify initial YOLO setting
    const yoloSettings = await yoloClient.getYoloSettings();
    assert.deepEqual(yoloSettings, { enabled: false });
    assert.equal(env.calls.at(-1)?.url, "/api/yolo-settings");
    // Modify YOLO settings
    await yoloClient.setYoloSettings({ enabled: true as const });
    const patchReq = env.calls.at(-1);
    assert.equal(patchReq?.url, "/api/yolo-settings");
    assert.equal(patchReq?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patchReq?.init?.body)), { enabled: true });
  });
  it("asks for a model list by thread, by account, or for the default login's", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const client = new WebAncillaClient();

    await client.listModels();
    await client.listModels("s1");
    await client.listModels(undefined, "work");
    await client.listModels(undefined, null);
    await client.listModels("s 2", "a/b");
    assert.deepEqual(
      env.calls.map((c) => c.url),
      [
        "/api/models",
        "/api/models?sessionId=s1",
        "/api/models?accountId=work",
        "/api/models",
        "/api/models?sessionId=s%202&accountId=a%2Fb",
      ],
    );
  });

  it("reads a model list with what the host says about it", async () => {
    setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const mockCatalogPayload = {
      models: {
        source: "bundledCatalog",
        providerId: "meta",
        profileId: "tbh",
        models: [{ modelId: "muse-wonder-1.0", variants: ["minimal", "max"] }],
      },
      hostVersion: "1.4.0",
    };

    const fetchInterceptor = mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify(mockCatalogPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    try {
      const client = new WebAncillaClient();
      const catalog = await client.listModelCatalog(undefined, "work");
      assert.deepEqual(catalog.models.map((m) => [m.modelId, m.efforts]), [["muse-wonder-1.0", ["minimal", "max"]]]);
      assert.equal(catalog.source, "bundledCatalog");
      assert.equal(catalog.profileId, "tbh");
      assert.equal(catalog.hostVersion, "1.4.0");
      assert.deepEqual((await client.listModels()).map((m) => m.modelId), ["muse-wonder-1.0"]);
    } finally {
      fetchInterceptor.mock.restore();
    }
  });

  it("restarts Muse through the hosts route", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    await new WebAncillaClient().restartHosts();
    assert.equal(env.calls.at(-1)?.url, "/api/hosts/restart");
    assert.equal(env.calls.at(-1)?.init?.method, "POST");
  });

  it("sends the browser's time zone with a usage request, and none when it cannot say", async () => {
    const env = setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    const client = new WebAncillaClient();

    await client.usage(7);
    const tzZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.ok(tzZone);
    assert.equal(env.calls.at(-1)?.url, `/api/usage?days=7&tz=${encodeURIComponent(tzZone)}`);
    await client.usage();
    assert.equal(env.calls.at(-1)?.url, `/api/usage?tz=${encodeURIComponent(tzZone)}`);

    const faultyIntl = mock.method(Intl, "DateTimeFormat", () => {
      throw new Error("Intl unavailable");
    });
    try {
      await client.usage(30);
      assert.equal(env.calls.at(-1)?.url, "/api/usage?days=30");
      await client.usage();
      assert.equal(env.calls.at(-1)?.url, "/api/usage");
    } finally {
      faultyIntl.mock.restore();
    }
  });

  it("rebuilds inactive event stream after connection timeout", async () => {
    setupMockBrowser();
    const { WebAncillaClient } = await loadFreshWebClient();
    mock.timers.enable({ apis: ["setTimeout" as const] });
    let stopSubscription = () => undefined as void;
    try {
      stopSubscription = new WebAncillaClient().subscribe(() => undefined);
      await Promise.resolve();
      assert.equal(MockEventSource.instances.length, 1);
      // Advance virtual clock past quiet timeout threshold
      mock.timers.tick(70_000 + 1);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(MockEventSource.instances[0]?.closed, true);
      assert.equal(MockEventSource.instances.length, 2);
    } finally {
      stopSubscription();
      mock.timers.reset();
    }
  });
});
