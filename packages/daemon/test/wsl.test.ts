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

const SAMPLE_WSL_LIST = `  NAME                   STATE           VERSION
* Ubuntu                 Running         2
  docker-desktop         Stopped         2
`;

describe("wsl paths", () => {
  it("translates Windows and WSL paths both ways", () => {
    assert.equal(toWslPath("D:\\work\\ancilla"), "/mnt/d/work/ancilla");
    assert.equal(toWslPath("C:/proj"), "/mnt/c/proj");
    assert.equal(toWindowsPath("/mnt/d/work/ancilla"), "D:\\work\\ancilla");
    assert.throws(() => toWslPath("relative/path"), /absolute Windows path/);
    assert.throws(() => toWindowsPath("/home/harjot"), /\/mnt\/<drive>/);
  });

  it("decodes UTF-16 WSL output", () => {
    const utf16 = Buffer.from(SAMPLE_WSL_LIST, "utf16le");
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    const distros = parseWslList(decodeCliOutput(withBom));
    assert.equal(distros.length, 2);
    assert.equal(distros[0]?.name, "Ubuntu");
    assert.equal(distros[0]?.isDefault, true);
    assert.equal(defaultDistro(distros)?.name, "Ubuntu");
  });
});

describe("host commands", () => {
  it("runs a program through wsl -e on Windows so arguments are not re-parsed by a shell", () => {
    assert.deepEqual(planHostCommand({ platform: "win32", distro: "Debian", program: "cat", args: ["/mnt/d/my project/a.md"] }), {
      command: "wsl",
      args: ["-d", "Debian", "-e", "cat", "/mnt/d/my project/a.md"],
    });
    assert.deepEqual(planHostCommand({ platform: "linux", program: "cat", args: ["a b"] }), { command: "cat", args: ["a b"] });
  });

  it("calls muse by its resolved path, or through a login shell that forwards the arguments", () => {
    assert.deepEqual(planMuseCli({ platform: "linux", musePath: "/usr/bin/muse", args: ["skills", "list"] }), {
      command: "/usr/bin/muse",
      args: ["skills", "list"],
    });
    assert.deepEqual(planMuseCli({ platform: "win32", args: ["skills", "list", "--workspace", "/mnt/d/a b"] }), {
      command: "wsl",
      args: ["-d", "Ubuntu", "-e", "sh", "-lc", 'exec muse "$@"', "muse", "skills", "list", "--workspace", "/mnt/d/a b"],
    });
  });
});

describe("serve planning", () => {
  it("routes Windows through WSL with a resolved binary when known", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
    });
    assert.deepEqual(direct, {
      command: "wsl",
      args: ["-d", "Ubuntu", "--", "/home/harjot/.local/bin/muse", "serve"],
      cwd: "D:\\work\\ancilla",
      viaWsl: true,
      distro: "Ubuntu",
    });
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\ancilla" });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve"]);
  });

  it("runs natively off Windows", () => {
    const native = planServe({ platform: "linux", cwd: "/work/proj" });
    assert.deepEqual(native, {
      command: "muse",
      args: ["serve"],
      cwd: "/work/proj",
      viaWsl: false,
      distro: null,
    });
  });

  it("adds --disable-sandbox when asked, on every route", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
      sandboxDisabled: true,
    });
    assert.deepEqual(direct.args, ["-d", "Ubuntu", "--", "/home/harjot/.local/bin/muse", "serve", "--disable-sandbox"]);
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\ancilla", sandboxDisabled: true });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox"]);
    const native = planServe({ platform: "linux", cwd: "/work/proj", sandboxDisabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox"]);
  });

  it("adds the YOLO flags when asked, on every route", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\ancilla",
      yoloEnabled: true,
    });
    assert.deepEqual(direct.args, [
      "-d",
      "Ubuntu",
      "--",
      "/home/harjot/.local/bin/muse",
      "serve",
      "--disable-sandbox",
      "--trust-workspace",
    ]);
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\ancilla", yoloEnabled: true });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox --trust-workspace"]);
    const native = planServe({ platform: "linux", cwd: "/work/proj", yoloEnabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });

  it("does not duplicate --disable-sandbox when both the sandbox switch and YOLO are on", () => {
    const native = planServe({ platform: "linux", cwd: "/work/proj", sandboxDisabled: true, yoloEnabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });
});

