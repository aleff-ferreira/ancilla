import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/voice/brain.js";
import { summarize } from "../src/voice/metrics.js";
import { makeRig, type Reply, type Rig } from "../src/voice/testing.js";

const SENTENCES: Record<number, string> = {
  1: "What time is it?",
  2: "No wait, I meant something else.",
  3: "mm-hm",
  4: "I want to book a flight and",
  5: "to Lisbon next week.",
  6: "Stop.",
  7: "Hello there.",
  8: "Remind me to call mom.",
  9: "Que horas são?",
};

const LONG =
  "Here is the whole story from the start. First there was a small town by the river with one road in and one road out. " +
  "Then a railway came and the town grew quickly into a city. After that the river was bridged in three places for carts. " +
  "Many years later the railway closed and the bridges were turned into parks. Today people walk across them every evening.";

const lastUser = (messages: ChatMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (m.role === "user") return m.content;
  }
  return "";
};

function simple(extra: Partial<Record<string, Reply>> = {}): (messages: ChatMessage[]) => Reply {
  return (messages) => {
    const text = lastUser(messages);
    for (const [key, reply] of Object.entries(extra)) if (text.endsWith(key) && reply) return reply;
    if (text.includes("time")) return { ttftMs: 300, text: "It is three o'clock. Anything else?" };
    if (text.includes("Que horas")) return { ttftMs: 300, text: "São três horas. Mais alguma coisa?" };
    return { ttftMs: 300, text: "Okay, got it." };
  };
}

async function finished(rig: Rig, count = 1, limit = 30_000): Promise<void> {
  assert.ok(await rig.client.until(() => rig.client.of("speak_end").length >= count && rig.session.snapshot().agent === "idle", limit), `speech ended (${rig.client.of("speak_end").length} of ${count})`);
}

const heardTypes = (rig: Rig): string[] => rig.client.messages.map((m) => m.msg.type);

describe("a call that answers", () => {
  it("opens, hears a question, answers it aloud in under a second and goes back to listening", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    assert.equal(rig.client.of("ready").length, 1);
    assert.equal(rig.client.of("state")[0]?.msg.state, "listening");
    await rig.client.quiet(300);
    await rig.client.speak(1, 1200);
    await rig.client.quiet(100);
    await finished(rig);
    const user = rig.client.of("user");
    assert.equal(user.length, 1);
    assert.equal(user[0]?.msg.text, "What time is it?");
    assert.equal(user[0]?.msg.source, "voice");
    const said = rig.tts.said.map((s) => s.text);
    assert.deepEqual(said, ["It is three o'clock.", "Anything else?"]);
    const metrics = rig.client.of("metrics")[0]?.msg.metrics;
    assert.ok(metrics, "metrics were reported");
    assert.ok(metrics.endpointMs !== null && metrics.endpointMs >= 450 && metrics.endpointMs <= 560, `endpoint ${metrics.endpointMs}`);
    assert.ok(metrics.firstAudioMs !== null && metrics.firstAudioMs >= 700 && metrics.firstAudioMs <= 1000, `first audio ${metrics.firstAudioMs} ms after the person stopped`);
    assert.deepEqual(rig.session.snapshot().history, [
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is three o'clock. Anything else?" },
    ]);
    assert.deepEqual(rig.host.records.map((r) => [r.role, r.source]), [["user", "voice"], ["assistant", "voice"]]);
    assert.equal(rig.client.of("state").at(-1)?.msg.state, "listening");
    assert.equal(rig.asr.openStreams, 0, "no recogniser stream is left open");
    assert.equal(rig.asr.streams[0]?.flushes, 1, "the recogniser was asked for its last words when the person went quiet, once");
  });

  it("puts the notes that bear on the question in front of it, and never in the history", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    rig.host.memory = "Notes: the user's deploy branch is main.";
    await rig.client.speak(1, 1000);
    await rig.client.quiet(100);
    await finished(rig);
    const request = rig.brain.requests[0];
    assert.ok(request);
    const content = (request.messages.at(-1) as { content: string }).content;
    assert.ok(content.startsWith("Notes: the user's deploy branch is main."));
    assert.ok(content.endsWith("What time is it?"));
    assert.equal((rig.session.snapshot().history[0] as { content: string }).content, "What time is it?");
    assert.deepEqual(rig.host.contexts, [{ text: "What time is it?", source: "voice" }]);
  });

  it("speaks Portuguese back to a person who speaks it", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    await rig.client.speak(9, 1200);
    await rig.client.quiet(100);
    await finished(rig);
    assert.ok(rig.tts.said.length >= 1);
    assert.ok(rig.tts.said.every((s) => s.voice === "pt-1"), JSON.stringify(rig.tts.said));
  });

  it("keeps its first-audio latency inside a budget over many turns", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), asrFinalMs: 60, ttsLatencyMs: 80 });
    const totals: number[] = [];
    for (let i = 0; i < 8; i++) {
      await rig.client.speak(1, 900 + i * 40);
      await rig.client.quiet(100);
      await finished(rig, i + 1);
      await rig.client.quiet(300);
    }
    for (const m of rig.client.of("metrics")) if (m.msg.metrics.firstAudioMs !== null) totals.push(m.msg.metrics.firstAudioMs);
    const s = summarize(totals);
    assert.equal(s.n, 8);
    assert.ok((s.p50 as number) <= 1000 && (s.p95 as number) <= 1100, `p50 ${s.p50} p95 ${s.p95} ms`);
  });
});

