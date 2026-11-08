import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_EMBEDDING_SETTINGS, EMBEDDING_FILE, EmbeddingRejected, OpenAiEmbedder, dot, parseEmbeddingSettings, readEmbeddingSettings, testEmbedding, writeEmbeddingSettings, type Embedder, type EmbeddingSettings } from "../src/assistant/embed.js";
import { selectByMeaning } from "../src/assistant/meaning.js";
import { scopeKey } from "../src/assistant/rank.js";
import { handleAssistant, type AssistantReply } from "../src/assistant/routes.js";
import { AssistantService, type AssistantEvent } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";

/**
 * Meaning search: notes found by what they mean. The embedding model is replaced by a small deterministic one that puts
 * words of one concept in one dimension, so "vehicle" is near "Subaru" and far from "salary", and the tests can say
 * exactly what is near what. What is tested is everything around the model: when it is asked, what is sent, what is
 * kept, what happens when it is down, slow or refuses, and what the page and a call get.
 */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const CONCEPTS: string[][] = [
  ["car", "vehicle", "subaru", "outback", "drives", "driving", "automobile"],
  ["salary", "pay", "paid", "income", "wage", "earns", "earn"],
  ["dog", "puppy", "pet", "beagle", "walks"],
  ["allergic", "allergy", "peanuts", "nuts", "reaction"],
  ["sleep", "bedtime", "wakes", "alarm", "mornings"],
];
const HASHED = 16;
const DIM = CONCEPTS.length + HASHED;

/** The made-up meaning of a text: a count of its words per concept, plus a faint hash of the words that belong to none. */
function rawVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word === "") continue;
    const concept = CONCEPTS.findIndex((words) => words.includes(word));
    if (concept >= 0) v[concept] = (v[concept] as number) + 1;
    else {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const slot = CONCEPTS.length + (h % HASHED);
      v[slot] = (v[slot] as number) + 0.15;
    }
  }
  return v;
}

function unit(text: string): Float32Array {
  const v = rawVector(text);
  const norm = Math.hypot(...v) || 1;
  return Float32Array.from(v, (x) => x / norm);
}

class FakeEmbedder implements Embedder {
  readonly queries: string[] = [];
  readonly batches: string[][] = [];
  /** Answers questions with a connection error, as a server that is down does. */
  failQueries = false;
  /** Never answers a question unless the caller gives up. */
  hangQueries = false;
  /** Texts the server refuses outright (a 4xx). */
  refuse: RegExp | null = null;
  /** Runs while a batch is being read: a note can be edited in that time. */
  duringEmbed: (() => void) | null = null;

  constructor(readonly id = "fake@test") {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.batches.push([...texts]);
    this.duringEmbed?.();
    if (this.refuse && texts.some((t) => this.refuse?.test(t))) throw new EmbeddingRejected(400);
    return texts.map(unit);
  }

  async query(text: string, signal?: AbortSignal): Promise<Float32Array> {
    this.queries.push(text);
    if (this.failQueries) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    if (this.hangQueries) await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return unit(text);
  }
}

const SETTINGS: EmbeddingSettings = { baseUrl: "http://127.0.0.1:9/v1", model: "fake", ...DEFAULT_EMBEDDING_SETTINGS };

interface Rig {
  service: AssistantService;
  store: MemoryStore;
  embedder: FakeEmbedder;
  logs: string[];
  clock: { t: number };
  /** Asks a question a minute after the last thing that happened (or `after` ms), waiting no longer than `timeoutMs` for the server. */
  ask: (text: string, timeoutMs?: number, after?: number) => ReturnType<AssistantService["prepareTurnAsync"]>;
  remember: (text: string) => string;
}

function rig(options: { embedder?: FakeEmbedder; settings?: Partial<EmbeddingSettings> } = {}): Rig {
  const clock = { t: T0 };
  const logs: string[] = [];
  const embedder = options.embedder ?? new FakeEmbedder();
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true });
  const service = new AssistantService(store, { log: (l) => logs.push(l), emit: () => undefined, now: () => clock.t, embedding: { settings: { ...SETTINGS, ...options.settings }, embedder } });
  return {
    service, store, embedder, logs, clock,
    ask: (text, timeoutMs, after = 60_000) => {
      clock.t += after;
      return service.prepareTurnAsync({ sessionId: "s1", text, project: "/work/atlas", account: null }, timeoutMs === undefined ? {} : { timeoutMs });
    },
    remember: (text) => store.remember({ text }).id,
  };
}

