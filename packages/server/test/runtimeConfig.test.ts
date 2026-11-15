// Unit and integration tests for runtime.json configuration and WSL bridging
import { describe as testGroup, it as unitTest } from "node:test";
import strictAssert from "node:assert/strict";
import { spawn as execProcess } from "node:child_process";
import * as fileSystem from "node:fs/promises";
import * as osContext from "node:os";
import * as pathUtils from "node:path";
import {
  decodeConfigText,
  parseRuntimeConfig,
  readRuntimeConfig,
  wslSpawnEnv,
} from "../src/runtimeConfig.js";
const toUtf8Buffer = (content: string) => Buffer.from(content, "utf8");
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
testGroup("runtime.json", () => {
  unitTest("reads what Windows tools write: a byte order mark, or UTF-16 either way round", () => {
    const rawJsonString = '{"distro":"Ubuntu"}';
    strictAssert.equal(decodeConfigText(Buffer.concat([UTF8_BOM_BYTES, toUtf8Buffer(rawJsonString)])), rawJsonString);
    strictAssert.equal(decodeConfigText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rawJsonString, "utf16le")])), rawJsonString);
    const bigEndianBuffer = Buffer.from(rawJsonString, "utf16le");
    bigEndianBuffer.swap16();
    strictAssert.equal(decodeConfigText(Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBuffer])), rawJsonString);
    strictAssert.equal(decodeConfigText(toUtf8Buffer(rawJsonString)), rawJsonString);
    strictAssert.deepEqual(parseRuntimeConfig(Buffer.concat([UTF8_BOM_BYTES, toUtf8Buffer(rawJsonString)])), {
      config: { distro: "Ubuntu", wslEnv: {} },
      warnings: [],
    });
  });
  unitTest("ignores a file that is not a JSON object, saying why", () => {
    const invalidJsonScenarios: [Buffer, RegExp][] = [
      [toUtf8Buffer("{not json"), /not valid JSON/],
      [toUtf8Buffer("null"), /holds null, not a JSON object/],
      [toUtf8Buffer('["wsl"]'), /holds a list/],
      [toUtf8Buffer('"wsl"'), /holds string/],
    ];
    for (const [testBytes, expectedPattern] of invalidJsonScenarios) {
      const { config: parsedResult, warnings: errorWarnings } = parseRuntimeConfig(testBytes);
      strictAssert.equal(parsedResult, null);
      strictAssert.equal(errorWarnings.length, 1);
      strictAssert.match(errorWarnings[0]!, expectedPattern);
    }
  });
  unitTest("drops each unusable field on its own and keeps the rest", () => {
    const mixedPayload = {
      runtime: 1,
      distro: " ",
      musePath: "/home/u/.local/bin/muse",
      syncSessionNames: "false",
      wslEnv: { TBH_CREDENTIAL_BACKEND: "file", https_proxy: "http://proxy:3128", "BAD-NAME": "x", PATH: "/nope", Wslenv: "x", COUNT: 3 },
    };
    const { config: cleanConfig, warnings: fieldWarnings } = parseRuntimeConfig(toUtf8Buffer(JSON.stringify(mixedPayload)));
    strictAssert.equal(cleanConfig?.syncSessionNames, undefined, 'the string "false" is neither true nor false');
    strictAssert.deepEqual(cleanConfig, { musePath: "/home/u/.local/bin/muse", wslEnv: { TBH_CREDENTIAL_BACKEND: "file", https_proxy: "http://proxy:3128" } });
    strictAssert.deepEqual(fieldWarnings.map((item) => item.split(":")[0]), [
      '"runtime" was ignored',
      '"distro" was ignored',
      '"syncSessionNames" was ignored',
      'wslEnv "BAD-NAME" was ignored',
      'wslEnv "PATH" was ignored',
      'wslEnv "Wslenv" was ignored',
      'wslEnv "COUNT" was ignored',
    ]);
    const unknownPayload = parseRuntimeConfig(toUtf8Buffer('{"runtime":"docker","syncSessionNames":true,"wslEnv":"BASH_ENV=/x"}'));
    strictAssert.deepEqual(unknownPayload.config, { syncSessionNames: true, wslEnv: {} });
    strictAssert.deepEqual(unknownPayload.warnings, [
      '"runtime" was ignored: "docker" is not native, wsl or auto',
      '"wslEnv" was ignored: it must be an object of names and values, not string',
    ]);
  });
  unitTest("reads dataDirLock as true or false only, like syncSessionNames", () => {
    strictAssert.deepEqual(parseRuntimeConfig(toUtf8Buffer('{"dataDirLock":false}')).config, { dataDirLock: false, wslEnv: {} });
    strictAssert.deepEqual(parseRuntimeConfig(toUtf8Buffer('{"dataDirLock":true}')).config, { dataDirLock: true, wslEnv: {} });
    const { config: invalidLockConfig, warnings: lockWarnings } = parseRuntimeConfig(toUtf8Buffer('{"dataDirLock":"off"}'));
    strictAssert.deepEqual(invalidLockConfig, { wslEnv: {} });
    strictAssert.deepEqual(lockWarnings, ['"dataDirLock" was ignored: it must be true or false, not string']);
  });
  unitTest("reads the file from disk, and starts from nothing when there is none or it cannot be used", async () => {
    const sandboxFolder = await fileSystem.mkdtemp(pathUtils.join(osContext.tmpdir(), "ancilla-runtime-"));
    const targetConfigFile = pathUtils.join(sandboxFolder, "runtime.json");
    const collectedWarnings: string[] = [];
    const recordWarning = (msg: string) => collectedWarnings.push(msg);
    strictAssert.deepEqual(readRuntimeConfig(targetConfigFile, recordWarning), { wslEnv: {} });
    strictAssert.deepEqual(collectedWarnings, [], "a missing file is the normal case");
    const utf16Encoded = Buffer.from('{"runtime":"wsl","syncSessionNames":true,"wslEnv":{"A":"1","b-c":"2"}}', "utf16le");
    await fileSystem.writeFile(targetConfigFile, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Encoded]));
    strictAssert.deepEqual(readRuntimeConfig(targetConfigFile, recordWarning), { runtime: "wsl", syncSessionNames: true, wslEnv: { A: "1" } });
    strictAssert.deepEqual(collectedWarnings, [`runtime.json (${targetConfigFile}): wslEnv "b-c" was ignored: it is not an environment variable name`]);
    collectedWarnings.length = 0;
    await fileSystem.writeFile(targetConfigFile, "\ufeffnot json");
    strictAssert.deepEqual(readRuntimeConfig(targetConfigFile, recordWarning), { wslEnv: {} });
    strictAssert.equal(collectedWarnings.length, 1);
    strictAssert.match(collectedWarnings[0]!, /^runtime\.json ignored \(.*runtime\.json\): it is not valid JSON/);
  });
});
testGroup("the environment for a process started through wsl.exe", () => {
  unitTest("puts runtime.json's variables over the Windows ones, whatever their case, and names them in WSLENV", () => {
    const sampleWindowsEnv = { Path: "C:\\Windows", TBH_CREDENTIAL_BACKEND: "keyring", tbh_credential_backend: "older", WSLENV: "USERPROFILE/p:BASH_ENV/l" };
    const sampleOverrideVars = { TBH_CREDENTIAL_BACKEND: "file", BASH_ENV: "/home/u/env.sh" };
    const sampleForwardFlags = ["XDG_CONFIG_HOME/pu"];
    const compositeEnv = wslSpawnEnv(sampleWindowsEnv, sampleOverrideVars, sampleForwardFlags);
    strictAssert.equal(compositeEnv["TBH_CREDENTIAL_BACKEND"], "file");
    strictAssert.equal(compositeEnv["tbh_credential_backend"], undefined, "no second spelling is left for Windows to pick between");
    strictAssert.equal(compositeEnv["Path"], "C:\\Windows");
    strictAssert.equal(compositeEnv["BASH_ENV"], "/home/u/env.sh");
    strictAssert.equal(compositeEnv["WSLENV"], "USERPROFILE/p:BASH_ENV/l:TBH_CREDENTIAL_BACKEND/u:XDG_CONFIG_HOME/pu", "an entry already named keeps its flags");
  });
  unitTest("gives a forwarded entry the flags asked for, and one WSLENV whatever the base called it", () => {
    strictAssert.equal(wslSpawnEnv({ WSLENV: "XDG_CONFIG_HOME/u" }, {}, ["XDG_CONFIG_HOME/pu", "XDG_DATA_HOME/pu"])["WSLENV"], "XDG_CONFIG_HOME/pu:XDG_DATA_HOME/pu");
    const casingTestEnv = wslSpawnEnv({ wslenv: "A/u" }, { B: "2" });
    strictAssert.equal(casingTestEnv["wslenv"], undefined);
    strictAssert.equal(casingTestEnv["WSLENV"], "A/u:B/u");
    strictAssert.equal(wslSpawnEnv({}, {})["WSLENV"], "");
  });
  unitTest("leaves the process's own environment alone", () => {
    const snapshotEnv = { ...process.env };
    const testVarOverride = { ANCILLA_TEST_ONLY: "1" };
    wslSpawnEnv(process.env, testVarOverride, ["ANCILLA_TEST_ONLY/u"]);
    strictAssert.deepEqual({ ...process.env }, snapshotEnv);
  });
});
testGroup("ancilla-server start-up", () => {
  unitTest("starts on a runtime.json it cannot fully use, reporting it on stderr and nothing else on stdout", { timeout: 300_000 }, async () => {
    const cliTestDir = await fileSystem.mkdtemp(pathUtils.join(osContext.tmpdir(), "ancilla-cli-"));
    const malformedConfig = Buffer.concat([UTF8_BOM_BYTES, toUtf8Buffer('{"runtime":"wsl","syncSessionNames":"false","wslEnv":{"my-var":"x","TBH_CREDENTIAL_BACKEND":"file"}}')]);
    await fileSystem.writeFile(pathUtils.join(cliTestDir, "runtime.json"), malformedConfig);
    const cliScriptPath = pathUtils.join(__dirname, "..", "src", "cli.js");
    const serverProcess = execProcess(process.execPath, [cliScriptPath, "--port", "0", "--data-dir", cliTestDir], { stdio: ["ignore", "pipe", "pipe"] });
    let capturedStdout = "";
    let capturedStderr = "";
    serverProcess.stderr.on("data", (chunk: Buffer) => { capturedStderr += chunk.toString(); });
    const processClosedPromise = new Promise<void>((done) => serverProcess.once("close", () => done()));
    const readyHandshakePromise = new Promise<void>((done, fail) => {
      serverProcess.stdout.on("data", (chunk: Buffer) => {
        capturedStdout += chunk.toString();
        if (capturedStdout.includes("\n")) done();
      });
      serverProcess.once("error", fail);
      serverProcess.once("close", (exitStatus) => fail(new Error(`the server exited (${exitStatus}) before its readiness line; stderr:\n${capturedStderr}`)));
    });
    try {
      await readyHandshakePromise;
    } finally {
      serverProcess.kill();
      const forceTerminationTimer = setTimeout(() => serverProcess.kill("SIGKILL"), 5000);
      await processClosedPromise;
      clearTimeout(forceTerminationTimer);
    }
    strictAssert.match(capturedStdout.split("\n")[0]!, /^ancilla-server listening on http:\/\/127\.0\.0\.1:\d+$/, "the desktop handshake is the first line");
    strictAssert.equal(capturedStdout.trim().split("\n").length, 1, "stdout carries nothing besides the handshake");
    strictAssert.match(capturedStderr, /runtime\.json \(.*runtime\.json\): "syncSessionNames" was ignored/);
    strictAssert.match(capturedStderr, /runtime\.json \(.*runtime\.json\): wslEnv "my-var" was ignored/);
    strictAssert.doesNotMatch(capturedStderr, /TBH_CREDENTIAL_BACKEND/, "the usable entry is kept without comment");
  });
});
