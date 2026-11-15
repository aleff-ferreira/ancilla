/**
 * The `!` commands of a server that stops. The server owns the commands it started whose answer is pending, and
 * `close()` stops exactly those: not a command of another server in the same process, and not the background process
 * of a command that already answered. Commands run through the real runner (a login shell, `SHELL` pointed at `sh`),
 * so these cases need a POSIX system and skip on Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_KILL_SETTLE_MS, SHELL_STOP_GRACE_MS } from "../src/runCapture.js";
import type { AncillaServer, HostHandle } from "../src/server.js";
import { FakeConnection, send, start } from "./harness.js";
import { isRunning, killQuietly } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell, process groups and signals" : false;

async function pidFrom(file: string, deadlineMs = 15_000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) return Number(text);
    } catch {
      /* not written yet */
    }
    if (Date.now() > until) throw new Error(`no pid in ${file}`);
    await sleep(20);
  }
}

async function gone(pid: number, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (isRunning(pid) && Date.now() < until) await sleep(25);
  assert.equal(isRunning(pid), false, what);
}

/** A running server with one thread in a folder of its own, and a way to run a `!` command in it. */
async function serverWithThread(dir: string, extra: Parameters<typeof start>[1] = {}) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { server, base } = await start(connection, extra);
  const created = await send(base, "/api/sessions", { cwd: dir });
  assert.equal(created.status, 200);
  const sessionId = created.json.session.sessionId as string;
  const shell = (command: string) =>
    send(base, `/api/sessions/${sessionId}/shell-proxy`, { command }).then(
      (reply) => reply.status,
      () => -1,
    );
  return { server: server as AncillaServer, shell };
}

/** Points the login shell the runner starts at `sh`, so the commands behave the same on every POSIX system. */
function withPlainShell(): () => void {
  const before = process.env["SHELL"];
  process.env["SHELL"] = "/bin/sh";
  return () => {
    if (before === undefined) delete process.env["SHELL"];
    else process.env["SHELL"] = before;
  };
}

describe("AncillaServer.close and the `!` commands", () => {
  it("stops a command whose answer is pending, and leaves another server's command running", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-shell-shutdown-"));
    const restore = withPlainShell();
    const pids: number[] = [];
    try {
      const first = await serverWithThread(dir);
      const second = await serverWithThread(dir);
      void first.shell(`echo $$ > "${join(dir, "first.pid")}"; exec sleep 60`);
      void second.shell(`echo $$ > "${join(dir, "second.pid")}"; exec sleep 60`);
      const firstPid = await pidFrom(join(dir, "first.pid"));
      const secondPid = await pidFrom(join(dir, "second.pid"));
      pids.push(firstPid, secondPid);

      await first.server.close();
      await gone(firstPid, "the command of a server that closed was left running");
      assert.equal(isRunning(secondPid), true, "closing one server stopped the command of another");

      await second.server.close();
      await gone(secondPid, "the second server's own close stops its own command");
    } finally {
      restore();
      for (const pid of pids) killQuietly(pid);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops its commands while a host is still closing, not after it", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-shell-shutdown-"));
    const restore = withPlainShell();
    let pid = 0;
    try {
      let hostClosed!: () => void;
      const hostClose = new Promise<void>((resolve) => (hostClosed = resolve));
      let closeCalls = 0;
      const connection = new FakeConnection();
      connection.replies.set("session/start", { session: { sessionId: "s1" } });
      const factory = (): HostHandle => ({
        start: async () => ({ initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } }),
        connection: connection as never,
        close: async () => {
          closeCalls += 1;
          await hostClose;
          return { code: 0, signal: null };
        },
        onExit: () => undefined,
      });
      const { server, base } = await start(connection, { hostFactory: factory, hostWaits: { closeMs: 60_000 } });
      const created = await send(base, "/api/sessions", { cwd: dir });
      const sessionId = created.json.session.sessionId as string;
      void send(base, `/api/sessions/${sessionId}/shell-proxy`, { command: `echo $$ > "${join(dir, "fg.pid")}"; exec sleep 60` }).catch(() => undefined);
      pid = await pidFrom(join(dir, "fg.pid"));

      const closing = server.close();
      await gone(pid, "the command was not stopped while a host was still closing");
      assert.equal(closeCalls, 1, "the host is still closing");
      hostClosed();
      await closing;
    } finally {
      restore();
      if (pid) killQuietly(pid);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not touch the background process of a command that already answered", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-shell-shutdown-"));
    const restore = withPlainShell();
    let background = 0;
    try {
      const { server, shell } = await serverWithThread(dir);
      const status = await shell(`sleep 60 & echo $! > "${join(dir, "bg.pid")}"`);
      background = await pidFrom(join(dir, "bg.pid"));
      assert.equal(status, 200, "the command answers as soon as it has exited");

      await server.close();
      await sleep(300);
      assert.equal(isRunning(background), true, "close() stopped a process that a finished command had left running");
    } finally {
      restore();
      if (background) killQuietly(background);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives a command that ignores the polite stop the wait it was configured with, hostWaits.shellsMs, before it kills it", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-shell-shutdown-"));
    const restore = withPlainShell();
    // The waits the close asks for, read off the timers it sets; an unusual number cannot be taken for another timer.
    const SHELLS_MS = 137;
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    let pid = 0;
    try {
      const { server } = await serverWithThread(dir, { hostWaits: { shellsMs: SHELLS_MS } });
      const shell = server["options"].shellRunner;
      void shell("sh", ["-c", `trap "" TERM; echo $$ > "${join(dir, "fg.pid")}"; while true; do sleep 1; done`]);
      pid = await pidFrom(join(dir, "fg.pid"));

      globalThis.setTimeout = ((handler: never, ms?: number, ...rest: never[]) => {
        delays.push(Number(ms));
        return realSetTimeout(handler, ms, ...rest);
      }) as typeof setTimeout;
      await server.close();
      globalThis.setTimeout = realSetTimeout;

      assert.ok(delays.includes(SHELLS_MS), `the close did not wait ${SHELLS_MS} ms for the commands; it set timers of ${[...new Set(delays)].join(", ")} ms`);
      // The number is the grace before the kill, not some other wait: it is set before the settle that follows the kill,
      // and the default grace is not waited for on top of it.
      assert.ok(
        delays.indexOf(SHELLS_MS) < delays.indexOf(SHELL_KILL_SETTLE_MS),
        `the ${SHELLS_MS} ms wait was not the grace before the kill, which the ${SHELL_KILL_SETTLE_MS} ms settle follows; the timers were ${delays.join(", ")} ms`,
      );
      assert.ok(!delays.includes(SHELL_STOP_GRACE_MS), `the close waited the default grace of ${SHELL_STOP_GRACE_MS} ms as well as the ${SHELLS_MS} ms it was configured with`);
      await gone(pid, "a command that ignores SIGTERM was left running by the close");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      restore();
      if (pid) killQuietly(pid);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts no command once it is closing", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-shell-shutdown-"));
    const restore = withPlainShell();
    try {
      const { server } = await serverWithThread(dir);
      const closed = server.close();
      // Through the runner itself: the route would already have answered 503.
      await assert.rejects(server["runInWorkspace"](dir, `echo $$ > "${join(dir, "late.pid")}"; exec sleep 60`), /shutting down/);
      await closed;
      await sleep(200);
      await assert.rejects(readFile(join(dir, "late.pid"), "utf8"), /ENOENT/, "a command was started after the server began to close");
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