const NOTES = ["The user drives a Subaru Outback", "The user earns a salary paid on the fifth", "The user has a beagle puppy", "The user is allergic to peanuts"];

async function filled(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  for (const text of NOTES) r.remember(text);
  await r.service.indexSome();
  return r;
}

describe("finding a note by what it means", () => {
  it("finds the note for a question that shares no word with it, where the words alone find nothing", async () => {
    const r = await filled();
    const by = await r.ask("what vehicle do I own?");
    assert.ok(by.prefix?.includes("Subaru Outback"), by.prefix ?? "(no block)");
    // The same question, by words alone: nothing in the note is in the question.
    const plain = r.service.prepareTurn({ sessionId: "s2", text: "what vehicle do I own?", project: "/work/atlas", account: null });
    assert.ok(!(plain.prefix ?? "").includes("Subaru"), "the control: no word is shared, so words do not find it");
    r.service.close();
  });

  it("says in the audit trail that it was found by meaning, not by text", async () => {
    const r = await filled();
    const out = r.service.previewAsync({ sessionId: "s1", text: "what vehicle do I own?", project: "/work/atlas", account: null });
    const found = (await out).memories.find((m) => m.item.text.includes("Subaru"));
    assert.ok(found, "the note was found");
    assert.ok(found.why.includes("close in meaning"), JSON.stringify(found.why));
    assert.ok(!found.why.includes("text match"));
    r.service.close();
  });

  it("adds nothing that is not near, however many notes there are", async () => {
    const r = await filled();
    const out = await r.ask("what is the weather like in the mountains?");
    assert.ok(!(out.prefix ?? "").includes("Subaru") && !(out.prefix ?? "").includes("beagle") && !(out.prefix ?? "").includes("peanuts"), out.prefix ?? "(no block)");
    r.service.close();
  });

  it("adds no more than the few it was told to, the nearest first", async () => {
    const r = rig({ settings: { most: 1 } });
    r.remember("The user drives a Subaru Outback");
    r.remember("The user is driving an automobile to work");
    await r.service.indexSome();
    const out = await r.ask("which car is it?");
    const mentioned = ["Subaru", "automobile"].filter((w) => (out.prefix ?? "").includes(w));
    assert.equal(mentioned.length, 1, `one note by meaning, not both: ${out.prefix}`);
    r.service.close();
  });

  it("holds the cosine threshold the user set: just above what the note scores it is left out, just below it is found", async () => {
    const question = "what vehicle do I own?";
    const score = dot(unit(question), unit(NOTES[0] as string));
    assert.ok(score > 0.6 && score < 1, `the made-up model puts them near each other (${score})`);
    const strict = await filled({ settings: { minCosine: score + 0.01, standoutCosine: null } });
    const none = await strict.ask(question);
    assert.ok(!(none.prefix ?? "").includes("Subaru"), none.prefix ?? "(no block)");
    strict.service.close();
    const loose = await filled({ settings: { minCosine: score - 0.01, standoutCosine: null } });
    assert.ok((await loose.ask(question)).prefix?.includes("Subaru"));
    loose.service.close();
  });

  it("also adds the note that stands out, though it is not as near as the bar asks", async () => {
    const r = await filled({ settings: { minCosine: 0.99 } });
    const out = await r.ask("what vehicle do I own?");
    assert.ok(out.prefix?.includes("Subaru"), "the nearest note is far ahead of the rest, so it is the answer");
    r.service.close();
    const off = await filled({ settings: { minCosine: 0.99, standoutCosine: null } });
    assert.ok(!((await off.ask("what vehicle do I own?")).prefix ?? "").includes("Subaru"), "and with that reason left out, it is not added");
    off.service.close();
  });

  it("adds nothing when no note stands out: two notes about the same thing are about as near as each other", async () => {
    const r = rig({ settings: { minCosine: 0.99 } });
    r.remember("The user drives a Subaru Outback");
    r.remember("The user rides in an automobile every day");
    await r.service.indexSome();
    const out = await r.ask("what vehicle do I own?");
    assert.ok(!(out.prefix ?? "").includes("Subaru") && !(out.prefix ?? "").includes("automobile"), out.prefix ?? "(no block)");
    r.service.close();
  });

  it("looks a short follow-up up by meaning with the question before it", async () => {
    const r = await filled();
    await r.ask("what vehicle do I own?");
    const follow = await r.ask("and the colour?");
    assert.ok(r.embedder.queries.some((q) => q.includes("vehicle") && q.includes("colour")), JSON.stringify(r.embedder.queries));
    assert.ok(follow.prefix?.includes("Subaru"), follow.prefix ?? "(no block)");
    r.service.close();
  });
});

