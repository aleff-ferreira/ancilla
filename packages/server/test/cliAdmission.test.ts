/**
 * The real `ancilla-server` process and its front door: flags that must not silently turn auth off, the refusal to
 * listen on the network without a token, --allow-host and runtime.json's allowHosts, the one deprecation line, and a
 * closed stdout pipe. How long a process takes to start is the machine's business, so every wait here is for an event
 * (the readiness line, an exit, an answer) and the timeouts only keep a hung child from hanging the suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawRequest } from "./harness.js";

const CLI = join(__dirname, "..", "src", "cli.js");
const LONG = { timeout: 300_000 };

interface Running {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the exit code once the process and its pipes are closed. */
  exited: Promise<number | null>;
  hasExited: () => boolean;
  /** Resolves with the readiness line, or rejects if the process ends without printing one. */
  handshake: () => Promise<string>;
  stop: () => Promise<void>;
}

function startCli(args: string[]): Running {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let done = false;
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => { done = true; resolve(code); }));
  const handshake = () =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        if (out.includes("\n")) resolve(out.split("\n")[0]!);
      };
      check();
      child.stdout!.on("data", check);
      void exited.then((code) => reject(new Error(`the server exited (${code}) before its readiness line; stderr:\n${err}`)));
    });
  const stop = async () => {
    if (!done) {
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
  };
  return { child, stdout: () => out, stderr: () => err, exited, hasExited: () => done, handshake, stop };
}

/** Waits for a process that must not start: if it prints its readiness line it is stopped and the test fails. */
async function mustNotStart(run: Running, what: string): Promise<void> {
  const first = await Promise.race([
    run.exited.then(() => "exited" as const),
    run.handshake().then(() => "started" as const, () => "exited" as const),
  ]);
  if (first === "started") {
    await run.stop();
    assert.fail(`${what} started a server: ${run.stdout()}`);
  }
  assert.notEqual(await run.exited, 0, `${what} must exit with an error`);
}

function portFrom(line: string): string {
  const port = /:(\d+)$/.exec(line)?.[1];
  assert.ok(port, `a port in ${line}`);
  return port;
}

describe("ancilla-server flags", () => {
  it("does not read --token with no value as no token", LONG, async () => {
    for (const args of [["--token", ""], ["--token"], ["--token", "--port", "0"]]) {
      const run = startCli(["--data-dir", ":memory:", "--port", "0", ...args]);
      await mustNotStart(run, JSON.stringify(args));
      assert.match(run.stderr(), /--token/, JSON.stringify(args));
      assert.equal(run.stdout(), "", "no readiness line");
    }
  });

  it("does not read --allow-host with no usable value as nothing", LONG, async () => {
    for (const args of [["--allow-host"], ["--allow-host", ""], ["--allow-host", "*"], ["--allow-host", "--port", "0"]]) {
      const run = startCli(["--data-dir", ":memory:", "--port", "0", ...args]);
      await mustNotStart(run, JSON.stringify(args));
      assert.match(run.stderr(), /--allow-host/, JSON.stringify(args));
      assert.equal(run.stdout(), "");
    }
  });

  it("does not ignore a flag written as --name=value, which would start the server without what it was told", LONG, async () => {
    const secret = "abc-not-for-the-log";
    const forms: [string, string][] = [
      [`--token=${secret}`, "--token"],
      ["--allow-host=proxy.example", "--allow-host"],
      ["--allow-origin=https://ancilla.example", "--allow-origin"],
      ["--host=127.0.0.1", "--host"],
      ["--port=0", "--port"],
      ["--data-dir=:memory:", "--data-dir"],
      ["--static=dist", "--static"],
      ["--distro=Ubuntu", "--distro"],
      ["--runtime=native", "--runtime"],
      ["--muse=muse", "--muse"],
    ];
    for (const [arg, flag] of forms) {
      const run = startCli(["--data-dir", ":memory:", "--port", "0", arg]);
      await mustNotStart(run, arg.startsWith("--token") ? "--token=<value>" : arg);
      assert.match(run.stderr(), new RegExp(`use ${flag} <value>`), arg);
      assert.doesNotMatch(run.stderr(), new RegExp(secret), "the value is not echoed: it may be the token");
      assert.equal(run.stdout(), "", "no readiness line");
    }
  });

  it("tells a non-ASCII --allow-host name to be given in its xn-- form", LONG, async () => {
    const run = startCli(["--data-dir", ":memory:", "--port", "0", "--allow-host", "bücher.example"]);
    await mustNotStart(run, "an internationalised --allow-host");
    assert.match(run.stderr(), /--allow-host/);
    assert.match(run.stderr(), /xn--/);
    assert.match(run.stderr(), /punycode/);
    const plain = startCli(["--data-dir", ":memory:", "--port", "0", "--allow-host", "*"]);
    await mustNotStart(plain, "a wildcard --allow-host");
    assert.doesNotMatch(plain.stderr(), /xn--/, "the hint is only for names that are not ASCII");
  });

  it("refuses to listen beyond this machine without a token, naming --token", LONG, async () => {
    const run = startCli(["--data-dir", ":memory:", "--port", "0", "--host", "0.0.0.0"]);
    await mustNotStart(run, "--host 0.0.0.0 without a token");
    assert.match(run.stderr(), /--token/);
    assert.equal(run.stdout(), "", "no readiness line for a server that is not listening");
  });

  it("describes --token as what it is: a credential every request must carry", async () => {
    const run = startCli(["--help"]);
    assert.equal(await run.exited, 0);
    assert.doesNotMatch(run.stdout(), /non-loopback access/);
    assert.match(run.stdout(), /--token <value>\s+require this token on every request/);
    assert.match(run.stdout(), /--allow-host <name>/);
  });
});

