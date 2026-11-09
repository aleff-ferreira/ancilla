import { PassThrough } from "node:stream";
import type { BrowserProcess } from "../src/browser/launch.js";

/** A scripted browser on the other end of the CDP pipe: parses NUL-framed requests, answers through `handle`. */
export type Handler = (method: string, params: Record<string, any>, sessionId: string | undefined) => unknown;

export interface FakeBrowser {
  proc: BrowserProcess;
  calls: Array<{ method: string; params: Record<string, any>; sessionId?: string }>;
  emit(method: string, params: Record<string, any>, sessionId?: string): void;
  exit(code?: number): void;
  killed: () => number;
  /** Raw bytes into the CDP pipe, to test framing. */
  raw(chunk: Buffer): void;
}

export function fakeBrowser(handle: Handler, options: { exitsOnClose?: boolean } = {}): FakeBrowser {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const calls: FakeBrowser["calls"] = [];
  let exited = false;
  let kills = 0;
  let resolveExit: (code: number | null) => void = () => undefined;
  const done = new Promise<number | null>((resolve) => (resolveExit = resolve));
  const send = (message: unknown) => fromBrowser.write(`${JSON.stringify(message)}\0`);
  const exit = (code = 0) => {
    if (exited) return;
    exited = true;
    fromBrowser.end();
    resolveExit(code);
  };
  let buffer = "";
  toBrowser.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nul: number;
    while ((nul = buffer.indexOf("\0")) >= 0) {
      const text = buffer.slice(0, nul);
      buffer = buffer.slice(nul + 1);
      const message = JSON.parse(text);
      calls.push({ method: message.method, params: message.params, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
      setImmediate(() => {
        if (exited) return;
        try {
          const result = handle(message.method, message.params ?? {}, message.sessionId);
          send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: result ?? {} });
          if (message.method === "Browser.close" && options.exitsOnClose) exit(0);
        } catch (error) {
          send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      });
    }
  });
  const proc: BrowserProcess = {
    pid: 4242,
    toBrowser,
    fromBrowser,
    exited: done,
    hasExited: () => exited,
    killTree: async () => {
      kills += 1;
      exit(null as unknown as number);
    },
  };
  return {
    proc,
    calls,
    emit: (method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) }),
    exit,
    killed: () => kills,
    raw: (chunk) => void fromBrowser.write(chunk),
  };
}

/** The usual answers of a healthy browser with one blank page; `extra` overrides or adds. */
export function healthy(extra: Handler = () => undefined): Handler {
  let targets = 0;
  return (method, params, sessionId) => {
    const custom = extra(method, params, sessionId);
    if (custom !== undefined) return custom;
    switch (method) {
      case "Browser.getVersion":
        return { product: "HeadlessChrome/157.0.1.2" };
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "T0", type: "page", url: "about:blank", title: "" }] };
      case "Target.attachToTarget":
        return { sessionId: `S-${params["targetId"]}` };
      case "Target.createTarget":
        targets += 1;
        return { targetId: `T${targets}` };
      case "Target.createBrowserContext":
        return { browserContextId: "CTX-A" };
      case "Page.navigate":
        return { loaderId: "L1" };
      default:
        return {};
    }
  };
}
