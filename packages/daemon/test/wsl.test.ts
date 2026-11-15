import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCliOutput,
  defaultDistro,
  defaultExec,
  parseWslList,
  planHostCommand,
  planMuseCli,
  planServe,
  probeEnvironment,
  resolveMuseInDistro,
  toWindowsPath,
  toWslPath,
  type ExecFn,
} from "../src/wsl.js";

const RAW_WSL_LIST_FIXTURE = `  NAME                   STATE           VERSION
* Ubuntu                 Running         2
  docker-desktop         Stopped         2
`;

describe("WSL path translation and decoding", () => {
  it("converts bidirectional path strings between Windows drive format and WSL mount format", () => {
    assert.strictEqual(toWslPath("D:\\work\\ancilla"), "/mnt/d/work/ancilla");
    assert.strictEqual(toWslPath("C:/proj"), "/mnt/c/proj");
    assert.strictEqual(toWindowsPath("/mnt/d/work/ancilla"), "D:\\work\\ancilla");
    assert.throws(() => toWslPath("relative/path"), { message: /absolute Windows path/ });
    assert.throws(() => toWindowsPath("/home/user"), { message: /\/mnt\/<drive>/ });
  });

  it("properly decodes UTF-16 LE byte streams from WSL commands", () => {
    const rawUtf16 = Buffer.from(RAW_WSL_LIST_FIXTURE, "utf16le");
    const bufferWithBom = Buffer.concat([Buffer.from([0xff, 0xfe]), rawUtf16]);
    const parsed = parseWslList(decodeCliOutput(bufferWithBom));
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0]?.name, "Ubuntu");
    assert.strictEqual(parsed[0]?.isDefault, true);
    assert.strictEqual(defaultDistro(parsed)?.name, "Ubuntu");
  });
});

describe("host command assembly", () => {
  it("executes binaries via wsl -e on Windows without shell word splitting", () => {
    const plannedWin = planHostCommand({
      platform: "win32",
      distro: "Debian",
      program: "cat",
      args: ["/mnt/d/my project/a.md"],
    });
    assert.deepStrictEqual(plannedWin, {
      command: "wsl",
      args: ["-d", "Debian", "-e", "cat", "/mnt/d/my project/a.md"],
    });

    const plannedLinux = planHostCommand({
      platform: "linux",
      program: "cat",
      args: ["a b"],
    });
    assert.deepStrictEqual(plannedLinux, {
      command: "cat",
      args: ["a b"],
    });
  });

  it("resolves muse directly or through an interactive login wrapper", () => {
    const directPlan = planMuseCli({
      platform: "linux",
      musePath: "/usr/bin/muse",
      args: ["skills", "list"],
    });
    assert.deepStrictEqual(directPlan, {
      command: "/usr/bin/muse",
      args: ["skills", "list"],
    });

    const shellForwardedPlan = planMuseCli({
      platform: "win32",
      args: ["skills", "list", "--workspace", "/mnt/d/a b"],
    });
    assert.deepStrictEqual(shellForwardedPlan, {
      command: "wsl",
      args: ["-d", "Ubuntu", "-e", "sh", "-lc", 'exec muse "$@"', "muse", "skills", "list", "--workspace", "/mnt/d/a b"],
    });
  });
});