describe("choosing which notes to add", () => {
  const n = (id: string, cosine: number) => ({ id, cosine });
  const pick = (notes: { id: string; cosine: number }[], found: string[], s: Parameters<typeof selectByMeaning>[2]) => selectByMeaning(notes, new Set(found), s).map((x) => x.id);
  const OFF = Infinity;

  it("adds the notes at least as near as the bar, nearest first, up to the most it was told", () => {
    const notes = [n("a", 0.9), n("b", 0.8), n("c", 0.7), n("d", 0.3)];
    assert.deepEqual(pick(notes, [], { bar: 0.65, floor: OFF, gap: 0, most: 2 }), ["a", "b"]);
    assert.deepEqual(pick(notes, [], { bar: 0.65, floor: OFF, gap: 0, most: 6 }), ["a", "b", "c"]);
    assert.deepEqual(pick(notes, [], { bar: 0.95, floor: OFF, gap: 0, most: 6 }), []);
  });

  it("does not add what words already found, and does not count it against the most", () => {
    const notes = [n("a", 0.9), n("b", 0.8), n("c", 0.7)];
    assert.deepEqual(pick(notes, ["a"], { bar: 0.65, floor: OFF, gap: 0, most: 2 }), ["b", "c"]);
  });

  it("adds the nearest note when it stands out, below the bar: clearly nearer than the next, and near enough", () => {
    const s = { bar: 0.65, floor: 0.5, gap: 0.15, most: 2 };
    assert.deepEqual(pick([n("a", 0.55), n("b", 0.38)], [], s), ["a"]);
    assert.deepEqual(pick([n("a", 0.55), n("b", 0.5)], [], s), [], "not clearly ahead of the next: nothing answers this more than the rest");
    assert.deepEqual(pick([n("a", 0.45), n("b", 0.1)], [], s), [], "ahead, but not near enough to be an answer");
    assert.deepEqual(pick([n("a", 0.55)], [], s), ["a"], "the only note can stand out, if it is near enough");
    assert.deepEqual(pick([], [], s), []);
  });

  it("leaves that reason out when asked to, and when words found the note", () => {
    assert.deepEqual(pick([n("a", 0.55), n("b", 0.38)], [], { bar: 0.65, floor: OFF, gap: 0.15, most: 2 }), []);
    assert.deepEqual(pick([n("a", 0.55), n("b", 0.38)], ["a"], { bar: 0.65, floor: 0.5, gap: 0.15, most: 2 }), []);
  });

  it("adds a note once when it is both far ahead and above the bar, and counts it once", () => {
    const s = { bar: 0.65, floor: 0.5, gap: 0.15, most: 2 };
    assert.deepEqual(pick([n("a", 0.8), n("b", 0.5)], [], s), ["a"]);
    assert.deepEqual(pick([n("a", 0.8), n("b", 0.7), n("c", 0.66)], [], s), ["a", "b"], "the bar's own notes follow, up to the most");
    assert.deepEqual(pick([n("a", 0.55), n("b", 0.38)], [], { ...s, most: 1 }), ["a"]);
  });
});

