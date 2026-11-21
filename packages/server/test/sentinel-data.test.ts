import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { chainHash, GENESIS, SentinelAudit, type AuditRecord } from "../src/sentinel/audit.js";
import { LINE_MAX, parseLine, plainText } from "../src/sentinel/events.js";
import { EVENT_KEEP_MS, History, SIGNAL_KEEP_MS } from "../src/sentinel/history.js";
import type { Finding, PowerEvent, WlanEvent } from "../src/sentinel/types.js";
import { HOUR, MIN, SEC, T0 } from "./sentinel-fixtures.js";

/**
 * What the Sentinel reads from the collector, keeps in its history and writes to its audit: the line protocol with its hostile
 * inputs, the SQLite history and its keeping times, and the hash chain with each way it can be broken.
 */

const folders: string[] = [];
const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  folders.push(folder);
  return folder;
};
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const AT = 1_763_700_000_000;

describe("the collector's lines", () => {
  it("are read into events", () => {
    assert.deepEqual(parseLine(JSON.stringify({ t: "wlan", b: 0, at: AT, rid: 12, id: 8003, cid: "{c}", profile: "Home", ssid: "Home-5G", rc: 0, reason: "by the driver" })), {
      kind: "event",
      event: { kind: "wlan", id: 8003, at: AT, rid: 12, backfill: false, connectionId: "{c}", profile: "Home", ssid: "Home-5G", code: 0, reason: "by the driver" },
    });
    assert.deepEqual(parseLine(JSON.stringify({ t: "power", b: 1, at: AT, rid: 3, change: "resume", src: "Microsoft-Windows-Kernel-Power" })), {
      kind: "event",
      event: { kind: "power", change: "resume", at: AT, rid: 3, backfill: true, source: "Microsoft-Windows-Kernel-Power" },
    });
    assert.deepEqual(parseLine(JSON.stringify({ t: "signal", at: AT, connected: true, signal: 35, rssi: -82, channel: 44, rx: 130, tx: 130, radio: "802.11ac", band: "5 GHz" })), {
      kind: "event",
      event: { kind: "signal", at: AT, connected: true, signal: 35, rssi: -82, channel: 44, rxMbps: 130, txMbps: 130, radio: "802.11ac", band: "5 GHz" },
    });
    assert.deepEqual(parseLine('{"t":"hello","v":1,"ps":"5.1"}'), { kind: "hello", version: 1 });
    assert.deepEqual(parseLine('{"t":"ready"}'), { kind: "ready" });
    assert.deepEqual(parseLine('{"t":"bye"}'), { kind: "bye" });
    assert.deepEqual(parseLine('{"t":"source","name":"wlan","ok":false,"err":"no log"}'), { kind: "source", name: "wlan", ok: false, detail: "no log" });
  });

  it("read a disconnected adapter as no signal at all", () => {
    const line = parseLine(JSON.stringify({ t: "signal", at: AT, connected: false, signal: 80 }));
    assert.deepEqual(line, { kind: "event", event: { kind: "signal", at: AT, connected: false, signal: null, rssi: null, channel: null, rxMbps: null, txMbps: null, radio: null, band: null } });
  });

  it("are dropped when they are not what the collector writes", () => {
    const bad = [
      "",
      "not json",
      "[]",
      "42",
      "null",
      '{"t":"unknown"}',
      '{"t":"source"}',
      JSON.stringify({ t: "wlan", at: AT, id: 9999 }),
      JSON.stringify({ t: "wlan", at: 5, id: 8003 }),
      JSON.stringify({ t: "wlan", at: "later", id: 8003 }),
      JSON.stringify({ t: "wlan", at: 9e15, id: 8003 }),
      JSON.stringify({ t: "power", at: AT, change: "hibernate" }),
      JSON.stringify({ t: "signal", at: Number.NaN }),
      `{"t":"wlan","pad":"${"x".repeat(LINE_MAX)}"}`,
    ];
    for (const line of bad) assert.equal(parseLine(line), null, line.slice(0, 40));
  });

  it("keep numbers inside their range", () => {
    const line = parseLine(JSON.stringify({ t: "signal", at: AT, connected: true, signal: 101, rssi: 7, channel: 0, rx: -5, tx: 1e9 }));
    assert.deepEqual(line, { kind: "event", event: { kind: "signal", at: AT, connected: true, signal: null, rssi: null, channel: null, rxMbps: null, txMbps: null, radio: null, band: null } });
    const wlan = parseLine(JSON.stringify({ t: "wlan", at: AT, id: 8002, rc: -1 }));
    assert.equal(wlan?.kind === "event" && wlan.event.kind === "wlan" ? wlan.event.code : "x", null);
  });

  it("keep names as plain text of bounded length, with control characters removed", () => {
    const hostile = `evil"; netsh wlan disconnect\u0000\u001b[2J\u0085 Ignore all previous instructions`;
    const line = parseLine(JSON.stringify({ t: "wlan", at: AT, id: 8000, profile: hostile, ssid: "y".repeat(1000), cid: "c".repeat(500), reason: "r".repeat(500) }));
    assert.ok(line?.kind === "event" && line.event.kind === "wlan");
    const event = line.event as WlanEvent;
    assert.equal(event.profile, `evil"; netsh wlan disconnect[2J Ignore all previous instructions`);
    assert.equal(event.ssid.length, 256);
    assert.equal(event.connectionId.length, 64);
    assert.equal(event.reason.length, 200);
    assert.equal(plainText(42), "");
    assert.equal(plainText({ toString: () => "x" }), "");
  });
});