describe("being interrupted", () => {
  async function talking(): Promise<Rig> {
    const rig = await makeRig({
      sentences: SENTENCES,
      script: (messages) => (lastUser(messages).includes("Stop") || lastUser(messages).includes("Hello") ? { ttftMs: 200, text: "Okay." } : { ttftMs: 250, text: LONG }),
    });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.playbackActive, 5000), "the assistant began to speak");
    await rig.client.quiet(2000);
    return rig;
  }

  it("stops within a third of a second of the person saying stop, and remembers only what was heard", async () => {
    const rig = await talking();
    const before = rig.client.sched.now();
    await rig.client.speak(6, 500);
    const duck = rig.client.of("duck").find((d) => d.at >= before && d.msg.on);
    const cut = rig.client.of("interrupted")[0];
    assert.ok(duck, "the voice was lowered first");
    assert.ok(cut, "and stopped");
    assert.ok(cut.at - before <= 420, `stopped ${cut.at - before} ms after the person began`);
    assert.ok(duck.at <= cut.at);
    const full = rig.tts.said.map((s) => s.text).join(" ");
    assert.ok(cut.msg.heard.length > 0 && cut.msg.heard.length < full.length, `heard "${cut.msg.heard}"`);
    assert.ok(full.startsWith(cut.msg.heard.slice(0, 20)));
    await rig.client.quiet(100);
    assert.equal(rig.client.playbackActive, false, "the speakers were emptied");
    await finished(rig, 1);
    const second = rig.brain.requests[1];
    assert.ok(second, "the interruption was answered");
    const assistant = second.messages.filter((m) => m.role === "assistant");
    assert.equal(assistant.length, 1);
    assert.ok((assistant[0] as { content: string }).content.endsWith("[the user interrupted here]"));
    assert.ok(!(assistant[0] as { content: string }).content.includes("walk across them every evening"), "what was never said is not remembered");
    const entry = rig.host.records.find((r) => r.interrupted);
    assert.ok(entry && entry.heard === cut.msg.heard);
  });

  it("is not interrupted by a sound of listening", async () => {
    const rig = await talking();
    await rig.client.speak(3, 300);
    await rig.client.quiet(600);
    assert.equal(rig.client.of("interrupted").length, 0);
    const ducks = rig.client.of("duck").map((d) => d.msg.on);
    assert.deepEqual(ducks, [true, false]);
    assert.equal(rig.client.playbackActive, true, "it is still talking");
    await finished(rig);
    assert.equal(rig.client.of("user").length, 1, "no turn was made of it");
  });

  it("is not interrupted by its own voice coming back through the microphone", async () => {
    const rig = await talking();
    rig.client.echoAmp = 0.04;
    await rig.client.quiet(5000);
    assert.equal(rig.client.of("interrupted").length, 0);
    assert.equal(rig.client.of("duck").length, 0);
    rig.client.echoAmp = 0;
    await finished(rig);
  });

  it("gives way to a longer interruption that is not a stop word, and answers it", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: (m) => (lastUser(m).includes("something else") ? { ttftMs: 200, text: "Sure, what else?" } : { ttftMs: 250, text: LONG }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.playbackActive, 5000);
    await rig.client.quiet(1500);
    await rig.client.speak(2, 1800);
    assert.equal(rig.client.of("interrupted").length, 1);
    await rig.client.quiet(100);
    await finished(rig);
    assert.equal(rig.client.of("user").at(-1)?.msg.text, "No wait, I meant something else.");
    assert.equal(rig.tts.said.at(-1)?.text, "Sure, what else?");
  });

  it("is interrupted by typing", async () => {
    const rig = await talking();
    rig.client.send({ type: "text", text: "Hello there." });
    await rig.client.quiet(200);
    assert.equal(rig.client.of("interrupted").length, 1);
    assert.equal(rig.client.of("user").at(-1)?.msg.source, "text");
    await finished(rig);
    assert.equal(rig.tts.said.at(-1)?.text, "Okay.");
  });
});