describe("ancilla-server without a token", () => {
  it("says once, on stderr only, that a token will be needed later", LONG, async () => {
    const tokenless = startCli(["--data-dir", ":memory:", "--port", "0"]);
    try {
      assert.match(await tokenless.handshake(), /^ancilla-server listening on http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await tokenless.stop();
    }
    assert.equal(tokenless.stderr().split("will need a token in a later release").length - 1, 1);
    assert.match(tokenless.stderr(), /desktop app.*(need|nothing)/i, "the desktop app cannot pass a token yet, and its users are told they need do nothing");
    assert.equal(tokenless.stdout().trim().split("\n").length, 1, "stdout carries nothing besides the handshake");

    const withToken = startCli(["--data-dir", ":memory:", "--port", "0", "--token", "a-token-of-some-length"]);
    try {
      await withToken.handshake();
    } finally {
      await withToken.stop();
    }
    assert.doesNotMatch(withToken.stderr(), /later release/);
    assert.doesNotMatch(withToken.stderr(), /a-token-of-some-length/, "the token is never logged");
  });
});

describe("ancilla-server --allow-host and runtime.json", () => {
  it("answers a host named with --allow-host and refuses the rest", LONG, async () => {
    const run = startCli(["--data-dir", ":memory:", "--port", "0", "--allow-host", "Proxy.Example", "--allow-host", "https://second.example:8443"]);
    try {
      const base = `http://127.0.0.1:${portFrom(await run.handshake())}`;
      assert.equal((await rawRequest(base, "/api/health", { headers: { host: "proxy.example" } })).status, 200);
      assert.equal((await rawRequest(base, "/api/health", { headers: { host: "second.example" } })).status, 200);
      assert.equal((await rawRequest(base, "/api/health")).status, 200);
      const refused = await rawRequest(base, "/api/health", { headers: { host: "evil.example" } });
      assert.equal(refused.status, 403);
      assert.equal(refused.json.kind, "host");
    } finally {
      await run.stop();
    }
  });

  it("reads allowHosts from runtime.json, keeping the usable entries and saying why it dropped one", LONG, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-allowhosts-"));
    await writeFile(join(dir, "runtime.json"), JSON.stringify({ allowHosts: ["tunnel.example", "*"] }));
    const run = startCli(["--data-dir", dir, "--port", "0"]);
    try {
      const base = `http://127.0.0.1:${portFrom(await run.handshake())}`;
      assert.equal((await rawRequest(base, "/api/health", { headers: { host: "tunnel.example:443" } })).status, 200);
      assert.equal((await rawRequest(base, "/api/health", { headers: { host: "evil.example" } })).status, 403);
    } finally {
      await run.stop();
    }
    assert.match(run.stderr(), /runtime\.json \(.*runtime\.json\): "allowHosts" entry "\*" was ignored/);
  });
});

describe("ancilla-server stdout", () => {
  // The desktop shell reads the first line and drops its end of the pipe. Whatever is written to stdout after that
  // meets a closed pipe, which must not take the server down with it.
  it("keeps serving when the reader of its stdout is gone", LONG, async () => {
    // Port 0, so nothing else can take the port between choosing it and binding it. The stdout line that names it is
    // the one that must meet a closed pipe, so the port is read from the notice on stderr, which names the same address.
    const run = startCli(["--data-dir", ":memory:", "--port", "0"]);
    run.child.stdout!.destroy();
    const port = await new Promise<string>((resolve, reject) => {
      const check = () => {
        const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stderr());
        if (found) resolve(found[1]!);
      };
      check();
      run.child.stderr!.on("data", check);
      void run.exited.then((code) => reject(new Error(`the server exited (${code}) before it named its port; stderr:\n${run.stderr()}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      if (run.hasExited()) {
        assert.fail(`the server exited (${await run.exited}) when its stdout was closed; stderr:\n${run.stderr()}`);
      }
      const answered = await rawRequest(base, "/api/health").then(
        (reply) => reply.status === 200,
        () => false,
      );
      if (answered) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      assert.equal(run.hasExited(), false);
    } finally {
      await run.stop();
    }
  });
});