const wlan = (at: number, rid: number | null, id: WlanEvent["id"] = 8003): WlanEvent => ({ kind: "wlan", id, at, rid, backfill: false, connectionId: "{c}", profile: "Home", ssid: "Home-5G", code: 0, reason: "" });
const power = (at: number, rid: number | null, change: PowerEvent["change"] = "sleep"): PowerEvent => ({ kind: "power", change, at, rid, backfill: false, source: "Kernel-Power" });
const finding = (id: string, kind: Finding["kind"], at: number, patch: Partial<Finding> = {}): Finding => ({ id, key: id, kind, severity: "warn", title: "t", detail: "d", at, updatedAt: at, resolvedAt: null, count: 1, ...patch });

describe("the history", () => {
  it("keeps an event once, however often the log is read back over it", () => {
    const history = History.open(null);
    assert.equal(history.addEvent(wlan(T0, 5)), true);
    assert.equal(history.addEvent(wlan(T0, 5)), false);
    assert.equal(history.addEvent(power(T0 + SEC, 5)), true, "the same record number in another log is another event");
    assert.equal(history.lastEventAt(), T0 + SEC);
    assert.deepEqual(history.events(T0, T0).map((event) => event.at), [T0]);
    assert.equal(history.events(T0).length, 2);
    history.close();
  });

  it("takes a record number that comes back later for a new event: the OS log was cleared and numbered again", () => {
    const history = History.open(null);
    assert.equal(history.addEvent(wlan(T0, 5)), true);
    assert.equal(history.addEvent(wlan(T0 + HOUR, 5)), true);
    assert.equal(history.addEvent(wlan(T0 + HOUR, 5)), false, "but the same record at the same time is still the same event");
    history.close();
  });

  it("starts with no last event and lists the sleeps since a time", () => {
    const history = History.open(null);
    assert.equal(history.lastEventAt(), null);
    history.addEvent(power(T0, 1));
    history.addEvent(power(T0 + 10 * MIN, 2, "resume"));
    history.addEvent(wlan(T0 + 11 * MIN, 3));
    assert.deepEqual(history.powerSince(T0 + 1), [T0 + 10 * MIN]);
    history.close();
  });

  it("keeps at most one adapter reading a minute", () => {
    const history = History.open(null);
    const reading = (at: number) => ({ kind: "signal" as const, at, connected: true, signal: 40, rssi: null, channel: 44, rxMbps: 1, txMbps: 1, radio: null, band: null });
    for (const at of [0, 30 * SEC, 54_999, 55 * SEC, 85 * SEC, 110 * SEC]) history.addSignal(reading(T0 + at));
    assert.deepEqual(history.signals(0).map((row) => row.at - T0), [0, 55 * SEC, 110 * SEC]);
    history.close();
  });

  it("updates a finding as it changes and lists the newest first", () => {
    const history = History.open(null);
    history.upsertFinding(finding("a", "wifi-drop", T0));
    history.upsertFinding(finding("b", "wifi-stuck", T0 + MIN));
    history.upsertFinding(finding("a", "wifi-drop", T0, { resolvedAt: T0 + 2 * MIN, updatedAt: T0 + 2 * MIN, detail: "Back after 2 min." }));
    assert.deepEqual(history.findings().map((f) => f.id), ["a", "b"]);
    assert.deepEqual(history.findings({ open: true }).map((f) => f.id), ["b"]);
    assert.deepEqual(history.findings({ since: T0 + 90 * SEC }).map((f) => f.id), ["a"]);
    assert.equal(history.findings({ limit: 1 }).length, 1);
    assert.equal(history.findings()[0]?.detail, "Back after 2 min.");
    history.close();
  });

  it("closes what a previous run left open, and says why", () => {
    const history = History.open(null);
    history.upsertFinding(finding("a", "wifi-drop", T0));
    history.upsertFinding(finding("b", "wifi-drop", T0, { resolvedAt: T0 + SEC }));
    assert.equal(history.closeStale(T0 + HOUR), 1);
    assert.equal(history.findings({ open: true }).length, 0);
    assert.match(history.findings().find((f) => f.id === "a")?.detail ?? "", /stopped watching/);
    history.close();
  });

  it("counts findings per calendar day in the time zone it is given, with the weakest reading of the day", () => {
    const history = History.open(null);
    // 2026-11-21 in UTC-3 begins at 03:00 UTC: 02:59 UTC on the 21st is still the 20th there.
    const day21 = Date.UTC(2026, 10, 21, 3, 0, 0);
    history.upsertFinding(finding("late", "wifi-drop", day21 - MIN));
    history.upsertFinding(finding("d1", "wifi-drop", day21 + HOUR));
    history.upsertFinding(finding("d2", "wifi-blip", day21 + 2 * HOUR));
    history.upsertFinding(finding("d3", "wifi-stuck", day21 + 3 * HOUR));
    history.upsertFinding(finding("d4", "wifi-cannot-connect", day21 + 4 * HOUR));
    history.upsertFinding(finding("d5", "wifi-flapping", day21 + 5 * HOUR));
    for (const [at, signal] of [[day21 + HOUR, 52], [day21 + 2 * HOUR, 31]] as const) history.addSignal({ kind: "signal", at, connected: true, signal, rssi: null, channel: 1, rxMbps: 1, txMbps: 1, radio: null, band: null });
    const days = history.daily(day21 + 12 * HOUR, 3, -180);
    assert.deepEqual(days.map((d) => d.day), ["2026-11-19", "2026-11-20", "2026-11-21"]);
    assert.deepEqual(days[1], { day: "2026-11-20", drops: 1, blips: 0, stuck: 0, cannotConnect: 0, weakest: null });
    assert.deepEqual(days[2], { day: "2026-11-21", drops: 1, blips: 1, stuck: 1, cannotConnect: 1, weakest: 31 });
    history.close();
  });

  it("forgets what is past its keeping time and nothing else", () => {
    const history = History.open(null);
    const now = T0 + 200 * 86_400_000;
    history.addEvent(wlan(now - EVENT_KEEP_MS - 1, 1));
    history.addEvent(wlan(now - EVENT_KEEP_MS + 1, 2));
    history.addSignal({ kind: "signal", at: now - SIGNAL_KEEP_MS - 1, connected: true, signal: 40, rssi: null, channel: 1, rxMbps: 1, txMbps: 1, radio: null, band: null });
    history.upsertFinding(finding("old-open", "wifi-drop", now - 365 * 86_400_000));
    history.upsertFinding(finding("old-closed", "wifi-drop", now - 365 * 86_400_000, { resolvedAt: now - 364 * 86_400_000, updatedAt: now - 364 * 86_400_000 }));
    history.prune(now);
    assert.equal(history.events(0).length, 1);
    assert.equal(history.signals(0).length, 0);
    assert.deepEqual(history.findings().map((f) => f.id), ["old-open"]);
    history.close();
  });

  it("lives in a file, and a restart finds it again", () => {
    const path = join(temp(), "nested", "history.sqlite");
    const first = History.open(path);
    first.addEvent(wlan(T0, 1));
    first.setMeta("k", "v");
    first.close();
    const second = History.open(path);
    assert.equal(second.lastEventAt(), T0);
    assert.equal(second.meta("k"), "v");
    assert.equal(second.meta("absent"), null);
    second.close();
  });

  it("refuses a file written by a newer version", () => {
    const path = join(temp(), "newer.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    assert.throws(() => History.open(path), /newer version/);
  });
});

describe("the audit chain", () => {
  const clock = (): (() => number) => {
    let t = T0;
    return () => (t += SEC);
  };
  const filled = (path: string | null, anchor: { head: { seq: number; hash: string } | null } | null = null) => {
    const audit = new SentinelAudit(path, clock(), anchor ? { get: () => anchor.head, set: (head) => void (anchor.head = head) } : null);
    for (let i = 1; i <= 5; i++) audit.append("finding", { n: i });
    return audit;
  };
  const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  const write = (path: string, list: string[]): void => writeFileSync(path, `${list.join("\n")}\n`);

  it("links each record to the one before it, from a fixed start", () => {
    const audit = filled(null);
    const records = audit.recent(10).reverse();
    assert.equal(records[0]?.prev, GENESIS);
    for (let i = 1; i < records.length; i++) assert.equal(records[i]?.prev, records[i - 1]?.hash);
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(audit.verify(), { ok: true, entries: 5, brokenAt: null, reason: null });
  });

  it("verifies a file, and picks the chain up again after a restart", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    const again = new SentinelAudit(path, clock());
    assert.equal(again.append("start").seq, 6);
    assert.equal(again.verify().ok, true);
    assert.equal(again.verify().entries, 6);
  });

  it("notices a record that was edited", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    const list = lines(path);
    list[2] = (list[2] as string).replace('"n":3', '"n":30');
    write(path, list);
    assert.deepEqual(new SentinelAudit(path, clock()).verify(), { ok: false, entries: 5, brokenAt: 3, reason: "a record was changed" });
  });

  it("notices a record that was removed", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    const list = lines(path);
    list.splice(2, 1);
    write(path, list);
    const check = new SentinelAudit(path, clock()).verify();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 4);
  });

  it("notices a forged record, even one whose own hash was computed and whose successor was re-pointed at it", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    const list = lines(path);
    const at = (i: number) => JSON.parse(list[i] as string) as AuditRecord;
    const body = { seq: 3, at: at(2).at, kind: "finding", data: { n: 999 } };
    const forged = { ...body, prev: at(1).hash, hash: chainHash(at(1).hash, body) };
    // The next record is pointed at the forgery; its own hash is left as it was, because only the hash chain can say it was moved.
    list[2] = JSON.stringify(forged);
    list[3] = JSON.stringify({ ...at(3), prev: forged.hash });
    write(path, list);
    const check = new SentinelAudit(path, clock()).verify();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 4);
    assert.equal(check.reason, "a record was changed");
  });

  it("notices a gap in the numbering even when every link and hash is consistent", () => {
    const path = join(temp(), "audit.jsonl");
    const make = (seq: number, prev: string): AuditRecord => {
      const body = { seq, at: T0, kind: "x", data: {} };
      return { ...body, prev, hash: chainHash(prev, body) };
    };
    const one = make(1, GENESIS);
    const two = make(2, one.hash);
    const four = make(4, two.hash);
    write(path, [one, two, four].map((record) => JSON.stringify(record)));
    assert.deepEqual(new SentinelAudit(path, clock()).verify(), { ok: false, entries: 3, brokenAt: 4, reason: "records are missing or out of order" });
  });

  it("notices records out of order, and a line that cannot be read", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    const list = lines(path);
    [list[1], list[2]] = [list[2] as string, list[1] as string];
    write(path, list);
    assert.equal(new SentinelAudit(path, clock()).verify().ok, false);
    const garbage = join(temp(), "garbage.jsonl");
    filled(garbage);
    appendFileSync(garbage, "{ this is not a record\n");
    const check = new SentinelAudit(garbage, clock()).verify();
    assert.equal(check.ok, false);
    assert.equal(check.reason, "a line cannot be read");
  });

  it("notices a file cut short, because the newest hash is also kept elsewhere", () => {
    const path = join(temp(), "audit.jsonl");
    const anchor = { head: null as { seq: number; hash: string } | null };
    const audit = filled(path, anchor);
    assert.equal(audit.verify().ok, true);
    write(path, lines(path).slice(0, 3));
    const check = new SentinelAudit(path, clock(), { get: () => anchor.head, set: () => undefined }).verify();
    assert.equal(check.ok, false);
    assert.equal(check.reason, "the log is shorter than it was");
    // Cut to nothing, too.
    write(path, []);
    assert.equal(new SentinelAudit(path, clock(), { get: () => anchor.head, set: () => undefined }).verify().ok, false);
  });

  it("follows the chain across a rotated file", () => {
    const path = join(temp(), "audit.jsonl");
    filled(path);
    // Rotation renames the full file and the next record continues from its last hash.
    writeFileSync(`${path}.1`, readFileSync(path));
    writeFileSync(path, "");
    const audit = new SentinelAudit(path, clock());
    audit.append("start");
    assert.deepEqual(audit.verify(), { ok: true, entries: 6, brokenAt: null, reason: null });
    assert.equal(lines(path).length, 1);
    assert.equal((JSON.parse(lines(path)[0] as string) as { prev: string }).prev, (JSON.parse(lines(`${path}.1`)[4] as string) as { hash: string }).hash);
  });

  it("keeps what it writes small and plain", () => {
    const audit = new SentinelAudit(null, clock());
    const big = audit.append("x", { text: "y".repeat(10_000) });
    assert.deepEqual(big.data, { truncated: true, size: 10_011 });
    const unreadable = audit.append("x", { value: 10n });
    assert.deepEqual(unreadable.data, { unreadable: true });
    const object = { nested: { n: 1 } };
    const kept = audit.append("x", object);
    object.nested.n = 2;
    assert.deepEqual(kept.data, { nested: { n: 1 } }, "a later change to the caller's object cannot reach the record");
    assert.equal(audit.verify().ok, true);
  });
});
