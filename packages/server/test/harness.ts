/**
 * The small server test harness: a scripted MSP connection, a host factory that hands it out, and HTTP helpers.
 * A copy of what `server.test.ts` declares privately, for the suites that live in other files.
 */
import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AncillaServer, type HostExit, type HostHandle } from "../src/server.js";
import type { ServeTarget } from "@ancilla/daemon";

export interface Call {
  method: string;
  params?: Record<string, unknown>;
}

export type Reply = unknown | ((params: Record<string, unknown>) => unknown);

export class FakeConnection {
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

  /** The calls of one method, oldest first. */
  of(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export interface FactoryProbe {
  targets: ServeTarget[];
  exits: ((exit: HostExit) => void)[];
}

export function fakeFactory(connection: FakeConnection, probe?: FactoryProbe): (target: ServeTarget) => HostHandle {
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

export async function start(connection: FakeConnection, extra: Partial<ConstructorParameters<typeof AncillaServer>[0]> = {}) {
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

export async function send(
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

export async function get(base: string, path: string): Promise<any> {
  return (await fetch(`${base}${path}`)).json();
}

export async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
export async function sseEvents(base: string, type: string, drive: () => Promise<void>, settleMs = 150): Promise<any[]> {
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
  await new Promise((r) => setTimeout(r, settleMs));
  stop = true;
  await reader.cancel().catch(() => undefined);
  await pump.catch(() => undefined);
  return payloads;
}
