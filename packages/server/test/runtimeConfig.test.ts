import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeConfigText, parseRuntimeConfig, readRuntimeConfig, wslSpawnEnv } from "../src/runtimeConfig.js";

const utf8 = (text: string) => Buffer.from(text, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe("runtime.json", () => {
  it("reads what Windows tools write: a byte order mark, or UTF-16 either way round", () => {
    const text = '{"distro":"Ubuntu"}';
    assert.equal(decodeConfigText(Buffer.concat([BOM, utf8(text)])), text);
    assert.equal(decodeConfigText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
    const bigEndian = Buffer.from(text, "utf16le");
    bigEndian.swap16();
    assert.equal(decodeConfigText(Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])), text);
    assert.equal(decodeConfigText(utf8(text)), text);
    assert.deepEqual(parseRuntimeConfig(Buffer.concat([BOM, utf8(text)])), { config: { distro: "Ubuntu", wslEnv: {} }, warnings: [] });
  });

  it("ignores a file that is not a JSON object, saying why", () => {
    const cases: [Buffer, RegExp][] = [
      [utf8("{not json"), /not valid JSON/],
      [utf8("null"), /holds null, not a JSON object/],
      [utf8('["wsl"]'), /holds a list/],
      [utf8('"wsl"'), /holds string/],
    ];
    for (const [bytes, reason] of cases) {
      const { config, warnings } = parseRuntimeConfig(bytes);
      assert.equal(config, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, reason);
    }
  });

  it("drops each unusable field on its own and keeps the rest", () => {
    const { config, warnings } = parseRuntimeConfig(utf8(JSON.stringify({
      runtime: 1,
      distro: " ",
      musePath: "/home/u/.local/bin/muse",
      syncSessionNames: "false",
      wslEnv: { TBH_CREDENTIAL_BACKEND: "file", https_proxy: "http://proxy:3128", "BAD-NAME": "x", PATH: "/nope", Wslenv: "x", COUNT: 3 },
    })));
    assert.equal(config?.syncSessionNames, undefined, 'the string "false" is neither true nor false');
    assert.deepEqual(config, { musePath: "/home/u/.local/bin/muse", wslEnv: { TBH_CREDENTIAL_BACKEND: "file", https_proxy: "http://proxy:3128" } });
    assert.deepEqual(warnings.map((warning) => warning.split(":")[0]), [
      '"runtime" was ignored',
      '"distro" was ignored',
      '"syncSessionNames" was ignored',
      'wslEnv "BAD-NAME" was ignored',
      'wslEnv "PATH" was ignored',
      'wslEnv "Wslenv" was ignored',
      'wslEnv "COUNT" was ignored',
    ]);
    const unknown = parseRuntimeConfig(utf8('{"runtime":"docker","syncSessionNames":true,"wslEnv":"BASH_ENV=/x"}'));
    assert.deepEqual(unknown.config, { syncSessionNames: true, wslEnv: {} });
    assert.deepEqual(unknown.warnings, [
      '"runtime" was ignored: "docker" is not native, wsl or auto',
      '"wslEnv" was ignored: it must be an object of names and values, not string',
    ]);
  });

  it("reads the file from disk, and starts from nothing when there is none or it cannot be used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-runtime-"));
    const file = join(dir, "runtime.json");
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    assert.deepEqual(readRuntimeConfig(file, warn), { wslEnv: {} });
    assert.deepEqual(warnings, [], "a missing file is the normal case");

    const utf16 = Buffer.from('{"runtime":"wsl","syncSessionNames":true,"wslEnv":{"A":"1","b-c":"2"}}', "utf16le");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]));
    assert.deepEqual(readRuntimeConfig(file, warn), { runtime: "wsl", syncSessionNames: true, wslEnv: { A: "1" } });
    assert.deepEqual(warnings, [`runtime.json (${file}): wslEnv "b-c" was ignored: it is not an environment variable name`]);

    warnings.length = 0;
    await writeFile(file, "\ufeffnot json");
    assert.deepEqual(readRuntimeConfig(file, warn), { wslEnv: {} });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^runtime\.json ignored \(.*runtime\.json\): it is not valid JSON/);
  });
});

describe("the environment for a process started through wsl.exe", () => {
  it("puts runtime.json's variables over the Windows ones, whatever their case, and names them in WSLENV", () => {
    const env = wslSpawnEnv(
      { Path: "C:\\Windows", TBH_CREDENTIAL_BACKEND: "keyring", tbh_credential_backend: "older", WSLENV: "USERPROFILE/p:BASH_ENV/l" },
      { TBH_CREDENTIAL_BACKEND: "file", BASH_ENV: "/home/u/env.sh" },
      ["XDG_CONFIG_HOME/pu"],
    );
    assert.equal(env["TBH_CREDENTIAL_BACKEND"], "file");
    assert.equal(env["tbh_credential_backend"], undefined, "no second spelling is left for Windows to pick between");
    assert.equal(env["Path"], "C:\\Windows");
    assert.equal(env["BASH_ENV"], "/home/u/env.sh");
    assert.equal(env["WSLENV"], "USERPROFILE/p:BASH_ENV/l:TBH_CREDENTIAL_BACKEND/u:XDG_CONFIG_HOME/pu", "an entry already named keeps its flags");
  });

  it("gives a forwarded entry the flags asked for, and one WSLENV whatever the base called it", () => {
    assert.equal(wslSpawnEnv({ WSLENV: "XDG_CONFIG_HOME/u" }, {}, ["XDG_CONFIG_HOME/pu", "XDG_DATA_HOME/pu"])["WSLENV"], "XDG_CONFIG_HOME/pu:XDG_DATA_HOME/pu");
    const env = wslSpawnEnv({ wslenv: "A/u" }, { B: "2" });
    assert.equal(env["wslenv"], undefined);
    assert.equal(env["WSLENV"], "A/u:B/u");
    assert.equal(wslSpawnEnv({}, {})["WSLENV"], "");
  });

  it("leaves the process's own environment alone", () => {
    const before = { ...process.env };
    wslSpawnEnv(process.env, { ANCILLA_TEST_ONLY: "1" }, ["ANCILLA_TEST_ONLY/u"]);
    assert.deepEqual({ ...process.env }, before);
  });
});

describe("ancilla-server start-up", () => {
  it("starts on a runtime.json it cannot fully use, reporting it on stderr and nothing else on stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-cli-"));
    await writeFile(join(dir, "runtime.json"), Buffer.concat([BOM, utf8('{"runtime":"wsl","syncSessionNames":"false","wslEnv":{"my-var":"x","TBH_CREDENTIAL_BACKEND":"file"}}')]));
    const child = spawn(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--port", "0", "--data-dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      const deadline = Date.now() + 20000;
      while (!stdout.includes("\n") && child.exitCode === null) {
        if (Date.now() > deadline) throw new Error(`no readiness line; stderr so far:\n${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(stdout.split("\n")[0]!, /^ancilla-server listening on http:\/\/127\.0\.0\.1:\d+$/, "the desktop handshake is the first line");
      assert.match(stderr, /runtime\.json \(.*runtime\.json\): "syncSessionNames" was ignored/);
      assert.match(stderr, /runtime\.json \(.*runtime\.json\): wslEnv "my-var" was ignored/);
      assert.doesNotMatch(stderr, /TBH_CREDENTIAL_BACKEND/, "the usable entry is kept without comment");
    } finally {
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
  });
});