describe("a person who pauses to think", () => {
  it("is not cut off in the middle of a sentence", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    await rig.client.speak(4, 1400);
    await rig.client.quiet(1000);
    await rig.client.speak(5, 1500);
    await rig.client.quiet(100);
    await finished(rig);
    const user = rig.client.of("user");
    assert.equal(user.length, 1, "one turn, not two");
    assert.equal(user[0]?.msg.text, "I want to book a flight and to Lisbon next week.");
    assert.equal(rig.brain.requests.length, 1);
  });

  it("is continued, not answered twice, when they go on a moment after the turn was thought to be over", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: (m) => ({ ttftMs: 1200, text: lastUser(m).includes("Lisbon") ? "Lisbon, noted." : "One answer." }) });
    await rig.client.speak(8, 1500);
    await rig.client.quiet(900);
    await rig.client.speak(5, 1500);
    await rig.client.quiet(100);
    await finished(rig);
    const user = rig.client.of("user");
    assert.equal(user.length, 2, "the first reading, then the turn carried on");
    assert.equal(user[0]?.msg.text, "Remind me to call mom.");
    assert.equal(user[1]?.msg.text, "Remind me to call mom. to Lisbon next week.");
    assert.equal(user[1]?.msg.turn, user[0]?.msg.turn, "under the same number");
    assert.equal(rig.brain.aborted, 1, "the first reply was dropped");
    assert.equal(rig.session.snapshot().turns, 1);
    assert.deepEqual(rig.tts.said.map((s) => s.text), ["Lisbon, noted."]);
    assert.equal(rig.session.snapshot().history.filter((m) => m.role === "user").length, 1);
  });
});