describe("what is kept, and what is sent", () => {
  it("sends nothing anywhere while meaning search is off", async () => {
    const store = MemoryStore.open(":memory:", { now: () => T0 });
    store.saveProfile({ enabled: true });
    const service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => T0 });
    store.remember({ text: "The user drives a Subaru Outback" });
    await service.indexSome();
    const out = await service.prepareTurnAsync({ sessionId: "s", text: "what vehicle do I own?", project: null, account: null });
    assert.ok(!(out.prefix ?? "").includes("Subaru"), "without a model, only words find notes");
    assert.equal(service.embeddingStatus().configured, false);
    assert.equal(store.vectorStats("fake@test").indexed, 0);
    service.close();
  });

  it("does not ask the server about a question while no note has a vector yet", async () => {
    const r = rig();
    r.remember("The user drives a Subaru Outback");
    await r.ask("what vehicle do I own?");
    assert.deepEqual(r.embedder.queries, [], "nothing to compare with, so nothing was sent");
    r.service.close();
  });

  it("never sends a message that looks like a secret", async () => {
    const r = await filled();
    const out = await r.ask("my token is sk-abcdefghijklmnopqrstuvwxyz012345, what vehicle do I own?");
    assert.deepEqual(r.embedder.queries, [], "the question went nowhere");
    assert.ok(!(out.prefix ?? "").includes("Subaru"), "and the words alone did not find the note");
    r.service.close();
  });

  it("keeps the vector of a note only while the note exists as it was", async () => {
    const r = await filled();
    const model = r.embedder.id;
    assert.equal(r.store.vectorStats(model).indexed, 4);
    const id = r.store.list({ status: "active", q: "Subaru" }).items[0]?.id as string;
    // Edited: the old words' vector is gone at once, and the note is read again.
    const rev = (r.store.getItem(id) as { rev: number }).rev;
    r.store.edit(id, { text: "The user drives a Volvo estate" }, rev);
    assert.equal(r.store.vectorStats(model).indexed, 3, "the vector of the words that were replaced is erased with them");
    await r.service.indexSome();
    assert.equal(r.store.vectorStats(model).indexed, 4);
    // Forgotten: the vector goes with the note, and the note is never found again by meaning.
    r.store.forget([id]);
    assert.equal(r.store.vectorStats(model).indexed, 3);
    const out = await r.ask("what vehicle do I own?");
    assert.ok(!(out.prefix ?? "").includes("Volvo"), out.prefix ?? "(no block)");
    // Wiped: nothing is left.
    r.store.wipe();
    assert.equal(r.store.vectorStats(model).indexed, 0);
    r.service.close();
  });

  it("reads the vectors from the file once for many turns, and again only after a note or a vector changed", async () => {
    const r = await filled();
    await r.ask("what vehicle do I own?");
    const loads = r.store.vectorLoads;
    await r.ask("what is my dog's name?");
    await r.ask("when am I paid?");
    await r.ask("is there anything I should not eat?");
    assert.equal(r.store.vectorLoads, loads, "three more turns, and not one more read of the file");
    r.remember("The user plays the cello on Sundays");
    await r.ask("which instrument?");
    assert.equal(r.store.vectorLoads, loads + 1, "a note was added: read again");
    await r.service.indexSome();
    await r.ask("which instrument?");
    assert.equal(r.store.vectorLoads, loads + 2, "a vector was made: read again");
    r.service.close();
  });

  it("keeps no vector for a note that was replaced, and counts only the notes that are believed", async () => {
    const r = rig();
    const say = (message: string) => {
      r.clock.t += 60_000;
      return r.store.capture({ message, ctx: { role: "user", sessionId: "s1", thread: "s1", observedAt: r.clock.t, offsetMinutes: 0 } });
    };
    say("My name is Aleff");
    await r.service.indexSome();
    assert.equal(r.store.vectorStats(r.embedder.id).indexed, 1);
    say("My name is Aleff Ferreira");
    assert.equal(r.store.list({ status: "history" }).total, 1, "the first is history now");
    assert.equal(r.store.vectorStats(r.embedder.id).indexed, 0, "its vector no longer counts as a note that can be found");
    assert.equal(r.store.pruneVectors(), 1, "and is removed, since nothing asks for it");
    assert.equal(r.store.pruneVectors(), 0);
    await r.service.indexSome();
    assert.equal(r.store.vectorStats(r.embedder.id).indexed, 1, "the note that replaced it is read");
    r.service.close();
  });

  it("gives a note no vector when it changed while its vector was being made", async () => {
    const r = rig();
    const before = "The user drives a Subaru Outback";
    const after = "The user has a beagle puppy";
    const id = r.remember(before);
    let done = false;
    r.embedder.duringEmbed = () => {
      if (done) return;
      done = true;
      r.store.edit(id, { text: after }, (r.store.getItem(id) as { rev: number }).rev);
    };
    await r.service.indexSome();
    // The vector made from the old words must not end up attached to the new ones: the note was read again.
    const kept = r.store.vectorsFor(r.embedder.id, [scopeKey({ kind: "global", key: "" })], ["active"]);
    assert.equal(kept.length, 1);
    assert.ok(dot((kept[0] as { vec: Float32Array }).vec, unit(after)) > 0.999, "the vector is of the words the note has now");
    assert.ok(dot((kept[0] as { vec: Float32Array }).vec, unit(before)) < 0.5, "and not of the words it had");
    assert.equal(r.embedder.batches.length, 2, "it was read twice: the first answer was discarded");
    r.service.close();
  });

  it("switching it off erases every vector, and changing the model erases the old model's", async () => {
    const r = await filled();
    assert.equal(r.store.vectorStats("fake@test").indexed, 4);
    const other = new FakeEmbedder("other@test");
    r.service.configureEmbeddings({ ...SETTINGS, model: "other" }, other);
    assert.equal(r.store.vectorStats("fake@test").indexed, 0, "vectors of the model that was replaced are gone");
    await r.service.indexSome();
    assert.equal(r.store.vectorStats("other@test").indexed, 4, "the new model reads every note again");
    r.service.configureEmbeddings(null);
    assert.equal(r.store.vectorStats("other@test").indexed, 0, "switched off: nothing of the notes' meaning is kept");
    assert.equal(r.service.embeddingStatus().configured, false);
    r.service.close();
  });

  it("reads the notes in the background soon after they are written", async () => {
    const r = rig();
    r.remember("The user drives a Subaru Outback");
    r.service.announce({ reason: "memory" });
    const deadline = Date.now() + 4000;
    while (r.store.vectorStats(r.embedder.id).indexed === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(r.store.vectorStats(r.embedder.id).indexed, 1, "found by meaning moments after it was said");
    r.service.close();
  });

  it("leaves a note the server refuses to the words, and reads the rest", async () => {
    const embedder = new FakeEmbedder();
    embedder.refuse = /REFUSED/;
    const r = rig({ embedder });
    r.remember("The user drives a Subaru Outback");
    r.remember("REFUSED this is the note the server will not read");
    r.remember("The user has a beagle puppy");
    await r.service.indexSome();
    const status = r.service.embeddingStatus();
    assert.equal(status.indexed, 2);
    assert.equal(status.skipped, 1);
    assert.equal(status.pending, 0);
    assert.equal(status.paused, false, "a refused note is not a server that is down");
    const before = embedder.batches.length;
    await r.service.indexSome();
    assert.equal(embedder.batches.length, before, "it is not asked again while the note says the same");
    r.service.close();
  });
});

