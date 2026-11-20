/**
 * Whole calls with the spoken-interruption pilot on, on the test doubles in virtual time: a stop word silences the voice at
 * once, keeps its place, and cuts the reply off only when it is read; a sound of listening, a cough or an echo pauses it for
 * a moment and it goes on from the same sample; a correction is answered once, from what was heard; nothing a person says
 * over the voice approves or cancels anything; and a pause cannot outlive the call, the microphone or the connection.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrainCapabilities, BrainEvent, BrainProvider, BrainRequest, ChatMessage } from "../src/voice/brain.js";
import { ManualScheduler } from "../src/voice/scheduler.js";
import { VoiceSession } from "../src/voice/session.js";
import { FakeAsr, FakeHost, FakeTts, FakeVad, SimClient, makeRig, type Reply } from "../src/voice/testing.js";

const SENTENCES: Record<number, string> = {
  1: "What time is it?",
  6: "Stop",
  7: "Yeah",
  8: "No, I meant Tuesday please",
  9: "Tell me something else",
};
const LONG =
  "The weather in Lisbon tomorrow will be mostly sunny. A light breeze comes from the north. In the evening it cools down. " +
  "Bring a jacket if you plan to eat outside. On Thursday clouds roll in from the coast. Friday looks bright again.";

/** What the person said: `content` has the date and the state of the call in front of it (a weekday would match "Tuesday"). */
const lastUser = (m: ReadonlyArray<{ role: string; content: string; rawUserText?: string }>): string => {
  const last = [...m].reverse().find((x) => x.role === "user");
  return last?.rawUserText ?? last?.content ?? "";
};

function script(m: ChatMessage[]): Reply {
  const said = lastUser(m);
  if (said.includes("Tuesday")) return { ttftMs: 200, text: "Done. Tuesday it is." };
  if (said.includes("Stop")) return { ttftMs: 200, text: "Okay." };
  return { ttftMs: 250, text: LONG };
}

const on = (extra: Partial<Parameters<typeof makeRig>[0]> = {}) =>
  makeRig({ sentences: SENTENCES, script, config: { interruptPilot: true }, hello: { pause: true }, ...extra });

type Rig = Awaited<ReturnType<typeof makeRig>>;

/** The person asks, and the assistant is speaking a long answer a moment later. */
async function speaking(rig: Rig): Promise<void> {
  await rig.client.speak(1, 900);
  await rig.client.quiet(100);
  assert.ok(await rig.client.until(() => rig.client.playbackActive, 5000), "the assistant began to speak");
  await rig.client.quiet(2000);
}

const types = (rig: Rig): string[] => rig.client.messages.map((m) => m.msg.type);
const sentSamples = (rig: Rig, utterance: number): number => rig.client.audioIn.filter((a) => a.msg.utterance === utterance).reduce((n, a) => n + a.msg.samples, 0);

describe("a stop word over the reply, with the pilot on", () => {
  it("silences the voice within a few frames of the sound, keeps its place, and cuts the reply off when the word is read", async () => {
    const rig = await on();
    await speaking(rig);
    const before = rig.client.playedSamples;
    const startedAt = rig.sched.now();
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    const pause = rig.client.of("pause")[0];
    assert.ok(pause, "the voice was paused");
    assert.ok(pause.at - startedAt <= 200, `paused ${pause.at - startedAt} ms after the sound began`);
    assert.equal(rig.client.pauseLog[0]?.paused, true);
    assert.ok(await rig.client.until(() => rig.client.of("interrupted").length > 0, 5000), "the reply was cut off when the word was read");
    assert.ok(types(rig).indexOf("pause") < types(rig).indexOf("interrupted"));
    const cut = rig.client.of("interrupted")[0];
    assert.ok(cut && cut.msg.heard.length > 0, "what was heard is known");
    // not a sample was played between the pause and the cut, and what was played is what the page said at the pause
    assert.equal(rig.client.playedSamples, rig.client.pauseLog[0]?.played);
    assert.ok((rig.client.pauseLog[0]?.played ?? 0) > before, "it had been speaking up to then");
    assert.equal(rig.client.paused, false);
  });

  it("answers nothing: a stop is silence, the history says where it was cut and the work that was running goes on", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.flights.some((f) => f.fate === "stop-silenced"), 8000), JSON.stringify(rig.flights.map((f) => f.fate)));
    await rig.client.quiet(3000);
    assert.equal(rig.brain.requests.length, 1, "the model was asked once, for the first question");
    assert.equal(rig.client.of("speaking").filter((s) => s.msg.utterance > 1).length, 0, "nothing was said after the stop");
    const history = rig.session.snapshot().history;
    assert.ok(history.some((h) => h.role === "assistant" && h.content.includes("[the user interrupted here]")));
    assert.equal(history[history.length - 1]?.content, "Stop");
    assert.equal(rig.host.toolCalls.length, 0, "no task was touched");
  });

  it("does not approve anything, whatever is said, and a stop is not a command to cancel", async () => {
    const rig = await on();
    const decided: Array<[string, boolean]> = [];
    rig.host.pendingApproval = () => ({ id: "a1", kind: "launch", title: "Run the tests", detail: "npm test", allowLabel: "Allow", denyLabel: "Deny", inFlightMuse: false }) as never;
    rig.host.decideApproval = async (id, allow) => {
      decided.push([id, allow]);
      return { ok: true, message: "done" };
    };
    await speaking(rig);
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("interrupted").length > 0, 5000);
    await rig.client.quiet(2000);
    assert.deepEqual(decided, []);
  });
});

