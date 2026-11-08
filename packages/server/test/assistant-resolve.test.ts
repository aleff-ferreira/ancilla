import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aboutScore, resolve, sameTopic, standing, type ResolveContext } from "../src/assistant/resolve.js";
import { identifiersOf } from "../src/assistant/text.js";
import { GLOBAL, type Basis, type Candidate, type MemoryItem, type MemoryKind, type Scope } from "../src/assistant/types.js";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY = 86_400_000;

function item(id: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id, assistantId: "default", kind: "fact", scope: GLOBAL, status: "active", slot: null, pinned: false, text, basis: "explicit", confidence: 0.9,
    observedAt: T0, validFrom: null, validTo: null, dueAt: null, commitment: null, revalidateAfterMs: null, lastConfirmedAt: T0, supersededBy: null, rev: 1,
    identifiers: identifiersOf(text), createdAt: T0, updatedAt: T0, ...extra,
  };
}

function cand(text: string, extra: Partial<Candidate> & { at?: number; basis?: Basis; kind?: MemoryKind; scope?: Scope } = {}): Candidate {
  const { at, ...rest } = extra;
  return {
    intent: "remember", kind: "fact", text, basis: "explicit", confidence: 0.9, scope: GLOBAL, identifiers: identifiersOf(text), rule: "test",
    source: { kind: "user_message", excerpt: text, observedAt: at ?? T0 + DAY, trust: "user" }, ...rest,
  };
}

const ctx = (extra: Partial<ResolveContext> = {}): ResolveContext => ({ now: T0 + 2 * DAY, tombstoned: false, paused: false, recent: new Set(), ...extra });

describe("what becomes of a proposed memory", () => {
  it("corroborates a statement already on file instead of duplicating it", () => {
    const r = resolve(cand("Never use emojis in commit messages"), [item("m1", "never use emojis in commit  messages.", { kind: "constraint" })], ctx());
    assert.deepEqual(r, { kind: "corroborate", target: "m1" });
  });

  it("replaces a slot's old value with a newer one and keeps the old as history", () => {
    const old = item("m1", "My name is Aleff", { slot: "user.name" });
    const r = resolve(cand("My name is Aleff Ferreira", { slot: "user.name" }), [old], ctx());
    assert.equal(r.kind, "create");
    assert.deepEqual((r as { supersedes: string[] }).supersedes, ["m1"]);
  });

  it("keeps an older statement that arrives late as history, never as the head", () => {
    const head = item("m2", "My timezone is Europe/Lisbon", { slot: "user.timezone", observedAt: T0 + 10 * DAY });
    const r = resolve(cand("My timezone is America/Belem", { slot: "user.timezone", at: T0 + 5 * DAY }), [head], ctx());
    assert.deepEqual(r, { kind: "late", newerHead: "m2", reason: "an equal or better established statement is newer" });
  });

  it("does not let a guess replace what the user said", () => {
    const said = item("m1", "I prefer tabs over spaces for indentation", { kind: "preference" });
    const guess = cand("I prefer spaces over tabs for indentation", { kind: "preference", basis: "inferred", confidence: 0.4 });
    assert.deepEqual(resolve(guess, [said], ctx()), { kind: "suppress", reason: "low-standing" });
    assert.ok(standing("explicit", "user") > standing("observed", "verified"));
    assert.ok(standing("observed", "unverified") > standing("inferred", "user"));
  });

  it("marks equals that disagree as contested instead of picking one", () => {
    const a = item("m1", "My deploy branch is release/v2.0", { slot: "user.deploy branch", observedAt: T0 + DAY });
    const r = resolve(cand("My deploy branch is main", { slot: "user.deploy branch", at: T0 + DAY }), [a], ctx());
    assert.equal(r.kind, "create");
    assert.equal((r as { status: string }).status, "contested");
    assert.deepEqual((r as { contests: string[] }).contests, ["m1"]);
  });

  it("treats a restatement of the same matter as a newer belief", () => {
    const old = item("m1", "I prefer tabs over spaces for indentation", { kind: "preference" });
    const r = resolve(cand("I prefer spaces over tabs for indentation now", { kind: "preference", at: T0 + 30 * DAY }), [old], ctx());
    assert.equal(r.kind, "create");
    assert.deepEqual((r as { supersedes: string[] }).supersedes, ["m1"]);
    assert.ok(sameTopic("Never use emojis in commit messages", "Always use emojis in commit messages"), "the same words with the sense turned over");
    assert.ok(!sameTopic("I like Python for scripting", "I like Go for services"));
  });

  it("keeps unrelated preferences side by side", () => {
    const r = resolve(cand("I like Go for services", { kind: "preference" }), [item("m1", "I like Python for scripting", { kind: "preference" })], ctx());
    assert.deepEqual(r, { kind: "create", status: "active", supersedes: [], contests: [], reason: "new" });
  });

  it("does not let a project statement replace a global one", () => {
    const global = item("m1", "I prefer tabs over spaces for indentation", { kind: "preference" });
    const r = resolve(cand("I prefer spaces over tabs for indentation", { kind: "preference", scope: { kind: "project", key: "/work/atlas" } }), [global], ctx());
    assert.equal(r.kind, "create");
    assert.deepEqual((r as { supersedes: string[] }).supersedes, []);
  });

  it("is quiet while capture is paused, and refuses what was erased unless the user says it again", () => {
    assert.deepEqual(resolve(cand("I like Go"), [], ctx({ paused: true })), { kind: "suppress", reason: "paused" });
    assert.deepEqual(resolve(cand("I like Go", { basis: "inferred" }), [], ctx({ tombstoned: true })), { kind: "suppress", reason: "tombstone" });
    assert.equal(resolve(cand("I like Go"), [], ctx({ tombstoned: true })).kind, "create", "an explicit statement made after the erasure is the user's choice");
  });
});

