/**
 * The flight recorder: one line for every turn a call decided on, saying why, what it heard, which rule fired and where the
 * time went; words only, kept per conversation in a file that is rotated, and deleted with the conversation.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost as ExecutiveFakeHost } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import type { ChatMessage } from "../src/voice/brain.js";
import { FlightLog, type FlightLine } from "../src/voice/flight.js";
import { handleVoice } from "../src/voice/routes.js";
import { VoiceService } from "../src/voice/service.js";
import { makeRig, type Reply, type Rig } from "../src/voice/testing.js";

const SENTENCES: Record<number, string> = {
  1: "What time is it?",
  5: "to Lisbon next week.",
  6: "Stop.",
  8: "Remind me to call mom.",
  10: "I wanted to ask you about the deployment",
  11: "the one from last Tuesday",
  12: "and what the logs said",
};
const SLOW = { slow: true, speculative: false, local: false };
const LONG =
  "Here is the whole story from the start. First there was a small town by the river with one road in and one road out. " +
  "Then a railway came and the town grew quickly into a city. After that the river was bridged in three places for carts.";

const lastUser = (messages: ChatMessage[]): string => [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

async function finished(rig: Rig, count = 1): Promise<void> {
  assert.ok(await rig.client.until(() => rig.client.of("speak_end").length >= count && rig.session.snapshot().agent === "idle", 30_000), "speech ended");
}

const line = (extra: Partial<FlightLine> = {}): FlightLine => ({
  v: 1,
  at: 1,
  call: "call-1",
  turn: 1,
  endReason: "complete",
  silenceMs: 480,
  speechMs: 900,
  streamer: null,
  reread: "What time is it?",
  text: "What time is it?",
  confidence: 0.9,
  fate: "answered",
  rules: [],
  fragments: 1,
  brain: { runs: 1, cancelled: 0, firstTokenMs: 300 },
  firstAudioMs: 900,
  ...extra,
});

describe("the flight recorder's files", () => {
  async function folder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-flight-"));
    after(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("keeps a conversation's lines in order, one JSON line each, and nothing for a name that is not an id", async () => {
    const log = new FlightLog(await folder());
    log.append("cv_a", line({ turn: 1 }));
    log.append("cv_a", line({ turn: 2, fate: "barge-in" }));
    log.append("cv_b", line({ turn: 1 }));
    log.append("../escape", line());
    assert.deepEqual(log.lines("cv_a").map((l) => [l.turn, l.fate]), [[1, "answered"], [2, "barge-in"]]);
    assert.equal(log.lines("cv_b").length, 1);
    assert.deepEqual(log.lines("../escape"), []);
  });

  it("rotates a file that has grown past its limit, keeping the older half, and never more than two files for a conversation", async () => {
    const dir = await folder();
    const log = new FlightLog(dir, () => undefined, 600);
    for (let i = 1; i <= 12; i++) log.append("cv_a", line({ turn: i }));
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ["cv_a.1.jsonl", "cv_a.jsonl"]);
    const turns = log.lines("cv_a").map((l) => l.turn as number);
    assert.equal(turns.at(-1), 12, "the newest line is the last");
    assert.ok(turns.length < 12 && turns.length >= 4, `${turns.length} lines are kept`);
    assert.deepEqual(turns, [...turns].sort((a, b) => a - b), "in order");
  });

  it("deletes one conversation's record, or every record but the conversations that are kept", async () => {
    const log = new FlightLog(await folder(), () => undefined, 600);
    for (const id of ["cv_a", "cv_b", "cv_c"]) for (let i = 0; i < 8; i++) log.append(id, line());
    log.remove("cv_a");
    assert.deepEqual(log.lines("cv_a"), []);
    assert.ok(log.lines("cv_b").length > 0);
    assert.equal(log.prune(new Set(["cv_b"])), 2, "cv_c's two files went, cv_b's stayed");
    assert.deepEqual(log.lines("cv_c"), []);
    assert.ok(log.lines("cv_b").length > 0);
    log.prune(null);
    assert.deepEqual(log.lines("cv_b"), []);
  });

  it("goes with the conversation when the person deletes it in the Voice tab, one or all", async () => {
    const dir = await folder();
    const clock = { t: Date.UTC(2026, 10, 17, 12, 0, 0) };
    const store = MemoryStore.open(":memory:", { now: () => clock.t });
    store.saveProfile({ enabled: true });
    const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host: new ExecutiveFakeHost(clock) });
    const service = new VoiceService({
      dataDir: dir,
      assistant: () => assistant,
      log: () => undefined,
      engineFactory: () => {
        throw new Error("no engines are needed here");
      },
    });
    after(() => service.close());
    const conversations = service.conversations(true);
    assert.ok(conversations);
    const [a, b] = [conversations.create(null), conversations.create(null)] as [string, string];
    const flight = service.flightLog();
    assert.ok(flight);
    flight.append(a, line());
    flight.append(b, line());
    const noBody = async () => ({}) as Record<string, unknown>;
    const one = await handleVoice(service, { method: "DELETE", path: `/api/voice/conversations/${a}`, query: new URLSearchParams(), body: noBody });
    assert.equal(one.status, 200);
    assert.deepEqual(flight.lines(a), [], "its record went with it");
    assert.equal(flight.lines(b).length, 1, "the other conversation's did not");
    const all = await handleVoice(service, { method: "DELETE", path: "/api/voice/conversations", query: new URLSearchParams("all=1"), body: noBody });
    assert.equal(all.status, 200);
    assert.deepEqual(flight.lines(b), []);
    assert.deepEqual(await readdir(join(dir, "voice", "flight")), []);
  });
});

describe("what a call writes in the flight recorder", () => {
  it("writes a line for each piece of a thought a slow brain was asked about once, and what the one request cost", async () => {
    const rig = await makeRig({ sentences: SENTENCES, brain: SLOW, script: () => ({ ttftMs: 400, text: "The deploy went fine." }) });
    await rig.client.speak(10, 1400);
    await rig.client.quiet(1500);
    await rig.client.speak(11, 1200);
    await rig.client.quiet(1500);
    await rig.client.speak(12, 1200);
    await rig.client.quiet(100);
    await finished(rig);
    assert.deepEqual(rig.flights.map((f) => f.fate), ["merged", "merged", "answered"]);
    const last = rig.flights[2] as FlightLine;
    assert.equal(last.turn, 1);
    assert.equal(last.fragments, 3);
    assert.equal(last.text, "I wanted to ask you about the deployment the one from last Tuesday and what the logs said");
    assert.equal(last.endReason, "unknown");
    assert.ok(last.silenceMs !== null && last.silenceMs >= 700, `${last.silenceMs} ms of quiet`);
    assert.ok(last.speechMs !== null && last.speechMs >= 1000, `${last.speechMs} ms of speech`);
    assert.deepEqual(last.rules, ["held:900"]);
    assert.deepEqual(last.brain, { runs: 1, cancelled: 0, firstTokenMs: last.brain.firstTokenMs });
    assert.ok(last.brain.firstTokenMs !== null && last.brain.firstTokenMs >= 400 && last.brain.firstTokenMs <= 500, `first word after ${last.brain.firstTokenMs} ms`);
    assert.ok(last.firstAudioMs !== null && last.firstAudioMs >= 2000, `first sound ${last.firstAudioMs} ms after they stopped`);
    assert.equal(rig.flights[0]?.turn, null, "a piece that was held has no turn of its own");
    assert.deepEqual(rig.flights[0]?.brain, { runs: 0, cancelled: 0, firstTokenMs: null });
  });

  it("says which request was dropped, and that it was joined to what came next, when the person went on after the brain was asked", async () => {
    const rig = await makeRig({ sentences: SENTENCES, brain: SLOW, script: (m) => ({ ttftMs: 4000, text: lastUser(m).includes("Lisbon") ? "Lisbon, noted." : "One answer." }) });
    await rig.client.speak(8, 1500);
    await rig.client.quiet(1900);
    await rig.client.speak(5, 1500);
    await rig.client.quiet(100);
    await finished(rig);
    assert.deepEqual(rig.flights.map((f) => [f.turn, f.fate]), [[1, "merged"], [1, "answered"]]);
    assert.deepEqual(rig.flights[0]?.rules.filter((r) => !r.startsWith("held")), ["merged-into-next"]);
    assert.deepEqual(rig.flights[0]?.brain, { runs: 1, cancelled: 1, firstTokenMs: null });
    assert.equal(rig.flights[1]?.fragments, 2);
    assert.equal(rig.flights[1]?.text, "Remind me to call mom. to Lisbon next week.");
  });

  it("writes the rule that kept a turn from being answered: nothing could be made of it", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 200, text: "Okay." }) });
    await rig.client.speak(30, 900);
    await rig.client.quiet(100);
    await finished(rig);
    assert.match(rig.tts.said[0]?.text ?? "", /didn't catch/);
    assert.equal(rig.flights.length, 1);
    assert.equal(rig.flights[0]?.fate, "didnt-catch-empty");
    assert.equal(rig.flights[0]?.turn, null);
    assert.equal(rig.flights[0]?.text, "");
    assert.deepEqual(rig.flights[0]?.brain, { runs: 0, cancelled: 0, firstTokenMs: null });
  });

  it("writes a barge-in with the reason the call gave for it, and the answer that was heard in part", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: (m) => (lastUser(m).includes("Stop") ? { ttftMs: 200, text: "Okay." } : { ttftMs: 250, text: LONG }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.playbackActive, 5000), "the assistant began to speak");
    await rig.client.quiet(2000);
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.flights.some((f) => f.turn === 2 && f.fate === "answered"), 20_000), "the interruption was answered");
    const cut = rig.flights.find((f) => f.fate === "barge-in");
    assert.ok(cut, JSON.stringify(rig.flights.map((f) => f.fate)));
    assert.equal(cut.turn, 1);
    assert.deepEqual(cut.rules, ["barge-in: the person spoke (keyword)"]);
    assert.ok(cut.firstAudioMs !== null, "it had been heard");
    assert.equal(rig.flights.at(-1)?.fate, "answered");
    assert.equal(rig.flights.at(-1)?.turn, 2);
  });

  it("writes a line for a turn that was answered by a fast model too, with its own numbers", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 300, text: "It is three o'clock." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    assert.equal(rig.flights.length, 1);
    const [only] = rig.flights as [FlightLine];
    assert.equal(only.fate, "answered");
    assert.equal(only.endReason, "complete");
    assert.equal(only.reread, "What time is it?");
    assert.deepEqual(only.rules, []);
    assert.equal(only.call, "test-call");
    assert.ok(only.brain.firstTokenMs !== null && only.brain.firstTokenMs >= 300 && only.brain.firstTokenMs <= 400);
  });

  it("is only ever words and numbers: a line has exactly these fields, and none of them holds sound", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: (): Reply => ({ ttftMs: 300, text: "It is three o'clock." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    const only = rig.flights[0] as FlightLine;
    assert.deepEqual(Object.keys(only).sort(), [
      "at", "brain", "call", "confidence", "endReason", "fate", "firstAudioMs", "fragments", "reread", "rules", "silenceMs", "speechMs", "streamer", "text", "turn", "v",
    ]);
    assert.ok(JSON.stringify(only).length < 500, `${JSON.stringify(only).length} characters for a turn`);
  });
});