describe("a sound that is not for the assistant, with the pilot on", () => {
  it("pauses the voice for a sound of listening and goes on from the same place, losing nothing", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(7, 400);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.of("resume").length > 0, 5000), "the voice went on");
    assert.equal(rig.client.of("interrupted").length, 0);
    assert.ok(await rig.client.until(() => rig.client.of("speak_end").length > 0, 60_000), "the reply was finished");
    // every sample that was sent was played: the pause took none away and added none
    assert.equal(rig.client.playedSamples, sentSamples(rig, 1));
    assert.equal(rig.brain.requests.length, 1);
  });

  it("pauses the voice for a cough, which says nothing, and goes on after the recogniser has had its say", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(40, 150); // a pitch no sentence has
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.of("resume").length > 0, 5000));
    assert.equal(rig.client.of("interrupted").length, 0);
    assert.equal(rig.client.of("user").filter((u) => u.msg.source === "voice").length, 1, "only the first question was a turn");
    assert.ok(await rig.client.until(() => rig.client.of("speak_end").length > 0, 60_000));
  });

  it("is not paused by its own echo", async () => {
    const rig = await on();
    await speaking(rig);
    rig.client.echoAmp = 0.004;
    await rig.client.quiet(3000);
    assert.equal(rig.client.of("pause").length, 0);
    assert.equal(rig.client.of("interrupted").length, 0);
  });

  it("takes yes as an answer, not a sound of listening, while an approval is waiting; and approves nothing", async () => {
    const rig = await on({ script: (m) => (lastUser(m).includes("Yeah") ? { ttftMs: 200, text: "Good." } : { ttftMs: 250, text: LONG }) });
    const decided: Array<[string, boolean]> = [];
    rig.host.pendingApproval = () => ({ id: "a1", kind: "launch", title: "Run the tests", detail: "npm test", allowLabel: "Allow", denyLabel: "Deny", inFlightMuse: false }) as never;
    rig.host.decideApproval = async (id, allow) => {
      decided.push([id, allow]);
      return { ok: true, message: "done" };
    };
    await speaking(rig);
    await rig.client.speak(7, 400);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.of("interrupted").length > 0, 8000), "an answer cuts the voice off");
    assert.ok(await rig.client.until(() => rig.client.of("assistant").some((a) => a.msg.text === "Good." && a.msg.done), 10_000));
    assert.deepEqual(decided, [], "and a spoken yes is not an approval");
  });
});