describe("a model that is slow, fails, or uses tools", () => {
  it("covers a long wait with a short phrase, once, and then answers", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 3600, text: "It is three o'clock." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    const said = rig.tts.said.map((s) => s.text);
    assert.equal(said.length, 2, JSON.stringify(said));
    assert.ok(["One moment.", "Let me think.", "Let me check.", "Give me a second."].includes(said[0] as string));
    assert.equal(said[1], "It is three o'clock.");
    const first = rig.client.of("speaking")[0];
    assert.ok(first && first.at - (rig.client.of("user")[0]?.at ?? 0) >= 1400 && first.at - (rig.client.of("user")[0]?.at ?? 0) <= 1700, "after about a second and a half");
    assert.ok((rig.session.snapshot().history[1] as { content: string }).content.endsWith("It is three o'clock."));
  });

  it("says nothing extra when the model is quick", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 200, text: "It is three o'clock." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    assert.deepEqual(rig.tts.said.map((s) => s.text), ["It is three o'clock."]);
  });

  it("apologises when the model fails and carries on with the next turn", async () => {
    let n = 0;
    const rig = await makeRig({ sentences: SENTENCES, script: () => (++n === 1 ? { ttftMs: 100, error: "The model answered 503" } : { ttftMs: 200, text: "Okay, got it." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    assert.match(rig.tts.said[0]?.text ?? "", /Sorry, I lost my train of thought/);
    assert.equal(rig.client.of("notice").length, 1);
    await rig.client.speak(7, 900);
    await rig.client.quiet(100);
    await finished(rig, 2);
    assert.equal(rig.tts.said.at(-1)?.text, "Okay, got it.");
  });

  it("shows what the model says about itself on the card, and goes on answering", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 100, notice: "Muse would not put this thread on muse-wonder-1.0: not offered. It answers on the model the thread already has.", text: "Okay, got it." }) });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await finished(rig);
    assert.deepEqual(rig.tts.said.map((s) => s.text), ["Okay, got it."], "the answer is said, with no apology");
    const notices = rig.client.of("notice");
    assert.equal(notices.length, 1);
    assert.match((notices[0]?.msg as { text: string }).text, /It answers on the model the thread already has\.$/);
    assert.equal((notices[0]?.msg as { level: string }).level, "warn");
  });

  it("runs a tool, says what it is doing, and goes on with the result", async () => {
    let n = 0;
    const rig = await makeRig({
      sentences: SENTENCES,
      script: () => (++n === 1 ? { ttftMs: 200, tool: { name: "delegate_task", args: { goal: "call mom" } } } : { ttftMs: 150, text: "I will tell you when it is done." }),
    });
    rig.host.toolList = [{ name: "delegate_task", description: "Start work in the background.", parameters: { type: "object" } }];
    await rig.client.speak(8, 1200);
    await rig.client.quiet(100);
    await finished(rig);
    assert.equal(rig.host.toolCalls.length, 1);
    assert.equal(rig.host.toolCalls[0]?.name, "delegate_task");
    assert.deepEqual(rig.tts.said.map((s) => s.text), ["Starting that now.", "I will tell you when it is done."]);
    const second = rig.brain.requests[1];
    assert.ok(second && second.messages.some((m) => m.role === "tool" && m.content === "done"), "the model was given the result");
    assert.ok(rig.brain.requests[0]?.tools.some((t) => t.name === "delegate_task"));
  });
});