describe("corrections", () => {
  const notes = item("m1", "the release notes go in docs/NOTES.md", { kind: "fact" });

  it("replaces the memory it is about, found by its words and identifiers, and inherits what that memory was", () => {
    const old = item("m1", "the release notes go in docs/NOTES.md", { kind: "constraint", slot: "release.notes", pinned: true });
    const r = resolve(cand("use CHANGELOG.md instead of docs/NOTES.md", { intent: "correct", about: "use CHANGELOG.md instead of docs/NOTES.md" }), [old, item("m9", "I prefer tabs", { kind: "preference" })], ctx());
    assert.equal(r.kind, "create");
    const create = r as Extract<typeof r, { kind: "create" }>;
    assert.deepEqual(create.supersedes, ["m1"]);
    assert.deepEqual(create.inherit, { kind: "constraint", slot: "release.notes", pinned: true });
  });

  it("asks which memory is meant when it cannot tell, and lets what the assistant just used break a tie", () => {
    const a = item("m1", "the staging database is at db-1.example.com");
    const b = item("m2", "the staging server is at app-1.example.com");
    // "No, I meant staging": all it says is a word that two memories share.
    const c = cand("staging", { intent: "correct", about: "staging" });
    const unsure = resolve(c, [a, b], ctx());
    assert.equal(unsure.kind, "ambiguous");
    assert.deepEqual((unsure as { options: string[] }).options.sort(), ["m1", "m2"]);
    const sure = resolve(c, [a, b], ctx({ recent: new Set(["m2"]) }));
    assert.equal(sure.kind, "create");
    assert.deepEqual((sure as { supersedes: string[] }).supersedes, ["m2"]);
  });

  it("is an ordinary statement when there is nothing on file to correct", () => {
    const r = resolve(cand("the deadline is Friday", { intent: "correct", about: "the deadline is Friday" }), [item("m1", "I prefer tabs", { kind: "preference" })], ctx());
    assert.deepEqual(r, { kind: "create", status: "active", supersedes: [], contests: [], reason: "a correction with nothing on file to correct" });
  });

  it("does not let an older correction undo a newer statement", () => {
    const r = resolve(cand("use CHANGELOG.md instead of docs/NOTES.md", { intent: "correct", about: "docs/NOTES.md", at: T0 - DAY }), [notes], ctx());
    assert.equal(r.kind, "late");
  });

  it("scores an identifier in common above words in common", () => {
    assert.ok(aboutScore("docs/NOTES.md", notes) >= 0.5);
    assert.ok(aboutScore("my favourite colour", notes) < 0.2);
  });
});

describe("forgetting", () => {
  const pool = [
    item("m1", "the release notes go in docs/NOTES.md"),
    item("m2", "my timezone is America/Belem", { slot: "user.timezone" }),
    item("m3", "the staging server is at app-1.example.com"),
    item("m4", "the staging database is at db-1.example.com"),
  ];
  const forget = (about: string, excerpt = `forget ${about}`) => cand(about, { intent: "forget", about, source: { kind: "user_message", excerpt, observedAt: T0 + DAY, trust: "user" } });

  it("forgets the one memory that clearly matches", () => {
    assert.deepEqual(resolve(forget("docs/NOTES.md"), pool, ctx()), { kind: "forget", targets: ["m1"], reason: "one clear match" });
    assert.deepEqual((resolve(forget("my timezone"), pool, ctx()) as { targets: string[] }).targets, ["m2"]);
  });

  it("forgets nothing when nothing matches, and asks when several do", () => {
    assert.deepEqual((resolve(forget("my favourite colour"), pool, ctx()) as { targets: string[] }).targets, []);
    const r = resolve(forget("staging"), pool, ctx());
    assert.equal(r.kind, "ambiguous");
    assert.deepEqual((r as { options: string[] }).options.sort(), ["m3", "m4"]);
  });

  it("forgets everything about a topic when asked to", () => {
    const r = resolve(forget("staging", "forget everything about staging"), pool, ctx());
    assert.equal(r.kind, "forget");
    assert.deepEqual((r as { targets: string[] }).targets.sort(), ["m3", "m4"]);
  });

  it("never forgets an item that is already gone", () => {
    const r = resolve(forget("docs/NOTES.md"), [item("m1", "the release notes go in docs/NOTES.md", { status: "deleted" })], ctx());
    assert.deepEqual((r as { targets: string[] }).targets, []);
  });
});
