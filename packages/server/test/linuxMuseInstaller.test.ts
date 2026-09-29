import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxMuseInstaller, installerLogin, type LinuxMuseInstallerOptions } from "../src/linuxMuseInstaller.js";

async function fixture(t: TestContext, extra: Partial<LinuxMuseInstallerOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ancilla-installer-test-"));
  const installer = new LinuxMuseInstaller({
    platform: "linux", home, env: {},
    fetch: async () => new Response("#!/usr/bin/env bash\nexit 0\n"),
    run: async () => { await installed(home); return 0; },
    ...extra,
  });
  t.after(async () => { await installer.close(); await rm(home, { recursive: true, force: true }); });
  return { home, installer };
}

async function installed(home: string) {
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "muse"), "#!/bin/sh\n", { mode: 0o755 });
}

async function finished(installer: LinuxMuseInstaller) {
  const deadline = Date.now() + 3000;
  while (installer.snapshot().status === "installing") {
    assert.ok(Date.now() < deadline, "installer should settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return installer.snapshot();
}

describe("guided Linux Muse installation", () => {
  it("downloads only the official script, fixes destination/env, and cleans up", async (t) => {
    let scriptPath = "";
    const { installer } = await fixture(t, {
      env: { PATH: "/usr/bin", MUSE_INSTALL_DIR: "/untrusted", MUSE_LAUNCHER_URL: "https://untrusted.invalid", BASH_ENV: "/untrusted.sh", ENV: "/untrusted.sh", MUSE_NO_AUTO_UPDATE: "1" },
      fetch: async (url, options) => {
        assert.equal(url, "https://dev.meta.ai/install.sh");
        assert.equal(options.redirect, "error");
        return new Response("#!/usr/bin/env bash\nexit 0\n");
      },
      run: async (script, options) => {
        scriptPath = script;
        assert.match(await readFile(script, "utf8"), /^#!.*bash/);
        assert.equal(options.env["HOME"], options.home);
        assert.equal(options.env["MUSE_INSTALL_DIR"], join(options.home, ".local", "bin"));
        assert.equal(options.env["MUSE_LAUNCHER_URL"], "https://api.meta.ai/muse-launcher.sh");
        assert.equal(options.env["MUSE_LOGIN"], "1");
        assert.equal(options.env["MUSE_UPGRADE_MODE"], "1");
        assert.equal(options.env["BASH_ENV"], undefined);
        assert.equal(options.env["ENV"], undefined);
        assert.equal(options.env["MUSE_NO_AUTO_UPDATE"], undefined);
        await installed(options.home);
        return 0;
      },
    });
    const first = await installer.start();
    assert.equal(first.status, "installing");
    assert.ok(first.attemptId);
    assert.equal((await finished(installer)).status, "installed");
    await installer.close();
    await assert.rejects(access(scriptPath), { code: "ENOENT" });
  });

  it("shares concurrent starts and exposes Meta approval without publishing raw output", async (t) => {
    let release!: () => void;
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
    let calls = 0;
    const { installer } = await fixture(t, { run: async (_script, options) => {
      calls += 1;
      options.onOutput("secret-access-token\nOpen https://auth.meta.com/device?user_code=ABCD-EFGH\n");
      runnerStarted();
      await new Promise<void>((resolve) => { release = resolve; });
      await installed(options.home);
      return 0;
    } });
    const [a, b] = await Promise.all([installer.start(), installer.start()]);
    assert.equal(a.attemptId, b.attemptId);
    await started;
    assert.equal(calls, 1);
    assert.equal(installer.snapshot().phase, "signin");
    assert.equal(installer.snapshot().loginCode, "ABCD-EFGH");
    assert.doesNotMatch(JSON.stringify(installer.snapshot()), /secret-access-token/);
    release();
    assert.equal((await finished(installer)).loginUrl, null);
  });

  it("cancels the exact attempt and a stale cancellation cannot stop a retry", async (t) => {
    const { installer } = await fixture(t, { run: async (_script, options) => new Promise<number>((resolve) => {
      options.signal.addEventListener("abort", () => resolve(143), { once: true });
      if (options.signal.aborted) resolve(143);
    }) });
    const first = await installer.start();
    assert.equal((await installer.cancel("another-attempt")).status, "installing");
    assert.equal((await installer.cancel(first.attemptId!)).status, "cancelled");
    const second = await installer.start();
    assert.notEqual(second.attemptId, first.attemptId);
    assert.equal((await installer.cancel(first.attemptId!)).status, "installing");
    assert.equal((await installer.cancel(second.attemptId!)).status, "cancelled");
  });

  it("stops descendants that ignore TERM after the installer leader exits", { skip: process.platform !== "linux" }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-installer-process-"));
    const installer = new LinuxMuseInstaller({
      platform: "linux", home, env: { PATH: "/usr/bin:/bin" },
      fetch: async () => new Response("#!/bin/bash\ntrap 'exit 143' TERM\nbash -c 'trap \"\" TERM; echo $$ > \"$HOME/child.pid\"; exec sleep 30' >/dev/null 2>&1 &\nwhile true; do sleep 1; done\n"),
    });
    let pid: number | null = null;
    t.after(async () => {
      await installer.close();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      await rm(home, { recursive: true, force: true });
    });
    const attempt = await installer.start();
    const deadline = Date.now() + 3000;
    while (!pid) {
      const raw = await readFile(join(home, "child.pid"), "utf8").catch(() => "");
      if (raw.trim()) pid = Number(raw.trim());
      else { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    assert.ok(Number.isInteger(pid) && pid > 0);
    await installer.cancel(attempt.attemptId!);
    // The container's init may reap later; a zombie has already stopped running.
    for (;;) {
      const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      if (!status || /\) Z /.test(status)) break;
      assert.ok(Date.now() < deadline, "cancel should stop the whole owned process group");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("can retry a download failure without retaining its error or login URL", async (t) => {
    let calls = 0;
    const { installer } = await fixture(t, { fetch: async () => {
      if (calls++ === 0) throw new Error("network credential=never-display");
      return new Response("#!/bin/bash\nexit 0\n");
    } });
    await installer.start();
    assert.equal((await finished(installer)).status, "error");
    assert.doesNotMatch(JSON.stringify(installer.snapshot()), /never-display/);
    await installer.start();
    assert.equal((await finished(installer)).status, "installed");
  });

  it("refuses an HTML download and an oversized script without running them", async (t) => {
    for (const content of ["<html>Unavailable</html>", "#!/bin/bash\n" + "x".repeat(1024 * 1024)]) {
      let ran = false;
      const { installer } = await fixture(t, {
        fetch: async () => new Response(content),
        run: async () => { ran = true; return 0; },
      });
      await installer.start();
      assert.equal((await finished(installer)).status, "error");
      assert.equal(ran, false);
    }
  });

  it("requires an executable launcher after a successful child exit", async (t) => {
    const { installer } = await fixture(t, { run: async () => 0 });
    await installer.start();
    assert.equal((await finished(installer)).status, "error");
  });

  it("times out an approval wait and terminates its runner", async (t) => {
    let aborted = false;
    const { installer } = await fixture(t, { timeoutMs: 20, run: async (_script, options) => new Promise<number>((resolve) => {
      options.signal.addEventListener("abort", () => { aborted = true; resolve(143); }, { once: true });
    }) });
    await installer.start();
    assert.match((await finished(installer)).message, /timed out/);
    assert.equal(aborted, true);
  });

  it("rejects non-Linux invocation and cannot restart after shutdown", async (t) => {
    const { installer } = await fixture(t, { platform: "darwin" });
    await assert.rejects(installer.start(), /available on Linux/);
    const other = await fixture(t);
    await other.installer.close();
    await assert.rejects(other.installer.start(), /shutting down/);
  });

  it("keeps snapshots immutable and replaces cryptic dependency errors with next steps", async (t) => {
    const { installer } = await fixture(t, { run: async (_script, options) => {
      options.onOutput("muse: required command not found: curl\n");
      return 1;
    } });
    const snapshot = installer.snapshot();
    snapshot.message = "changed";
    assert.notEqual(installer.snapshot().message, snapshot.message);
    await installer.start();
    assert.match((await finished(installer)).message, /\.deb or \.rpm/);
  });
});

describe("installer authorization links", () => {
  it("allows Meta HTTPS device codes and refuses lookalike or credential-bearing hosts", () => {
    assert.deepEqual(installerLogin("Open https://auth.meta.com/device?user_code=ABCD-EFGH\n"), { url: "https://auth.meta.com/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" });
    for (const host of ["auth.meta.com.evil.invalid", "evil.invalid", "user@auth.meta.com", "auth.meta.com:444"]) {
      assert.equal(installerLogin(`https://${host}/device?user_code=ABCD-EFGH`), null);
    }
    assert.equal(installerLogin("http://auth.meta.com/device?user_code=ABCD-EFGH"), null);
  });
});