describe("serve command generation", () => {
  it("targets WSL when running on Windows with a known executable location", () => {
    const directInvocation = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/user/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
    });
    assert.deepStrictEqual(directInvocation, {
      command: "wsl",
      args: ["-d", "Ubuntu", "--", "/home/user/.local/bin/muse", "serve"],
      cwd: "D:\\work\\ancilla",
      viaWsl: true,
      distro: "Ubuntu",
    });

    const loginFallback = planServe({
      platform: "win32",
      cwd: "D:\\work\\ancilla",
    });
    assert.deepStrictEqual(loginFallback.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve"]);
  });

  it("dispatches natively when running on non-Windows systems", () => {
    const posixExecution = planServe({
      platform: "linux",
      cwd: "/work/proj",
    });
    assert.deepStrictEqual(posixExecution, {
      command: "muse",
      args: ["serve"],
      cwd: "/work/proj",
      viaWsl: false,
      distro: null,
    });
  });

  it("includes --disable-sandbox across all runtime routes when requested", () => {
    const directTarget = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/user/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
      sandboxDisabled: true,
    });
    assert.deepStrictEqual(directTarget.args, ["-d", "Ubuntu", "--", "/home/user/.local/bin/muse", "serve", "--disable-sandbox"]);

    const loginTarget = planServe({
      platform: "win32",
      cwd: "D:\\work\\ancilla",
      sandboxDisabled: true,
    });
    assert.deepStrictEqual(loginTarget.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox"]);

    const nativeTarget = planServe({
      platform: "linux",
      cwd: "/work/proj",
      sandboxDisabled: true,
    });
    assert.deepStrictEqual(nativeTarget.args, ["serve", "--disable-sandbox"]);
  });

  it("applies YOLO operational arguments when configured", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/user/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
      yoloEnabled: true,
    });
    assert.deepStrictEqual(direct.args, [
      "-d",
      "Ubuntu",
      "--",
      "/home/user/.local/bin/muse",
      "serve",
      "--disable-sandbox",
      "--trust-workspace",
    ]);

    const loginShell = planServe({
      platform: "win32",
      cwd: "D:\\work\\ancilla",
      yoloEnabled: true,
    });
    assert.deepStrictEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox --trust-workspace"]);

    const native = planServe({
      platform: "linux",
      cwd: "/work/proj",
      yoloEnabled: true,
    });
    assert.deepStrictEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });

  it("avoids redundant sandbox arguments when YOLO is also enabled", () => {
    const native = planServe({
      platform: "linux",
      cwd: "/work/proj",
      sandboxDisabled: true,
      yoloEnabled: true,
    });
    assert.deepStrictEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });

  it("preserves JSON extraServeArgs via wsl -e or single-quoted sh -lc", () => {
    const extraServeArgs = [
      "--preset",
      "empty",
      "-c",
      'runtime_capabilities={"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false}}',
    ];
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/user/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
      extraServeArgs,
    });
    assert.deepEqual(direct.args, ["-d", "Ubuntu", "-e", "/home/user/.local/bin/muse", "serve", ...extraServeArgs]);

    const loginShell = planServe({ platform: "win32", distro: "Ubuntu", cwd: "D:\\work\\ancilla", extraServeArgs });
    assert.deepEqual(loginShell.args, [
      "-d",
      "Ubuntu",
      "--",
      "sh",
      "-lc",
      `muse serve --preset empty -c 'runtime_capabilities={"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false}}'`,
    ]);
  });
});

