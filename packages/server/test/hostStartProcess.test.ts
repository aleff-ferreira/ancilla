/**
 * The real host layer (the SDK's spawn, the default host factory) against a `muse` that starts and never answers:
 * the ceiling given to the server reaches the host, the request is answered 504, and the child is closed rather than
 * left running. POSIX only, since the stuck host is an executable script.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection, send, start } from "./harness.js";
import { FAKE_MUSE_SKIP, isRunning, killQuietly, writeFakeMuse } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

describe("the default host factory with a muse that never answers", () => {
  it("answers 504 at hostStartTimeoutMs and closes the child", { skip: FAKE_MUSE_SKIP, timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-host-process-"));
    const muse = await writeFakeMuse(join(dir, "bin"), { exitOnEof: true });
    const before = process.env["ANCILLA_FAKE_MUSE_PID"];
    process.env["ANCILLA_FAKE_MUSE_PID"] = muse.pidFile;
    let pid = 0;
    try {
      const { server, base } = await start(new FakeConnection(), { hostFactory: undefined, musePath: muse.path, hostStartTimeoutMs: 500 });
      const answered = await Promise.race([send(base, "/api/sessions", { cwd: dir }), sleep(30_000).then(() => null)]);
      assert.notEqual(answered, null, "the start never gave up");
      assert.equal(answered?.status, 504, JSON.stringify(answered?.json));
      assert.equal(server["starting"].size, 0);
      const written = Date.now() + 10_000;
      while (!pid && Date.now() < written) {
        pid = Number(await readFile(muse.pidFile, "utf8").then((text) => text.trim(), () => ""));
        if (!pid) await sleep(20);
      }
      assert.ok(pid > 0, "the stuck host did start");
      // The child is told to go (its input ends), and does; nothing here waits for it to be the server's answer.
      const until = Date.now() + 20_000;
      while (isRunning(pid) && Date.now() < until) {
        await sleep(25);
      }
      assert.equal(isRunning(pid), false, "the host that never answered is still running");
    } finally {
      if (pid) killQuietly(pid);
      if (before === undefined) {
        delete process.env["ANCILLA_FAKE_MUSE_PID"];
      } else {
        process.env["ANCILLA_FAKE_MUSE_PID"] = before;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
