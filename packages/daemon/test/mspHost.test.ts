import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANCILLA_CLIENT_NAME,
  AncillaMspHost,
  classifyServeExit,
  serveExitMessage,
} from "../src/mspHost.js";

interface FakeRpcConnection {
  executedCommands: Array<{ name: string; payload: unknown }>;
  eventListeners: Array<(evt: { method: string }) => void>;
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (evt: { method: string }) => void): void;
}

function buildFakeRpcConnection(): FakeRpcConnection {
  return {
    executedCommands: [],
    eventListeners: [],
    async command(name, payload) {
      this.executedCommands.push({ name, payload });
      return { ok: true };
    },
    onNotification(listener) {
      this.eventListeners.push(listener);
    },
  };
}

interface FakeHostConfig {
  syntheticWarning?: unknown;
}

function makeFakeHostLauncher(rpc: FakeRpcConnection, config?: FakeHostConfig) {
  const capturedHandshakes: Array<{ name: string; version: string }> = [];

  const launcher = ((_opts: unknown) => ({
    initialize: async (params: { clientInfo: { name: string; version: string } }) => {
      capturedHandshakes.push({
        name: params.clientInfo.name,
        version: params.clientInfo.version,
      });

      return {
        initializeResult: { hostStatus: "active" },
        fingerprintWarning: config?.syntheticWarning ?? null,
        connection: rpc,
        close: async () => ({ code: 0, signal: null }),
      };
    },
  }) as unknown) as ConstructorParameters<typeof AncillaMspHost>[1];

  return { launcher, capturedHandshakes };
}

describe("classifyServeExit status code interpretation", () => {
  it("maps process exit codes to their expected semantic classes", () => {
    assert.strictEqual(classifyServeExit(0), "clean");
    assert.strictEqual(classifyServeExit(5), "sdk-tier-off");
    assert.strictEqual(classifyServeExit(null), "signalled");
    assert.strictEqual(classifyServeExit(1), "error");
    assert.strictEqual(classifyServeExit(137), "error");

    assert.ok(serveExitMessage("clean").includes("cleanly"));
    assert.ok(serveExitMessage("sdk-tier-off").includes("experimental SDK tier"));
    assert.ok(serveExitMessage("signalled").includes("signal"));
    assert.ok(serveExitMessage("error").includes("error"));
  });
});

describe("AncillaMspHost lifecycle supervision", () => {
  it("supplies the ANCILLA_CLIENT_NAME identifier and propagates fingerprint notices", async () => {
    const rpc = buildFakeRpcConnection();
    const { launcher, capturedHandshakes } = makeFakeHostLauncher(rpc, {
      syntheticWarning: { detail: "unrecognized binary signature" },
    });

    const hostInstance = new AncillaMspHost(
      { command: "muse", args: ["serve"], cwd: "/test-work-dir" },
      launcher,
    );

    const startupResult = await hostInstance.start("1.0.0-rc");
    assert.strictEqual(capturedHandshakes.length, 1);
    assert.strictEqual(capturedHandshakes[0]?.name, ANCILLA_CLIENT_NAME);
    assert.strictEqual(capturedHandshakes[0]?.version, "1.0.0-rc");
    assert.deepStrictEqual(startupResult.fingerprintWarning, { detail: "unrecognized binary signature" });
  });

  it("enforces start prerequisites prior to connection usage and closes gracefully", async () => {
    const rpc = buildFakeRpcConnection();
    const { launcher } = makeFakeHostLauncher(rpc);

    const supervisor = new AncillaMspHost(
      { command: "muse", args: ["serve"], cwd: "/test-work-dir" },
      launcher,
    );

    assert.throws(() => supervisor.connection, { message: /start\(\)/ });
    await assert.rejects(() => supervisor.close(), { message: /start\(\)/ });

    await supervisor.start("1.0.0-rc");
    assert.ok(supervisor.connection);

    const exitOutcome = await supervisor.close();
    assert.deepStrictEqual(exitOutcome, { code: 0, signal: null });
  });
});