describe("a correction over the reply, with the pilot on", () => {
  it("cuts the reply off once the words are plain, and answers once, from what was heard", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(8, 1500);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.of("assistant").some((a) => a.msg.text === "Done. Tuesday it is." && a.msg.done), 20_000));
    await rig.client.quiet(2500);
    assert.equal(rig.client.of("pause").length, 1);
    assert.equal(rig.client.of("interrupted").length, 1);
    assert.equal(rig.brain.requests.length, 2, "one request for the question, one for the correction");
    const asked = rig.brain.requests[1]?.messages.map((m) => `${m.role}: ${m.content}`) ?? [];
    assert.ok(asked.some((l) => l.startsWith("assistant:") && l.includes("[the user interrupted here]")), "the model is told it was cut off");
    assert.ok(asked[asked.length - 1]?.includes("Tuesday"), "and what the person said is the last thing it reads");
    const replies = rig.client.of("assistant").filter((a) => a.msg.done && a.msg.text.includes("Tuesday"));
    assert.equal(replies.length, 1, "one result");
  });

  it("ignores what a model that cannot be interrupted says later, and runs none of its tools", async () => {
    const { sched, host, brain, client, session } = await stubbornCall(4000);
    await client.speak(1, 900);
    await client.quiet(100);
    assert.ok(await client.until(() => client.playbackActive, 8000), "the first answer was spoken");
    await client.quiet(1500);
    await client.speak(6, 500);
    await client.quiet(100);
    assert.ok(await client.until(() => client.of("interrupted").length > 0, 8000));
    await client.quiet(6000); // the model finally answers the first question, and wants a task started
    assert.equal(brain.lateAnswers, 1, "the late answer did arrive");
    assert.equal(host.toolCalls.length, 0, "and nothing came of it");
    await session.close("done");
  });

  it("does not start a task from the reply while its voice is held for a person who is taking the floor, and never does", async () => {
    // the model's task arrives while the words that would take the reply from it are still being read
    const { sched, host, brain, client, session } = await stubbornCall(2000);
    await client.speak(1, 900);
    await client.quiet(100);
    assert.ok(await client.until(() => client.playbackActive, 8000), "the first answer was spoken");
    await client.quiet(1500);
    const from = sched.now();
    await client.speak(9, 2500);
    await client.quiet(200);
    const pause = client.of("pause")[0];
    const interrupted = client.of("interrupted")[0];
    assert.ok(pause && interrupted, "the voice was held and then cut off");
    assert.ok(brain.lateAt !== null && pause.at < brain.lateAt && brain.lateAt <= interrupted.at, `the task arrived while the voice was held (${pause.at - from}, ${(brain.lateAt ?? 0) - from}, ${interrupted.at - from})`);
    await client.quiet(3000);
    assert.equal(host.toolCalls.length, 0, "and it was never started");
    await session.close("done");
  });

  it("holds a task while what the person said has ended but is still being read, which is when a slow recogniser lets one through", async () => {
    const { client, session } = await stubbornCall(4000);
    const inner = session as unknown as { holdForPerson(reply: { aborted: boolean }): Promise<boolean>; turnsBeingRead: number };
    await client.quiet(1000); // some of the call, with nothing said
    // the person has finished and the recogniser's last words are awaited: what comes of it is not known
    inner.turnsBeingRead = 1;
    const reply = { aborted: false };
    let went: boolean | null = null;
    void inner.holdForPerson(reply).then((go) => {
      went = go;
    });
    await client.quiet(1500);
    assert.equal(went, null, "the task waits");
    inner.turnsBeingRead = 0; // it came to nothing
    await client.quiet(100);
    assert.equal(went, true, "and starts when it is known that the person took nothing");
    // a reply that is cut off meanwhile never starts it
    inner.turnsBeingRead = 1;
    const cut = { aborted: false };
    let result: boolean | null = null;
    void inner.holdForPerson(cut).then((go) => {
      result = go;
    });
    await client.quiet(300);
    cut.aborted = true;
    await client.quiet(100);
    assert.equal(result, false, "the person took the floor: it is never started");
    // and a wait that nothing ends has an end of its own
    inner.turnsBeingRead = 1;
    let last: boolean | null = null;
    void inner.holdForPerson({ aborted: false }).then((go) => {
      last = go;
    });
    await client.quiet(12_500);
    assert.equal(last, true, "bounded");
    inner.turnsBeingRead = 0;
    await session.close("done");
  });

  it("starts the task, a moment late, when what held the voice was a sound that asked for nothing", async () => {
    const { sched, host, brain, client, session } = await stubbornCall(2000);
    await client.speak(1, 900);
    await client.quiet(100);
    assert.ok(await client.until(() => client.playbackActive, 8000), "the first answer was spoken");
    await client.quiet(1500);
    await client.speak(5, 3000); // a sound with nothing readable in it, which goes on past the moment the task arrives
    assert.equal(brain.lateAnswers, 1, "the task has arrived");
    assert.ok(client.paused, "while the voice is held");
    assert.equal(host.toolCalls.length, 0, "it waits");
    await client.quiet(3000);
    assert.equal(host.toolCalls.length, 1, "and starts once the voice has gone on");
    assert.equal(sched.now() > 0, true);
    await session.close("done");
  });
});