describe("environment probe", () => {
  it("finds muse inside the default distro", async () => {
    const exec: ExecFn = async (command, args) => {
      if (command === "wsl" && args[0] === "-l") {
        return { stdout: SAMPLE_WSL_LIST, exitCode: 0 };
      }
      assert.deepEqual(args.slice(0, 3), ["-d", "Ubuntu", "--"]);
      return { stdout: "/home/harjot/.local/bin/muse\n", exitCode: 0 };
    };
    const probe = await probeEnvironment(exec, "win32");
    assert.equal(probe.wslAvailable, true);
    assert.equal(probe.defaultDistro, "Ubuntu");
    assert.equal(probe.musePath, "/home/harjot/.local/bin/muse");
    assert.equal(await resolveMuseInDistro(exec, "Ubuntu"), "/home/harjot/.local/bin/muse");
  });

  it("reports missing WSL cleanly", async () => {
    const exec: ExecFn = async () => ({ stdout: "", exitCode: 1 });
    const probe = await probeEnvironment(exec, "win32");
    assert.equal(probe.wslAvailable, false);
    assert.equal(probe.musePath, null);
  });

  const TWO_DISTROS = `  NAME      STATE           VERSION
* Debian    Running         2
  Ubuntu    Running         2
`;

  /** A `wsl` that lists two distros, Debian the default, with muse on PATH in the distros named. */
  function wslWithMuse(museIn: string[], calls: string[][] = []): ExecFn {
    return async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "-l") {
        return { stdout: TWO_DISTROS, exitCode: 0 };
      }
      return museIn.includes(args[1] ?? "") ? { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
    };
  }

  it("looks for muse in Ubuntu before the default distro, and says which one it runs in", async () => {
    const calls: string[][] = [];
    const probe = await probeEnvironment(wslWithMuse(["Ubuntu"], calls), "win32", { preference: "wsl" });
    assert.equal(probe.defaultDistro, "Debian");
    assert.equal(probe.museDistro, "Ubuntu");
    assert.equal(probe.musePath, "/home/u/.local/bin/muse");
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu"]]);
  });

  it("falls back to the default distro when Ubuntu has no muse, and still names a distro when neither has", async () => {
    const calls: string[][] = [];
    const probe = await probeEnvironment(wslWithMuse(["Debian"], calls), "win32", { preference: "wsl" });
    assert.equal(probe.museDistro, "Debian");
    assert.equal(probe.musePath, "/home/u/.local/bin/muse");
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu"], ["wsl", "-d", "Debian"]]);
    const none = await probeEnvironment(wslWithMuse([]), "win32", { preference: "wsl" });
    assert.equal(none.musePath, null);
    assert.equal(none.museDistro, "Ubuntu", "where a host would be started, so the app can say so");
  });

  it("checks a pinned binary in the pinned distro, with the environment Muse will get, and looks nowhere else", async () => {
    const calls: string[][] = [];
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const exec: ExecFn = async (command, args, options) => {
      calls.push([command, ...args]);
      envs.push(options?.env);
      if (args[0] === "-l") {
        return { stdout: TWO_DISTROS, exitCode: 0 };
      }
      return { stdout: "", exitCode: args[1] === "Ubuntu-24.04" && args[5] === "/home/u/.local/bin/muse" ? 0 : 1 };
    };
    const env = { WSLENV: "BASH_ENV/u", BASH_ENV: "/home/u/env.sh" };
    const probe = await probeEnvironment(exec, "win32", { preference: "wsl", distro: "Ubuntu-24.04", musePath: "/home/u/.local/bin/muse", env });
    assert.equal(probe.museDistro, "Ubuntu-24.04");
    assert.equal(probe.musePath, "/home/u/.local/bin/muse");
    assert.equal(probe.defaultDistro, "Debian");
    assert.deepEqual(calls, [["wsl", "-l", "-v"], ["wsl", "-d", "Ubuntu-24.04", "-e", "test", "-x", "/home/u/.local/bin/muse"]]);
    assert.ok(envs.every((given) => given === env), "every call into WSL carries the environment");

    const missing = await probeEnvironment(exec, "win32", { preference: "wsl", distro: "Ubuntu-24.04", musePath: "/home/u/bin/muse" });
    assert.equal(missing.musePath, null, "a pinned binary that is not there is not replaced by a guess");
    assert.equal(missing.museDistro, "Ubuntu-24.04");
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
