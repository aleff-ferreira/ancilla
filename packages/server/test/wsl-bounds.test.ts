import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "@ancilla/daemon";
import { FakeConnection, start } from "./harness.js";

/** Lets the promise chains behind a fired timer run; no clock is waited on. */
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const WSL = { platform: "win32", runtime: "wsl", distro: "Ubuntu", musePath: "/home/u/.local/bin/muse" } as const;

/**
 * The bounds a stopped distro is held to, as the server wires them when nothing shortens them. The other tests give
 * their own bounds; these two are the only ones that see what production uses, and they read it off the timers the
 * server sets, so a wrong default or a constant wired to the wrong place fails here at once and no test waits for it.
 */
describe("the bounds a stopped distro is held to, as production wires them", () => {
  it("gives up on a look at the login after exactly six seconds", async () => {
    const { server } = await start(new FakeConnection(), { ...WSL });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let answer = "pending";
      void server["wslUnit"]("read", () => new Promise<string>(() => {}), () => "gave up").then((value) => { answer = value; });
      mock.timers.tick(5999); await settle();
      assert.equal(answer, "pending", "still waiting at 5999 ms");
      mock.timers.tick(1); await settle();
      assert.equal(answer, "gave up", "given up on at 6000 ms");
    } finally { mock.timers.reset(); }
  });

  it("gives up on a wsl.exe that never answers after five seconds, and does not ask again for thirty", async () => {
    let asked = 0;
    const exec: ExecFn = async (_command, args) => {
      if (!args.includes('printf %s "$HOME"')) return { stdout: "", exitCode: 127 };
      asked++;
      return new Promise<never>(() => {});
    };
    const { server } = await start(new FakeConnection(), { ...WSL, exec });
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    try {
      const homes = server["wslHomes"];
      let first: string | null | "pending" = "pending";
      void homes.get("Ubuntu").then((value) => { first = value; });
      mock.timers.tick(4999); await settle();
      assert.equal(first, "pending", "still waiting at 4999 ms");
      mock.timers.tick(1); await settle();
      assert.equal(first, null, "given up on at 5000 ms");
      assert.equal(asked, 1);

      mock.timers.tick(29_999); await settle();
      let second: string | null | "pending" = "pending";
      void homes.get("Ubuntu").then((value) => { second = value; });
      await settle();
      assert.equal(second, null, "29999 ms after the failure it answers from the failure on record");
      assert.equal(asked, 1, "and does not ask wsl.exe again");

      mock.timers.tick(1);
      void homes.get("Ubuntu"); await settle();
      assert.equal(asked, 2, "30000 ms after the failure it asks again");
    } finally { mock.timers.reset(); }
  });
});