describe("a pause that cannot outlive what caused it", () => {
  it("is let go when the microphone is muted", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(7, 1600); // a sound that goes on: the voice is paused while it does
    assert.ok(rig.client.paused);
    rig.client.send({ type: "mute", on: true });
    await rig.client.quiet(100);
    assert.equal(rig.client.of("resume").length >= 1, true, "the voice was told to go on");
    assert.equal(rig.client.paused, false);
  });

  it("throws away what the page holds, and does not let it play late, when the reply it belongs to is replaced meanwhile", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(5, 1200); // a sound with nothing readable in it: the voice is held while it goes on
    assert.ok(rig.client.paused, "the voice is held");
    rig.client.send({ type: "text", text: "Tell me something else" }); // a typed message replaces the reply that is being held
    await rig.client.quiet(300);
    const drops = rig.client.of("resume").filter((r) => r.msg.drop === true);
    assert.equal(drops.length, 1, "the page was told to throw it away, not to play it");
    assert.equal(rig.client.paused, false);
  });

  it("ends with the call, with nothing thrown", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(7, 1000);
    assert.ok(rig.client.paused);
    await rig.session.close("the connection was lost");
    assert.equal(rig.client.of("ended").length, 1);
    rig.session.onAudio(new Int16Array(512));
    await rig.client.quiet(200);
    assert.deepEqual(rig.logs.filter((l) => /error|hit an/i.test(l)), []);
  });

  it("is renewed while the sound goes on and over when it has not been renewed for the lease: the page does not wait for ever", async () => {
    const rig = await on();
    await speaking(rig);
    await rig.client.speak(7, 3000);
    const pauses = rig.client.of("pause");
    assert.ok(pauses.length >= 3, `renewals: ${pauses.length}`);
    // the page stops listening to the server: left alone, its lease ends and the voice is back
    const lease = pauses[pauses.length - 1]?.msg.leaseMs ?? 0;
    assert.ok(lease > 0);
    const at = rig.client.pauseLog.length;
    await rig.client.quiet(lease + 200);
    assert.ok(rig.client.pauseLog.length >= at);
  });
});

/** A call with the pilot on and a model that wants a task started `lateMs` after it was asked (see `StubbornBrain`). */
async function stubbornCall(lateMs: number) {
  const sched = new ManualScheduler(1_000_000);
  const host = new FakeHost();
  host.toolList = [{ name: "delegate_task", description: "Start a task.", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }];
  const brain = new StubbornBrain(sched, lateMs);
  let session!: VoiceSession;
  const client = new SimClient(sched, () => session);
  session = new VoiceSession({
    engines: { vad: new FakeVad(), asr: new FakeAsr(SENTENCES, sched, 0), tts: new FakeTts(sched, { msPerChar: 60 }) },
    brain,
    host,
    scheduler: sched,
    send: client.receive,
    sendAudio: client.receiveAudio,
    log: () => undefined,
    config: { interruptPilot: true },
    id: "stubborn",
  });
  await session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null, pause: true });
  await sched.advance(0);
  return { sched, host, brain, client, session };
}

/** A model that cannot be interrupted: it answers the first question long after it was asked, with a task, whatever it was told. */
class StubbornBrain implements BrainProvider {
  readonly id = "stubborn";
  readonly label = "Stubborn";
  readonly capabilities: BrainCapabilities = { tools: true, speculative: false, local: true };
  readonly requests: BrainRequest[] = [];
  lateAnswers = 0;
  /** When the task arrived (the scheduler's clock). */
  lateAt: number | null = null;

  constructor(
    private readonly sched: ManualScheduler,
    private readonly lateMs = 4000,
  ) {}

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    this.requests.push(request);
    const first = this.requests.length === 1;
    if (first) {
      // Starts to speak at once, then is slow to finish: the person stops it, and the model goes on regardless.
      yield { type: "text", delta: `${LONG} ` };
      await new Promise<void>((resolve) => this.sched.after(this.lateMs, resolve));
      this.lateAnswers++;
      this.lateAt = this.sched.now();
      yield { type: "tool", call: { id: "late", name: "delegate_task", arguments: JSON.stringify({ title: "Book the table" }) } };
      yield { type: "done", reason: "tool" };
      return;
    }
    yield { type: "text", delta: "Okay." };
    yield { type: "done", reason: "stop" };
  }
}