describe("saying something nobody asked for", () => {
  it("waits for a lull, and then says it once", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    await rig.client.quiet(600);
    rig.host.emit({ id: "t1", kind: "task", title: "Weekly report", status: "done", say: "Your weekly report is ready.", needsUser: false });
    assert.equal(rig.client.of("task").length, 1, "the screen is told at once");
    await rig.client.quiet(1500);
    assert.equal(rig.tts.said.length, 0, "not yet");
    await rig.client.quiet(1400);
    assert.deepEqual(rig.tts.said.map((s) => s.text), ["Your weekly report is ready."]);
    await finished(rig);
    await rig.client.quiet(6000);
    assert.equal(rig.tts.said.length, 1, "and not again");
  });

  it("does not speak over the person or over itself", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    await rig.client.speak(1, 1000);
    rig.host.emit({ id: "t2", kind: "notice", title: "Backup", status: "done", say: "The backup finished.", needsUser: false });
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length >= 1, 30_000);
    assert.equal(rig.tts.said.some((s) => s.text === "The backup finished."), false, "the answer came first");
    await rig.client.quiet(3200);
    assert.equal(rig.tts.said.at(-1)?.text, "The backup finished.");
  });

  const hello = { type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null } as const;
  const NEWS = "While you were away: Weekly report is done.";

  it("opens with the news that was waiting, once, after a moment's quiet", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), open: false });
    rig.host.openingText = NEWS;
    await rig.session.start(hello);
    await rig.client.quiet(1500);
    assert.equal(rig.tts.said.length, 0, "not at once: the person may want to speak first");
    await rig.client.quiet(1500);
    assert.equal(rig.tts.said.map((s) => s.text).join(" "), NEWS);
    await finished(rig);
    assert.deepEqual(rig.host.records.map((r) => [r.role, r.source, r.text]), [["assistant", "event", NEWS]], "kept in the conversation, so that it is not said again");
    await rig.client.quiet(6000);
    assert.equal(rig.tts.said.map((s) => s.text).join(" "), NEWS, "and not again");
  });

  it("does not open with it when the person speaks first", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), open: false });
    rig.host.openingText = NEWS;
    await rig.session.start(hello);
    await rig.client.speak(1, 1000);
    await rig.client.quiet(100);
    await finished(rig);
    await rig.client.quiet(6000);
    assert.equal(rig.tts.said.some((s) => /While you were away/.test(s.text)), false, "they chose the topic; the news is not laid over it");
  });

  it("opens without news when the host cannot say what is waiting", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), open: false });
    rig.host.opening = () => {
      throw new Error("the tasks could not be read");
    };
    await rig.session.start(hello);
    assert.equal(rig.client.of("ready").length, 1, "the call opened");
    await rig.client.quiet(6000);
    assert.equal(rig.tts.said.length, 0);
    assert.ok(rig.logs.some((l) => /could not be read/.test(l)));
  });

  it("shows a task without saying it when there is nothing to say", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    rig.host.emit({ id: "t3", kind: "task", title: "Index", status: "running", say: null, needsUser: false });
    await rig.client.quiet(6000);
    assert.equal(rig.client.of("task").length, 1);
    assert.equal(rig.tts.said.length, 0);
  });
});

describe("controls, modes and the end", () => {
  it("hears nothing while muted and goes on when unmuted", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    rig.client.send({ type: "mute", on: true });
    await rig.client.speak(1, 1200);
    await rig.client.quiet(1000);
    assert.equal(rig.client.of("user").length, 0);
    rig.client.send({ type: "mute", on: false });
    await rig.client.quiet(100);
    await rig.client.speak(1, 1200);
    await rig.client.quiet(100);
    await finished(rig);
    assert.equal(rig.client.of("user").length, 1);
  });

  it("works by push to talk without listening for a pause", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), mode: "push-to-talk" });
    await rig.client.speak(1, 800);
    assert.equal(rig.client.of("user").length, 0, "nothing is heard while the button is up");
    rig.client.send({ type: "ptt", down: true });
    await rig.client.quiet(40);
    await rig.client.speak(1, 1000);
    rig.client.send({ type: "ptt", down: false });
    await rig.client.quiet(100);
    await finished(rig);
    assert.equal(rig.client.of("user")[0]?.msg.text, "What time is it?");
  });

  it("answers a ping and ends cleanly: nothing left running, nothing sent after", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple() });
    rig.client.send({ type: "ping", t: 7 });
    assert.deepEqual(rig.client.of("pong")[0]?.msg, { type: "pong", t: 7 });
    await rig.client.speak(1, 900);
    await rig.client.quiet(900);
    await rig.session.close("done");
    const count = rig.client.messages.length;
    await rig.client.quiet(3000);
    assert.equal(rig.client.messages.length, count, "silence after the end");
    assert.equal(rig.client.of("ended").length, 1);
    assert.equal(rig.sched.pending, 0, "no timer is left");
    assert.equal(rig.asr.openStreams, 0);
    assert.ok(heardTypes(rig).includes("ready"));
  });

  it("drops audio it cannot keep up with instead of falling further behind", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: simple(), config: { maxBacklogFrames: 4 } });
    const big = new Int16Array(16000 * 3);
    rig.session.onAudio(big);
    await rig.client.quiet(100);
    assert.ok(rig.logs.some((l) => l.includes("behind real time")));
  });
});
