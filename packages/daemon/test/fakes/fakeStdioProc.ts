import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedStdioProcess } from "../../src/providers/jsonRpcStdio.js";

export interface FakeStdioHarness {
  proc: SpawnedStdioProcess;
  onClientLine: (handler: (line: string) => void) => void;
  sendLine: (frame: unknown) => void;
  sendStderr: (text: string) => void;
  exit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
}

export function createFakeStdioHarness(): FakeStdioHarness {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lineHandlers: ((line: string) => void)[] = [];
  let buffer = "";
  let exited = false;

  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) {
        for (const h of lineHandlers) {
          h(line);
        }
      }
      idx = buffer.indexOf("\n");
    }
  });

  const exit = (code: number | null = 0, signal: NodeJS.Signals | null = null): void => {
    if (exited) return;
    exited = true;
    stdout.end();
    stderr.end();
    emitter.emit("exit", code, signal);
  };

  const proc: SpawnedStdioProcess = {
    stdin,
    stdout,
    stderr,
    kill(sig?: NodeJS.Signals | number): boolean {
      const signalName = typeof sig === "string" ? sig : "SIGTERM";
      queueMicrotask(() => exit(null, signalName));
      return true;
    },
    on(event: "exit" | "error", listener: (...args: any[]) => void): SpawnedStdioProcess {
      emitter.on(event, listener);
      return proc;
    },
  };

  return {
    proc,
    onClientLine: (handler) => {
      lineHandlers.push(handler);
    },
    sendLine: (frame) => {
      if (!exited) {
        stdout.write(`${JSON.stringify(frame)}\n`, "utf8");
      }
    },
    sendStderr: (text) => {
      if (!exited) {
        stderr.write(text, "utf8");
      }
    },
    exit,
  };
}