describe("WSL and native environment discovery", () => {
  it("detects the muse binary within the primary WSL distribution", async () => {
    const exec: ExecFn = async (command, args) => {
      if (command === "wsl" && args[0] === "-l") {
        return { stdout: RAW_WSL_LIST_FIXTURE, exitCode: 0 };
      }
      assert.deepStrictEqual(args.slice(0, 3), ["-d", "Ubuntu", "--"]);
      return { stdout: "/home/user/.local/bin/muse\n", exitCode: 0 };
    };
    const probe = await probeEnvironment(exec, "win32");
    assert.strictEqual(probe.wslAvailable, true);
    assert.strictEqual(probe.defaultDistro, "Ubuntu");
    assert.strictEqual(probe.musePath, "/home/user/.local/bin/muse");
    assert.strictEqual(await resolveMuseInDistro(exec, "Ubuntu"), "/home/user/.local/bin/muse");
  });

  it("fails gracefully when WSL subsystem is not installed", async () => {
    const exec: ExecFn = async () => ({ stdout: "", exitCode: 1 });
    const probe = await probeEnvironment(exec, "win32");
    assert.strictEqual(probe.wslAvailable, false);
    assert.strictEqual(probe.musePath, null);
  });

  const TWO_DISTROS_FIXTURE = `  NAME      STATE           VERSION
* Debian    Running         2
  Ubuntu    Running         2
`;

  /** A `wsl` runner listing two distros, Debian the default, with muse on PATH in the distros named. */
  function createWslRunnerWithMuse(targetDistros: string[], invocationLog: string[][] = []): ExecFn {
    return async (command, args) => {
      invocationLog.push([command, ...args]);
      if (args[0] === "-l") {
        return { stdout: TWO_DISTROS_FIXTURE, exitCode: 0 };
      }
      return targetDistros.includes(args[1] ?? "")
        ? { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 }
        : { stdout: "", exitCode: 1 };
    };
  }

  it("prefers Ubuntu prior to the system default distribution", async () => {
    const log: string[][] = [];
    const probe = await probeEnvironment(createWslRunnerWithMuse(["Ubuntu"], log), "win32", { preference: "wsl" });
    assert.strictEqual(probe.defaultDistro, "Debian");
    assert.strictEqual(probe.museDistro, "Ubuntu");
    assert.strictEqual(probe.musePath, "/home/u/.local/bin/muse");
    assert.deepStrictEqual(log.map((call) => call.slice(0, 3)), [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu"]]);
  });

  it("falls back to default distribution when absent from Ubuntu", async () => {
    const log: string[][] = [];
    const probe = await probeEnvironment(createWslRunnerWithMuse(["Debian"], log), "win32", { preference: "wsl" });
    assert.strictEqual(probe.museDistro, "Debian");
    assert.strictEqual(probe.musePath, "/home/u/.local/bin/muse");
    assert.deepStrictEqual(log.map((call) => call.slice(0, 3)), [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu"], ["wsl", "-d", "Debian"]]);

    const absentProbe = await probeEnvironment(createWslRunnerWithMuse([]), "win32", { preference: "wsl" });
    assert.strictEqual(absentProbe.musePath, null);
    assert.strictEqual(absentProbe.museDistro, "Ubuntu", "where a host would be started, so the app can say so");
  });

  it("validates pinned binary locations without searching alternative distributions", async () => {
    const log: string[][] = [];
    const observedEnvironments: (NodeJS.ProcessEnv | undefined)[] = [];
    const exec: ExecFn = async (command, args, options) => {
      log.push([command, ...args]);
      observedEnvironments.push(options?.env);
      if (args[0] === "-l") {
        return { stdout: TWO_DISTROS_FIXTURE, exitCode: 0 };
      }
      return { stdout: "", exitCode: args[1] === "Ubuntu-24.04" && args[5] === "/home/u/.local/bin/muse" ? 0 : 1 };
    };
    const customEnv = { WSLENV: "BASH_ENV/u", BASH_ENV: "/home/u/env.sh" };
    const probe = await probeEnvironment(exec, "win32", {
      preference: "wsl",
      distro: "Ubuntu-24.04",
      musePath: "/home/u/.local/bin/muse",
      env: customEnv,
    });
    assert.strictEqual(probe.museDistro, "Ubuntu-24.04");
    assert.strictEqual(probe.musePath, "/home/u/.local/bin/muse");
    assert.strictEqual(probe.defaultDistro, "Debian");
    assert.deepStrictEqual(log, [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu-24.04", "-e", "test", "-x", "/home/u/.local/bin/muse"]]);
    assert.ok(observedEnvironments.every((given) => given === customEnv), "every call into WSL carries the environment");

    const missingProbe = await probeEnvironment(exec, "win32", {
      preference: "wsl",
      distro: "Ubuntu-24.04",
      musePath: "/home/u/bin/muse",
    });
    assert.strictEqual(missingProbe.musePath, null, "a pinned binary that is not there is not replaced by a guess");
    assert.strictEqual(missingProbe.museDistro, "Ubuntu-24.04");
  });
});

describe("defaultExec", () => {
  it("captures stdout and stderr and reports the exit code", async () => {
    const ok = await defaultExec(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err');"]);
    assert.deepEqual(ok, { stdout: "out", stderr: "err", exitCode: 0 });
    const failed = await defaultExec(process.execPath, ["-e", "process.stderr.write('401 unauthorized'); process.exit(3);"]);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.stderr, "401 unauthorized");
    assert.equal(failed.timedOut, undefined);
    assert.equal(failed.aborted, undefined);
  });

  it("kills a child that outlives timeoutMs and says so", async () => {
    const result = await defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, undefined);
  });

  it("kills a child when the signal fires and flags the result aborted", async () => {
    const controller = new AbortController();
    const pending = defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal, timeoutMs: 10000 });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, undefined);
  });
});
