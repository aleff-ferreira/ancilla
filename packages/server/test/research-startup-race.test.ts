/**
 * `raceStartup`: the bound on everything a research turn waits for before its own deadlines begin. Time moves only
 * when the fake clock is advanced, so a timer left armed is visible as a timer in the list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESEARCH_STARTUP_MS,
  MIN_RESEARCH_STARTUP_ENV_MS,
  WSL_RESEARCH_STARTUP_MS,
  gaveUpOnTimeout,
  raceStartup,
  researchStartupAllowanceMs,
  startupEnvMs,
} from "../src/research/startup.js";
import { FakeClock, sleep } from "./research-rigs.js";

/** A promise a test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("raceStartup", () => {
  it("hands back the value of a start that finishes in time, and leaves no timer or listener behind", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const pending = deferred<string>();
    const raced = raceStartup(() => pending.promise, { signal: controller.signal, clock, timeoutMs: 120_000 });
    assert.equal(clock.timers.length, 1, "the allowance is armed while the start is pending");
    pending.resolve("session");
    assert.deepEqual(await raced, { kind: "started", value: "session" });
    assert.equal(clock.timers.length, 0);
    controller.abort();
    await sleep(5);
  });

  it("reports a start that failed, with its error", async () => {
    const clock = new FakeClock();
    const error = new Error("Could not start Muse");
    const result = await raceStartup(() => Promise.reject(error), { signal: new AbortController().signal, clock, timeoutMs: 1000 });
    assert.deepEqual(result, { kind: "failed", error });
    assert.equal(clock.timers.length, 0);
    const thrown = await raceStartup(() => {
      throw new Error("synchronous");
    }, { signal: new AbortController().signal, clock, timeoutMs: 1000 });
    assert.equal(thrown.kind, "failed");
  });

  it("settles as aborted the moment the signal fires, however long the start would take", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    let giveUp: AbortSignal | null = null;
    const raced = raceStartup(
      (signal) => {
        giveUp = signal;
        return new Promise<string>(() => undefined);
      },
      { signal: controller.signal, clock, timeoutMs: 120_000 },
    );
    assert.equal(giveUp!.aborted, false);
    controller.abort();
    assert.deepEqual(await raced, { kind: "aborted" });
    assert.equal(clock.timers.length, 0, "the allowance timer is cleared");
    assert.equal(giveUp!.aborted, true, "the start is told it was given up on");
  });

  it("tells the start why it was given up on: only a passed allowance reads as a wedge, a stop does not", async () => {
    const never = (store: { signal: AbortSignal | null }) => (signal: AbortSignal) => {
      store.signal = signal;
      return new Promise<string>(() => undefined);
    };
    const clock = new FakeClock();
    const timedOut = { signal: null as AbortSignal | null };
    const waiting = raceStartup(never(timedOut), { signal: new AbortController().signal, clock, timeoutMs: 10 });
    assert.equal(gaveUpOnTimeout(timedOut.signal!), false, "nothing yet while the start is awaited");
    clock.advance(10);
    assert.equal((await waiting).kind, "timed_out");
    assert.equal(timedOut.signal!.aborted, true);
    assert.equal(gaveUpOnTimeout(timedOut.signal!), true);

    const stopped = { signal: null as AbortSignal | null };
    const controller = new AbortController();
    const stopping = raceStartup(never(stopped), { signal: controller.signal, clock: new FakeClock(), timeoutMs: 10 });
    controller.abort();
    assert.equal((await stopping).kind, "aborted");
    assert.equal(stopped.signal!.aborted, true, "the start is still told nobody waits for it");
    assert.equal(gaveUpOnTimeout(stopped.signal!), false, "a user stop is not the host failing to answer");

    assert.equal(gaveUpOnTimeout(new AbortController().signal), false);
    const foreign = new AbortController();
    foreign.abort(new Error("something else"));
    assert.equal(gaveUpOnTimeout(foreign.signal), false);
  });

  it("does not start anything for a signal that has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const result = await raceStartup(() => {
      called += 1;
      return Promise.resolve("never");
    }, { signal: controller.signal, clock: new FakeClock(), timeoutMs: 1000 });
    assert.deepEqual(result, { kind: "aborted" });
    assert.equal(called, 0);
  });

  it("times out on the injected clock, with a timer armed until then and none after", async () => {
    const clock = new FakeClock();
    let giveUp: AbortSignal | null = null;
    const raced = raceStartup(
      (signal) => {
        giveUp = signal;
        return new Promise<string>(() => undefined);
      },
      { signal: new AbortController().signal, clock, timeoutMs: 120_000 },
    );
    assert.equal(clock.timers.length, 1);
    clock.advance(119_999);
    assert.equal(clock.timers.length, 1, "not yet");
    clock.advance(1);
    assert.deepEqual(await raced, { kind: "timed_out", ms: 120_000 });
    assert.equal(clock.timers.length, 0);
    assert.equal(giveUp!.aborted, true);
  });

  it("swallows a rejection that arrives after the race was lost", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const clock = new FakeClock();
      const pending = deferred<string>();
      const raced = raceStartup(() => pending.promise, { signal: new AbortController().signal, clock, timeoutMs: 10 });
      clock.advance(10);
      assert.equal((await raced).kind, "timed_out");
      pending.reject(new Error("late failure"));
      await sleep(30);
      assert.deepEqual(seen, []);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("tells the caller about a value that arrives after the race was lost", async () => {
    const clock = new FakeClock();
    const pending = deferred<string>();
    const late: string[] = [];
    const raced = raceStartup(() => pending.promise, { signal: new AbortController().signal, clock, timeoutMs: 10, onLate: (value) => late.push(value) });
    clock.advance(10);
    await raced;
    pending.resolve("straggler");
    await sleep(10);
    assert.deepEqual(late, ["straggler"]);
  });

  it("does not report a value that was delivered in time as late", async () => {
    const late: string[] = [];
    const result = await raceStartup(() => Promise.resolve("ok"), { signal: new AbortController().signal, clock: new FakeClock(), timeoutMs: 10, onLate: (value) => late.push(value) });
    assert.equal(result.kind, "started");
    await sleep(5);
    assert.deepEqual(late, []);
  });
});

describe("the startup allowance", () => {
  it("is two minutes, and three on Windows with Muse in WSL", () => {
    assert.equal(DEFAULT_RESEARCH_STARTUP_MS, 120_000);
    assert.equal(WSL_RESEARCH_STARTUP_MS, 180_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "darwin", runtime: "posix" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "win32", runtime: "native" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "win32", runtime: "wsl" }), 180_000);
    assert.equal(
      researchStartupAllowanceMs({ platform: "win32", runtime: null }),
      180_000,
      "Windows with the runtime not settled yet is the cold first start, where Muse is most likely in a distro that has to wake up",
    );
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: null }), 120_000, "an unknown runtime off Windows takes the default");
  });

  it("reads a value from the environment only as plain decimal milliseconds of at least a second", () => {
    assert.equal(MIN_RESEARCH_STARTUP_ENV_MS, 1000);
    assert.equal(startupEnvMs("1000"), 1000);
    assert.equal(startupEnvMs(" 45000 "), 45_000, "surrounding blanks are fine");
    for (const bad of ["999", "30", "5", "0", "-5", "soon", "", "   ", "0x2710", "1e4", "45000.5", "45 000", "1_000"]) {
      assert.equal(startupEnvMs(bad), null, `${JSON.stringify(bad)} is not a usable allowance`);
    }
    assert.equal(startupEnvMs(undefined), null);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "30" }), 120_000, "a value meant as seconds does not make every start fail at once");
    assert.equal(researchStartupAllowanceMs({ platform: "win32", runtime: "wsl", env: "0x2710" }), 180_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "1000" }), 1000);
  });

  it("does not floor the option, which only code and tests set", () => {
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", option: 30 }), 30);
  });

  it("takes an override from the option, then from the environment, and ignores nonsense", () => {
    assert.equal(researchStartupAllowanceMs({ platform: "win32", runtime: "wsl", option: 5000 }), 5000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "45000" }), 45_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", option: 7000, env: "45000" }), 7000, "the option wins over the environment");
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "soon" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "0" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", env: "-5" }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "linux", runtime: "posix", option: Number.NaN }), 120_000);
    assert.equal(researchStartupAllowanceMs({ platform: "win32", runtime: "wsl", env: "" }), 180_000);
  });
});
