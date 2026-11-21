import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { ConflictError, ValidationError } from "../src/assistant/store.js";
import { COLLECTOR_SCRIPT } from "../src/sentinel/collector-script.js";
import { PowerShellCollector, type ChildLike, type Collector, type CollectorHooks, type SpawnFn } from "../src/sentinel/collector.js";
import { LINE_MAX } from "../src/sentinel/events.js";
import { parseSettingsPatch, SentinelService, watchWanted } from "../src/sentinel/service.js";
import type { CollectorStatus, SentinelEvent } from "../src/sentinel/types.js";
import { HOUR, LogBuilder, MIN, SEC, T0 } from "./sentinel-fixtures.js";

/**
 * The collector's process handling and the service around the rules, with a fake child process, a fake collector, a fake clock
 * and a fake timer: no real PowerShell, no sleeping. One test runs the real script, and only on Windows.
 */

const folders: string[] = [];
const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "sentinel-svc-"));
  folders.push(folder);
  return folder;
};
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function collectorRig(options: { platform?: NodeJS.Platform; now?: () => number } = {}) {
  const dir = temp();
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const events: SentinelEvent[] = [];
  const statuses: CollectorStatus[] = [];
  const logs: string[] = [];
  let ready = 0;
  const hooks: CollectorHooks = { event: (event) => events.push(event), status: (status) => statuses.push(status), ready: () => void ready++ };
  const collector = new PowerShellCollector({ dir, platform: options.platform ?? "win32", spawn, parentPid: 4242, sampleSeconds: 30, pauseMs: () => 0, log: (line) => logs.push(line), ...(options.now ? { now: options.now } : {}) });
  const last = (): FakeChild => children[children.length - 1] as FakeChild;
  return { collector, children, calls, events, statuses, logs, hooks, dir, ready: () => ready, last };
}

const POWER_LINE = `{"t":"power","at":${T0},"change":"sleep","rid":1}`;