describe("when the server is down, slow or wrong", () => {
  it("answers with words, loses nothing, and leaves the server alone for a while", async () => {
    const r = await filled();
    r.embedder.failQueries = true;
    const first = await r.ask("where do I keep the beagle puppy?");
    assert.ok(first.prefix?.includes("beagle puppy"), "the words still found it");
    assert.equal(r.embedder.queries.length, 1);
    assert.equal(r.service.embeddingStatus().paused, true);
    assert.match(r.service.embeddingStatus().error ?? "", /ECONNREFUSED/);
    await r.ask("what vehicle do I own?", undefined, 1000);
    assert.equal(r.embedder.queries.length, 1, "a server that just failed is not asked again for every turn");
    r.embedder.failQueries = false;
    const later = await r.ask("what vehicle do I own?", undefined, 20_000);
    assert.equal(r.embedder.queries.length, 2, "asked again once the pause is over");
    assert.ok(later.prefix?.includes("Subaru"), "and it works again");
    assert.equal(r.service.embeddingStatus().paused, false);
    assert.equal(r.logs.filter((l) => /meaning search is paused/.test(l)).length, 1, "said once, not on every turn");
    r.service.close();
  });

  it("does not hold a turn longer than it was told to wait for a slow server", async () => {
    const r = await filled();
    r.embedder.hangQueries = true;
    const started = Date.now();
    const out = await r.ask("where do I keep the beagle puppy?", 40);
    assert.ok(Date.now() - started < 1500, `waited ${Date.now() - started} ms`);
    assert.ok(out.prefix?.includes("beagle puppy"), "the words answered");
    assert.match(r.service.embeddingStatus().error ?? "", /did not answer in time/);
    r.service.close();
  });

  it("pauses longer each time the server fails, up to a limit", async () => {
    const r = await filled();
    r.embedder.failQueries = true;
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await r.ask(`attempt ${i} about the vehicle`);
      const paused = (r.service as unknown as { embedPausedUntil: number }).embedPausedUntil;
      waits.push(paused - r.clock.t);
      r.clock.t = paused + 1;
    }
    assert.deepEqual(waits.slice(0, 4), [15_000, 30_000, 60_000, 120_000]);
    assert.ok(Math.max(...waits) <= 5 * 60_000, JSON.stringify(waits));
    r.service.close();
  });
});

