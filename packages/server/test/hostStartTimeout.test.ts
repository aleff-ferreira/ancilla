/**
 * Where the host start ceiling comes from: the option, ANCILLA_HOST_START_TIMEOUT_MS, runtime.json, else five
 * minutes; 0 turns it off; a value that is not whole milliseconds is ignored with one line on stderr.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_START_TIMEOUT_MS } from "@ancilla/daemon";
import { HOST_START_TIMEOUT_ENV, parseHostStartTimeoutMs, resolveHostStartTimeoutMs } from "../src/hostBounds.js";
import { parseRuntimeConfig } from "../src/runtimeConfig.js";
import { FakeConnection, start } from "./harness.js";

const config = (value: unknown) => parseRuntimeConfig(Buffer.from(JSON.stringify({ hostStartTimeoutMs: value })));

describe("parseHostStartTimeoutMs", () => {
  it("takes whole milliseconds as a number or as digits, and 0", () => {
    assert.equal(parseHostStartTimeoutMs(300_000), 300_000);
    assert.equal(parseHostStartTimeoutMs("45000"), 45_000);
    assert.equal(parseHostStartTimeoutMs(" 45000 "), 45_000);
    assert.equal(parseHostStartTimeoutMs(0), 0);
    assert.equal(parseHostStartTimeoutMs("0"), 0);
    assert.equal(parseHostStartTimeoutMs(2_147_483_647), 2_147_483_647);
  });

  it("refuses anything else, which would otherwise become an instant or an endless timer", () => {
    for (const bad of [-1, 1.5, "1.5", "-5", "1e4", "0x10", "soon", "", "  ", null, undefined, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "99999999999"]) {
      assert.equal(parseHostStartTimeoutMs(bad), null, JSON.stringify(bad) ?? String(bad));
    }
  });
});

describe("resolveHostStartTimeoutMs", () => {
  const run = (input: { option?: number; env?: string; file?: number }) => {
    const lines: string[] = [];
    return { ms: resolveHostStartTimeoutMs({ ...input, warn: (line) => lines.push(line) }), lines };
  };

  it("is five minutes when nothing says otherwise", () => {
    assert.equal(DEFAULT_HOST_START_TIMEOUT_MS, 300_000);
    assert.deepEqual(run({}), { ms: 300_000, lines: [] });
    assert.deepEqual(run({ env: "" }), { ms: 300_000, lines: [] });
    assert.deepEqual(run({ env: "   " }), { ms: 300_000, lines: [] });
  });

  it("prefers the option, then the environment, then the file", () => {
    assert.equal(run({ option: 10_000, env: "20000", file: 30_000 }).ms, 10_000);
    assert.equal(run({ env: "20000", file: 30_000 }).ms, 20_000);
    assert.equal(run({ file: 30_000 }).ms, 30_000);
  });

  it("lets 0 turn the ceiling off at every level", () => {
    assert.equal(run({ option: 0, env: "20000" }).ms, 0);
    assert.equal(run({ env: "0", file: 30_000 }).ms, 0);
    assert.equal(run({ file: 0 }).ms, 0);
  });

  it("ignores a nonsense environment value with one line naming it, as if it were not set", () => {
    const withFile = run({ env: "soon", file: 30_000 });
    assert.equal(withFile.ms, 30_000);
    assert.equal(withFile.lines.length, 1);
    assert.ok(withFile.lines[0]!.includes(HOST_START_TIMEOUT_ENV));
    assert.ok(withFile.lines[0]!.includes("soon"));
    const alone = run({ env: "-5" });
    assert.equal(alone.ms, 300_000, "nothing else says otherwise, so the default stands");
    assert.equal(alone.lines.length, 1);
  });

  it("ignores a nonsense option with one line, and then reads the rest as if it were not given", () => {
    const { ms, lines } = run({ option: -5, env: "20000" });
    assert.equal(ms, 20_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /hostStartTimeoutMs/);
  });
});

describe("runtime.json's hostStartTimeoutMs", () => {
  it("is read as whole milliseconds, or digits, or 0", () => {
    assert.equal(config(90_000).config?.hostStartTimeoutMs, 90_000);
    assert.equal(config("90000").config?.hostStartTimeoutMs, 90_000);
    assert.equal(config(0).config?.hostStartTimeoutMs, 0);
    assert.deepEqual(config(90_000).warnings, []);
  });

  it("is ignored on its own when it is not, with a line saying so, and the rest of the file is kept", () => {
    for (const bad of [-1, 1.5, "soon", true, null, [], {}]) {
      const parsed = parseRuntimeConfig(Buffer.from(JSON.stringify({ hostStartTimeoutMs: bad, distro: "Ubuntu" })));
      assert.equal(parsed.config?.hostStartTimeoutMs, undefined, JSON.stringify(bad));
      assert.equal(parsed.config?.distro, "Ubuntu");
      assert.equal(parsed.warnings.length, 1, JSON.stringify(bad));
      assert.match(parsed.warnings[0]!, /"hostStartTimeoutMs" was ignored/);
    }
  });
});

describe("the server", () => {
  async function startWith(env: string | undefined, option: number | undefined) {
    const before = process.env[HOST_START_TIMEOUT_ENV];
    if (env === undefined) {
      delete process.env[HOST_START_TIMEOUT_ENV];
    } else {
      process.env[HOST_START_TIMEOUT_ENV] = env;
    }
    try {
      return await start(new FakeConnection(), option === undefined ? {} : { hostStartTimeoutMs: option });
    } finally {
      if (before === undefined) {
        delete process.env[HOST_START_TIMEOUT_ENV];
      } else {
        process.env[HOST_START_TIMEOUT_ENV] = before;
      }
    }
  }

  it("takes the ceiling from the option, else the environment, else five minutes", async () => {
    assert.equal((await startWith(undefined, undefined)).server["hostStartTimeoutMs"], 300_000);
    assert.equal((await startWith("45000", undefined)).server["hostStartTimeoutMs"], 45_000);
    assert.equal((await startWith("45000", 9000)).server["hostStartTimeoutMs"], 9000);
    assert.equal((await startWith("0", undefined)).server["hostStartTimeoutMs"], 0);
  });
});