describe("the collector process", () => {
  it("runs on Windows only", () => {
    const rig = collectorRig({ platform: "linux" });
    rig.collector.start(rig.hooks, null);
    assert.equal(rig.collector.status().state, "unsupported");
    assert.equal(rig.calls.length, 0);
    rig.collector.stop();
    assert.equal(rig.collector.status().state, "unsupported");
  });

  it("starts the script with a read-only command line, and is running once it says hello", async () => {
    const rig = collectorRig({ now: () => T0 });
    rig.collector.start(rig.hooks, T0 - 3 * HOUR);
    assert.equal(rig.calls.length, 1);
    const args = rig.calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 7), ["-NoProfile", "-NonInteractive", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", join(rig.dir, "collector.ps1")]);
    assert.deepEqual(args.slice(7), ["-ParentPid", "4242", "-SampleSeconds", "30", "-Since", new Date(T0 - 3 * HOUR).toISOString()]);
    assert.equal(readFileSync(join(rig.dir, "collector.ps1"), "utf8"), COLLECTOR_SCRIPT);
    assert.equal(rig.collector.status().state, "starting");
    rig.last().stdout.write('{"t":"hello","v":1}\n');
    await tick();
    assert.equal(rig.collector.status().state, "running");
  });

  it("reads the whole history when it has none, 45 days back", () => {
    const rig = collectorRig({ now: () => T0 });
    rig.collector.start(rig.hooks, null);
    assert.equal(rig.calls[0]?.args.at(-1), new Date(T0 - 45 * 86_400_000).toISOString());
  });

  it("does not start twice", () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    rig.collector.start(rig.hooks, null);
    assert.equal(rig.calls.length, 1);
  });

  it("reads lines whole even when they arrive in pieces, and passes on only what it understands", async () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    const out = rig.last().stdout;
    out.write(POWER_LINE.slice(0, 20));
    await tick();
    assert.equal(rig.events.length, 0);
    out.write(`${POWER_LINE.slice(20)}\r\n{"t":"ready"}\nnot json at all\n{"t":"source","name":"wlan","ok":true}\n`);
    await tick();
    assert.equal(rig.events.length, 1);
    assert.equal(rig.events[0]?.kind, "power");
    assert.equal(rig.ready(), 1);
    assert.deepEqual(rig.collector.status().sources, { wlan: { ok: true, detail: null } });
  });

  it("drops a line that is far too long, and still reads the ones after it", async () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    const out = rig.last().stdout;
    out.write("x".repeat(LINE_MAX + 100));
    await tick();
    out.write(`tail of that line\n${POWER_LINE}\n`);
    await tick();
    assert.equal(rig.events.length, 1);
  });

  it("is not ended by a hook that throws, because it runs inside a stream's data handler", async () => {
    const rig = collectorRig();
    const bad: CollectorHooks = {
      event: () => {
        throw new Error("boom");
      },
      status: () => undefined,
      ready: () => undefined,
    };
    rig.collector.start(bad, null);
    rig.last().stdout.write(`${POWER_LINE}\n`);
    await tick();
    assert.ok(rig.logs.some((line) => line.includes("boom")));
    rig.last().stdout.write('{"t":"hello","v":1}\n');
    await tick();
    assert.equal(rig.collector.status().state, "running", "the next line is still read");
  });

  it("starts the script again when it dies, and says why", async () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    rig.last().stderr.write("Access is denied");
    await tick();
    rig.last().emit("exit", 1, null);
    await tick();
    assert.equal(rig.calls.length, 2);
    const status = rig.collector.status();
    assert.equal(status.state, "starting");
    assert.equal(status.restarts, 1);
    assert.equal(status.lastError, "Access is denied");
  });

  it("gives up after five quick deaths in a row, and says so", async () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    for (let i = 0; i < 5; i++) {
      rig.last().emit("exit", 1, null);
      await tick();
    }
    assert.equal(rig.calls.length, 5);
    assert.equal(rig.collector.status().state, "failed");
    assert.match(rig.collector.status().lastError ?? "", /exit code 1/);
    await tick();
    assert.equal(rig.calls.length, 5, "no more attempts");
  });

  it("does not count a script that ran for a minute as failing", async () => {
    let t = T0;
    const rig = collectorRig({ now: () => t });
    rig.collector.start(rig.hooks, null);
    for (let i = 0; i < 8; i++) {
      t += 61 * SEC;
      rig.last().emit("exit", 1, null);
      await tick();
    }
    assert.equal(rig.collector.status().state, "starting");
    assert.equal(rig.calls.length, 9);
  });

  it("stops the script, and a restart that was waiting does not happen", async () => {
    const rig = collectorRig();
    rig.collector.start(rig.hooks, null);
    rig.collector.stop();
    assert.equal(rig.children[0]?.killed, true);
    assert.equal(rig.collector.status().state, "off");
    await tick();
    assert.equal(rig.calls.length, 1);

    const waiting = collectorRig();
    waiting.collector.start(waiting.hooks, null);
    waiting.last().emit("exit", 1, null);
    waiting.collector.stop();
    await tick();
    assert.equal(waiting.calls.length, 1, "the pending restart was cancelled");
  });

  it("runs the real script on Windows, reads the log back and stops cleanly", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
    const collector = new PowerShellCollector({ dir: temp() });
    let ready = false;
    collector.start({ event: () => undefined, status: () => undefined, ready: () => void (ready = true) }, Date.now() - HOUR);
    try {
      const until = Date.now() + 90_000;
      while (!ready && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(ready, true, `the script did not finish reading the log: ${JSON.stringify(collector.status())}`);
      const status = collector.status();
      assert.equal(status.state, "running");
      assert.ok("wlan" in status.sources && "power" in status.sources, JSON.stringify(status.sources));
    } finally {
      collector.stop();
    }
    assert.equal(collector.status().state, "off");
  });
});

class FakeCollector implements Collector {
  starts = 0;
  stops = 0;
  startedWith: number | null | undefined;
  hooks: CollectorHooks | null = null;
  current: CollectorStatus = { state: "off", since: null, restarts: 0, lastError: null, sources: {} };
  start(hooks: CollectorHooks, since: number | null): void {
    this.starts++;
    this.hooks = hooks;
    this.startedWith = since;
    this.current = { ...this.current, state: "running" };
  }
  stop(): void {
    this.stops++;
    this.hooks = null;
    this.current = { ...this.current, state: "off" };
  }
  status(): CollectorStatus {
    return this.current;
  }
}

function rig(options: { dir?: string | null; platform?: NodeJS.Platform } = {}) {
  const clock = { t: T0 + 30 * MIN };
  const collector = new FakeCollector();
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const emitted: Array<{ type: string; reason: string; id?: string }> = [];
  const logs: string[] = [];
  const service = new SentinelService({
    dir: options.dir ?? null,
    collector,
    now: () => clock.t,
    platform: options.platform ?? "win32",
    schedule: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    emit: (event) => emitted.push(event),
    log: (line) => logs.push(line),
  });
  const send = (events: SentinelEvent[]): void => events.forEach((event) => collector.hooks?.event(event));
  const live = () => timers.filter((timer) => !timer.cancelled);
  return { service, clock, collector, emitted, logs, send, live };
}