describe("the settings", () => {
  it("accepts good settings and refuses bad ones with the field that is wrong", () => {
    assert.deepEqual(parseEmbeddingSettings({ baseUrl: " http://127.0.0.1:8792/v1 ", model: " qwen3-embedding " }), {
      baseUrl: "http://127.0.0.1:8792/v1", model: "qwen3-embedding", queryPrefix: "", apiKeyEnv: null, minCosine: 0.65, standoutCosine: 0.5, standoutLead: 0.15, most: 2,
    });
    assert.equal(parseEmbeddingSettings({ baseUrl: "http://x/v1", model: "m", standoutCosine: null }).standoutCosine, null, "that reason can be left out");
    const field = (raw: unknown): string => {
      try {
        parseEmbeddingSettings(raw);
      } catch (error) {
        return (error as { field?: string }).field ?? "?";
      }
      return "none";
    };
    assert.equal(field({ baseUrl: "ftp://x/v1", model: "m" }), "baseUrl");
    assert.equal(field({ baseUrl: "http://x/v1", model: "" }), "model");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", minCosine: 0.1 }), "minCosine");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", minCosine: 0.99 }), "minCosine");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", standoutCosine: 0.1 }), "standoutCosine");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", standoutLead: 0.9 }), "standoutLead");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", standoutLead: 0 }), "standoutLead");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", most: 0 }), "most");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", most: 2.5 }), "most");
    assert.equal(field({ baseUrl: "http://x/v1", model: "m", apiKeyEnv: "not a name" }), "apiKeyEnv");
    assert.equal(field("nope"), "embeddings");
  });

  it("keeps them in the data folder and removes the file when meaning search is switched off", () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-embed-"));
    try {
      assert.equal(readEmbeddingSettings(dir), null);
      const settings = parseEmbeddingSettings({ baseUrl: "http://127.0.0.1:8792/v1", model: "m", apiKeyEnv: "SOME_KEY", queryPrefix: "Query: " });
      writeEmbeddingSettings(dir, settings);
      assert.deepEqual(readEmbeddingSettings(dir), settings);
      assert.ok(!readFileSync(join(dir, EMBEDDING_FILE), "utf8").includes("secret"), "only the name of a variable is kept, never a key");
      writeEmbeddingSettings(dir, null);
      assert.equal(existsSync(join(dir, EMBEDDING_FILE)), false);
      assert.equal(readEmbeddingSettings(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------ against a real HTTP server

interface Seen {
  auth: string | undefined;
  inputs: string[];
}

function startEmbeddingServer(options: { key?: string } = {}): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      seen.push({ auth: req.headers.authorization, inputs: body.input });
      if (options.key && req.headers.authorization !== `Bearer ${options.key}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "no key" }));
        return;
      }
      // Not normalised, and in reverse order with their indexes: the client must put them right.
      const data = body.input.map((text, index) => ({ index, embedding: rawVector(text).map((x) => x * 7) })).reverse();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

describe("the embedding client, against a server that speaks the protocol", () => {
  it("puts the vectors in order, normalises them, sends the key it was given, and marks only questions", async () => {
    const { server, url, seen } = await startEmbeddingServer({ key: "k-secret-123" });
    servers.push(server);
    const embedder = new OpenAiEmbedder({ settings: { ...SETTINGS, baseUrl: url, queryPrefix: "Question: " }, apiKey: "k-secret-123" });
    const vectors = await embedder.embed(["The user drives a Subaru Outback", "The user has a beagle puppy"]);
    assert.equal(vectors.length, 2);
    for (const [i, text] of ["The user drives a Subaru Outback", "The user has a beagle puppy"].entries()) {
      const expected = unit(text);
      const got = vectors[i] as Float32Array;
      assert.ok(Math.abs(Math.hypot(...got) - 1) < 1e-5, "normalised");
      assert.ok(got.every((x, j) => Math.abs(x - (expected[j] as number)) < 1e-5), `vector ${i} belongs to its text`);
    }
    await embedder.query("which car?");
    assert.deepEqual(seen[0]?.inputs, ["The user drives a Subaru Outback", "The user has a beagle puppy"], "notes go as they are");
    assert.deepEqual(seen[1]?.inputs, ["Question: which car?"], "a question is marked as one");
    assert.equal(seen[0]?.auth, "Bearer k-secret-123");
    assert.ok(!embedder.id.includes("k-secret-123") && !embedder.id.includes("127.0.0.1"), "the id that is stored names no address and no key");
  });

  it("treats a refusal as a refusal, and a dead address as an error that says so", async () => {
    const { server, url } = await startEmbeddingServer({ key: "right" });
    servers.push(server);
    const wrong = new OpenAiEmbedder({ settings: { ...SETTINGS, baseUrl: url }, apiKey: "wrong" });
    await assert.rejects(wrong.embed(["x"]), (error: unknown) => error instanceof EmbeddingRejected && error.status === 401);
    const tried = await testEmbedding({ ...SETTINGS, baseUrl: "http://127.0.0.1:1/v1" });
    assert.equal(tried.ok, false);
    assert.ok(!tried.ok && tried.error.length > 0);
  });

  it("reports whether a server works, without needing the assistant", async () => {
    const { server, url } = await startEmbeddingServer();
    servers.push(server);
    const tried = await testEmbedding({ ...SETTINGS, baseUrl: url });
    assert.ok(tried.ok && tried.dimensions === DIM, JSON.stringify(tried));
  });
});

describe("the page's routes for meaning search", () => {
  const KEY_VALUE = "k-should-never-be-shown-4711";

  async function call(service: AssistantService | null, method: string, path: string, body: Record<string, unknown> = {}): Promise<AssistantReply> {
    const url = new URL(path, "http://localhost");
    const reply = await handleAssistant({ get: () => service, unavailable: () => null }, { method, path: url.pathname, query: url.searchParams, body: async () => body });
    assert.ok(reply, `${method} ${path} was not an assistant route`);
    return reply;
  }

  it("tries a server without creating the assistant, and says what is wrong when it cannot", async () => {
    const { server, url } = await startEmbeddingServer();
    servers.push(server);
    let opened = 0;
    const access = { get: () => { opened += 1; return null; }, unavailable: () => null };
    const run = (body: Record<string, unknown>) => handleAssistant(access, { method: "POST", path: "/api/assistant/embeddings/test", query: new URLSearchParams(), body: async () => body });
    const ok = await run({ baseUrl: url, model: "m" });
    assert.deepEqual(ok?.body, { ok: true, dimensions: DIM, ms: (ok?.body as { ms: number }).ms });
    const dead = await run({ baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    assert.equal((dead?.body as { ok: boolean }).ok, false);
    const bad = await run({ baseUrl: "nope", model: "m" });
    assert.equal(bad?.status, 400);
    assert.equal(opened, 0, "trying a server touches no memory, so the assistant was never opened");
  });

  it("shows nothing configured for an assistant that has never been used", async () => {
    const reply = await call(null, "GET", "/api/assistant/embeddings");
    assert.equal(reply.status, 200);
    assert.equal((reply.body as { configured: boolean }).configured, false);
  });

  it("switches meaning search on, shows its progress without a key, finds notes by meaning, and switches it off", async () => {
    const { server, url, seen } = await startEmbeddingServer({ key: KEY_VALUE });
    servers.push(server);
    const dir = mkdtempSync(join(tmpdir(), "ancilla-embed-routes-"));
    process.env["ANCILLA_TEST_EMBED_KEY"] = KEY_VALUE;
    const events: AssistantEvent[] = [];
    const open = () => AssistantService.open(dir, { log: () => undefined, emit: (e) => events.push(e) });
    let service = open();
    try {
      service.store.saveProfile({ enabled: true });
      for (const text of NOTES) service.store.remember({ text });
      const bad = await call(service, "PUT", "/api/assistant/embeddings", { baseUrl: "ftp://nope", model: "m" });
      assert.equal(bad.status, 400);
      assert.equal((bad.body as { field: string }).field, "baseUrl");

      const put = await call(service, "PUT", "/api/assistant/embeddings", { baseUrl: url, model: "fake", apiKeyEnv: "ANCILLA_TEST_EMBED_KEY" });
      assert.equal(put.status, 200);
      assert.equal((put.body as { configured: boolean; keyPresent: boolean }).configured, true);
      assert.equal((put.body as { keyPresent: boolean }).keyPresent, true);
      assert.ok(!JSON.stringify(put.body).includes(KEY_VALUE), "the page is told whether a key is set, never the key");

      const deadline = Date.now() + 5000;
      let status = (await call(service, "GET", "/api/assistant/embeddings")).body as { indexed: number; pending: number };
      while (status.indexed < NOTES.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = (await call(service, "GET", "/api/assistant/embeddings")).body as { indexed: number; pending: number };
      }
      assert.equal(status.indexed, NOTES.length);
      assert.equal(status.pending, 0);
      assert.ok(seen.every((s) => s.auth === `Bearer ${KEY_VALUE}`), "every request carried the key the variable holds");

      const preview = await call(service, "POST", "/api/assistant/preview", { text: "what vehicle do I own?" });
      const memories = (preview.body as { memories: { text: string; why: string[] }[] }).memories;
      assert.ok(memories.some((m) => m.text.includes("Subaru") && m.why.includes("close in meaning")), JSON.stringify(memories));

      // It survives a restart: the settings are in the data folder and the vectors in the database.
      service.close();
      service = open();
      const again = service.embeddingStatus();
      assert.equal(again.configured, true);
      assert.equal(again.indexed, NOTES.length);

      const off = await call(service, "DELETE", "/api/assistant/embeddings");
      assert.equal((off.body as { configured: boolean; indexed: number }).configured, false);
      assert.equal((off.body as { indexed: number }).indexed, 0);
      assert.equal(existsSync(join(dir, EMBEDDING_FILE)), false);
      service.close();
      service = open();
      assert.equal(service.embeddingStatus().configured, false, "off stays off after a restart");
    } finally {
      delete process.env["ANCILLA_TEST_EMBED_KEY"];
      service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a call", () => {
  function voiceRig(embedder: FakeEmbedder): { host: AssistantVoiceHost; r: Rig } {
    const r = rig({ embedder });
    const conversations = new ConversationStore(r.store, () => r.clock.t);
    const conversationId = conversations.create(null);
    const host = new AssistantVoiceHost({ assistant: r.service, conversations, conversationId, settings: () => ({ ...DEFAULT_VOICE_SETTINGS }), hub: new TaskHub(), project: () => null, log: () => undefined });
    return { host, r };
  }

  it("is told the notes nearest what was said in meaning", async () => {
    const { host, r } = voiceRig(new FakeEmbedder());
    for (const text of NOTES) r.remember(text);
    await r.service.indexSome();
    const block = await host.context("what vehicle do I own?", "voice");
    assert.ok(block?.includes("Subaru Outback"), block ?? "(no block)");
    r.service.close();
  });

  it("does not wait for a slow embedding server: a call is about the next half second", async () => {
    const embedder = new FakeEmbedder();
    const { host, r } = voiceRig(embedder);
    for (const text of NOTES) r.remember(text);
    await r.service.indexSome();
    embedder.hangQueries = true;
    const started = Date.now();
    const block = await host.context("where do I keep the beagle puppy?", "voice");
    const took = Date.now() - started;
    assert.ok(took < 900, `the turn waited ${took} ms`);
    assert.ok(block?.includes("beagle puppy"), "and the words still answered");
    r.service.close();
  });
});