describe("the Sentinel", () => {
  it("starts with Watch and Act off, and does nothing until told to", () => {
    const r = rig();
    r.service.start();
    assert.deepEqual(r.service.settings(), { watch: false, act: false });
    assert.equal(r.collector.starts, 0);
    assert.equal(r.service.status().watching, false);
    assert.equal(r.live().length, 0);
  });

  it("starts the collector when Watch goes on, reading the log from the beginning, and stops it when it goes off", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    assert.equal(r.collector.starts, 1);
    assert.equal(r.collector.startedWith, null);
    assert.equal(r.service.status().watching, true);
    assert.deepEqual(r.service.recentAudit(1)[0]?.data, { watch: true, act: false, was: { watch: false, act: false } });
    assert.ok(r.emitted.some((event) => event.reason === "settings"));
    r.service.setSettings({ watch: true });
    assert.equal(r.collector.starts, 1, "already watching");
    assert.equal(r.service.recentAudit(10).filter((entry) => entry.kind === "settings").length, 1, "nothing changed, nothing written");
    r.service.setSettings({ watch: false });
    assert.equal(r.collector.stops, 1);
    assert.equal(r.live().length, 0);
    assert.equal(r.service.status().watching, false);
  });

  it("cannot watch where there is no Windows, and says so", () => {
    const r = rig({ platform: "linux" });
    assert.throws(() => r.service.setSettings({ watch: true }), ConflictError);
    assert.equal(r.service.settings().watch, false);
    assert.equal(r.service.status().supported, false);
    assert.equal(r.collector.starts, 0);
  });

  it("takes only booleans for the two settings it has", () => {
    assert.deepEqual(parseSettingsPatch({ watch: true }), { watch: true });
    assert.deepEqual(parseSettingsPatch({ act: false, watch: true }), { act: false, watch: true });
    assert.throws(() => parseSettingsPatch({}), ValidationError);
    assert.throws(() => parseSettingsPatch({ watch: "yes" }), ValidationError);
    assert.throws(() => parseSettingsPatch({ watch: 1 }), ValidationError);
    assert.throws(() => parseSettingsPatch({ elevate: true }), ValidationError);
  });

  it("keeps its settings in a file, and a restart with Watch left on starts watching from the last event it kept", () => {
    const dir = temp();
    assert.equal(watchWanted(dir), false);
    assert.equal(watchWanted(null), false);
    const first = rig({ dir });
    first.service.setSettings({ watch: true, act: true });
    const b = new LogBuilder();
    b.disconnect(first.clock.t - 5 * MIN, 2);
    first.send(b.events);
    first.service.close();
    assert.equal(watchWanted(dir), true);
    const second = rig({ dir });
    assert.deepEqual(second.service.settings(), { watch: true, act: true });
    second.service.start();
    assert.equal(second.collector.starts, 1);
    assert.equal(second.collector.startedWith, first.clock.t - 5 * MIN);
    second.service.close();
  });

  it("closes what a previous run left open when watching starts again, because it cannot say the condition still holds", () => {
    const dir = temp();
    const first = rig({ dir });
    first.service.setSettings({ watch: true });
    const b = new LogBuilder();
    b.disconnect(first.clock.t, 0);
    first.send(b.events);
    first.clock.t += 16 * SEC;
    first.service.tick();
    assert.equal(first.service.findings({ open: true }).length, 1);
    first.service.close();
    const second = rig({ dir });
    second.service.start();
    assert.equal(second.collector.starts, 1);
    assert.equal(second.service.findings({ open: true }).length, 0);
    assert.match(second.service.findings()[0]?.detail ?? "", /stopped watching/);
    second.service.close();
  });

  it("keeps what happened before it started as history and not as news", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const day = 24 * HOUR;
    const b = new LogBuilder();
    b.disconnect(r.clock.t - 5 * HOUR, 0);
    b.attempt(r.clock.t - 5 * HOUR + 40 * SEC - 200, 200, "ok");
    b.disconnect(r.clock.t - 4 * HOUR, 0);
    b.attempt(r.clock.t - 4 * HOUR + 4 * SEC - 200, 200, "ok");
    r.send(b.events.map((event) => ({ ...event, backfill: true })));
    r.collector.hooks?.ready();
    assert.equal(r.service.status().open.length, 0, "nothing is open");
    assert.equal(r.service.status().stats.realDrops, 0, "the live rules were not run on it");
    const found = r.service.findings();
    assert.deepEqual(found.map((f) => f.kind).sort(), ["wifi-blip", "wifi-drop"]);
    assert.ok(found.every((f) => f.resolvedAt !== null));
    assert.deepEqual(r.service.digest(), { since: r.clock.t - day, total: 2, blips: 1, drops: 1, stuck: 0, flapping: 0, weakSignal: 0, down: 0, cannotConnect: 0 });
    assert.equal(r.service.daily(2, 0).reduce((sum, d) => sum + d.drops + d.blips, 0), 2);
    assert.deepEqual(r.service.recentAudit(1)[0]?.kind, "backfill");
    assert.ok(r.emitted.some((event) => event.reason === "status"));
  });

  it("finds a real drop as it happens, keeps it, announces it and audits it, and closes it when the connection returns", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const t = r.clock.t;
    const b = new LogBuilder();
    b.disconnect(t, 0);
    r.send(b.events);
    assert.equal(r.live().at(-1)?.ms, 15_000, "the next timer is the judgment of that drop");
    assert.equal(r.service.status().open.length, 0);
    r.clock.t = t + 16 * SEC;
    r.service.tick();
    const open = r.service.status().open;
    assert.equal(open.length, 1);
    assert.equal(open[0]?.kind, "wifi-drop");
    assert.equal(r.service.findings({ open: true }).length, 1);
    assert.equal(r.service.status().stats.realDrops, 1);
    assert.ok(r.emitted.some((event) => event.reason === "finding" && event.id === open[0]?.id));
    assert.ok(r.service.recentAudit(10).some((entry) => entry.kind === "finding" && entry.data["kind"] === "wifi-drop"));
    const back = new LogBuilder();
    back.attempt(t + 40 * SEC - 200, 200, "ok");
    r.clock.t = t + 41 * SEC;
    r.send(back.events);
    assert.equal(r.service.status().open.length, 0);
    assert.equal(r.service.findings({ open: true }).length, 0);
    assert.ok(r.service.recentAudit(10).some((entry) => entry.kind === "resolved"));
    assert.equal(r.service.verifyAudit().ok, true);
  });

  it("judges a record of the OS log once, even if it is sent twice", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const b = new LogBuilder();
    b.disconnect(r.clock.t, 0);
    r.send(b.events);
    r.send(b.events);
    assert.equal(r.service.status().stats.disconnects.driver, 1);
  });

  it("survives a failure while handling an event, and says so", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const hooks = r.collector.hooks;
    assert.ok(hooks);
    // Closing the history under it is how a full disk or a locked file would break it.
    r.service.close();
    const b = new LogBuilder();
    b.disconnect(r.clock.t, 0);
    assert.doesNotThrow(() => hooks.event(b.events[0] as SentinelEvent));
    assert.ok(r.logs.some((line) => line.includes("handling an event failed")), r.logs.join(" | "));
  });

  it("ignores an event stamped in the future, and says so once", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const b = new LogBuilder();
    b.disconnect(r.clock.t + 10 * MIN, 0);
    b.disconnect(r.clock.t + 20 * MIN, 0);
    r.send(b.events);
    assert.equal(r.service.status().stats.disconnects.driver, 0);
    assert.equal(r.logs.filter((line) => line.includes("future")).length, 1);
  });

  it("waits after a suspension for the sleep that explains a drop, instead of judging it with the whole night in between", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const t = r.clock.t;
    const b = new LogBuilder();
    b.disconnect(t, 0);
    r.send(b.events);
    // The lid closes: the machine sleeps for three hours, and its timers all run late when it wakes.
    r.clock.t = t + 3 * HOUR;
    r.live().at(-1)?.fn();
    assert.equal(r.service.status().open.length, 0, "no judgment yet");
    const grace = r.live().at(-1);
    assert.equal(grace?.ms, 20_000);
    // The log's events reach the collector a moment after the wake, in order.
    const late = new LogBuilder();
    late.power("sleep", t + 2 * SEC);
    late.power("resume", t + 3 * HOUR);
    r.send(late.events);
    assert.ok(r.live().at(-1) === grace, "an event in the pause does not cut it short");
    r.clock.t += 20 * SEC;
    grace?.fn();
    assert.equal(r.service.status().open.length, 0);
    assert.equal(r.service.findings().length, 0, "no drop, and no outage of three hours");
    assert.equal(r.service.status().stats.realDrops, 0);
    assert.equal(r.service.status().stats.nearPower, 1);
  });

  it("judges on time when nothing was suspended", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    const t = r.clock.t;
    const b = new LogBuilder();
    b.disconnect(t, 0);
    r.send(b.events);
    r.clock.t = t + 15 * SEC + 400;
    r.live().at(-1)?.fn();
    assert.equal(r.service.status().open.length, 1);
  });

  it("stops the collector and writes down that it stopped", () => {
    const r = rig();
    r.service.setSettings({ watch: true });
    r.service.close();
    assert.equal(r.collector.stops, 1);
    assert.equal(r.service.recentAudit(1)[0]?.kind, "stop");
  });

  it("reports what the screens need", () => {
    const r = rig();
    const status = r.service.status();
    assert.deepEqual(Object.keys(status).sort(), ["auditHead", "collector", "open", "settings", "stats", "supported", "watching", "wifi"]);
    assert.equal(status.supported, true);
    assert.equal(status.wifi.state, "unknown");
  });
});
