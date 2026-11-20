import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_INTERRUPT_CONFIG, EchoModel, InterruptJudge, PlayoutLevels, isPolarityAnswer, isPureStop, type InterruptCommand, type InterruptDeps } from "../src/voice/interrupt.js";
import { DEFAULT_TURN_CONFIG, TurnTaker, type TurnEvent } from "../src/voice/turn.js";

const FRAME = DEFAULT_INTERRUPT_CONFIG.frameMs;
const NOT_ECHO = { looksLikeEcho: () => false };

interface Step {
  ms: number;
  prob: number;
  rms: number;
  ref: number | null;
}
interface Timed {
  at: number;
  text: string;
  final?: boolean;
}
interface Stamped {
  at: number;
  cmd: InterruptCommand;
}

/** The assistant's voice at the speaker, loud, and the microphone as the canceller leaves it: nearly nothing. */
const echoOnly = (ms: number): Step => ({ ms, prob: 0.1, rms: 0.001, ref: 0.1 });
/** Someone speaking over the voice: the soft detector says speech, the microphone is well above the echo. */
const person = (ms: number, prob = 0.42, rms = 0.05): Step => ({ ms, prob, rms, ref: 0.1 });
const room = (ms: number): Step => ({ ms, prob: 0.05, rms: 0.0008, ref: 0 });

function drive(judge: InterruptJudge, steps: Step[], timed: Timed[] = [], from = 0): { out: Stamped[]; end: number } {
  const out: Stamped[] = [];
  const pending = [...timed].sort((a, b) => a.at - b.at);
  let t = from;
  for (const step of steps) {
    for (let i = 0; i < Math.round(step.ms / FRAME); i++) {
      t += FRAME;
      while (pending.length > 0 && (pending[0] as Timed).at <= t) {
        const x = pending.shift() as Timed;
        for (const cmd of judge.transcript(t, x.text, x.final === true)) out.push({ at: t, cmd });
      }
      for (const cmd of judge.frame({ t, prob: step.prob, rms: step.rms, ref: step.ref })) out.push({ at: t, cmd });
    }
  }
  return { out, end: t };
}

const kinds = (out: Stamped[]): string[] => out.map((s) => s.cmd.type);
const first = (out: Stamped[], type: InterruptCommand["type"]): Stamped | undefined => out.find((s) => s.cmd.type === type);

function speaking(deps: InterruptDeps = NOT_ECHO, expectAnswer = false): InterruptJudge {
  const judge = new InterruptJudge(deps);
  judge.setSpeaking(true);
  judge.setExpectAnswer(expectAnswer);
  return judge;
}

describe("sound over the assistant's voice", () => {
  it("pauses the voice on the second frame of sound its own voice does not explain, and not before", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME)]);
    const pause = first(out, "pause") as Stamped;
    assert.ok(pause, "a pause");
    assert.equal(pause.at, lead + 2 * FRAME);
    assert.equal(first(out, "open")?.at, pause.at);
    assert.equal(out.filter((s) => s.cmd.type === "pause" && !(s.cmd as { renewal: boolean }).renewal).length, 1);
    assert.equal(first(out, "interrupt"), undefined, "sound alone never cuts the voice off");
  });

  it("cuts the voice off, and only then, when the words are a stop word: the voice was silent from the pause", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(10 * FRAME)], [{ at: lead + 18 * FRAME, text: "Stop" }]);
    const pause = first(out, "pause") as Stamped;
    const stop = first(out, "interrupt") as Stamped;
    assert.ok(stop, "an interruption");
    assert.equal((stop.cmd as { reason: string }).reason, "stop-word");
    assert.ok(pause.at < stop.at, "the pause came first");
    assert.equal(first(out, "resume"), undefined);
    // the turn is taken as having begun where the sound began
    assert.equal((stop.cmd as { from: number }).from, lead);
  });

  it("goes on from the same place after a sound of listening", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(8 * FRAME), room(12 * FRAME)], [{ at: lead + 14 * FRAME, text: "Yeah." }]);
    const resume = first(out, "resume") as Stamped;
    assert.ok(resume, "a resume");
    assert.equal((resume.cmd as { reason: string }).reason, "backchannel");
    assert.ok(first(out, "backchannel"));
    assert.equal(first(out, "interrupt"), undefined);
    assert.ok(first(out, "close"));
  });

  it("takes yes as an answer, not a sound of listening, when the assistant has just asked something", () => {
    const judge = speaking(NOT_ECHO, true);
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(8 * FRAME)], [{ at: lead + 16 * FRAME, text: "Yes" }]);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "speech");
    assert.equal(isPolarityAnswer("Sim."), true);
  });

  it("goes on when the words are the assistant's own coming back, and says so", () => {
    const judge = speaking({ looksLikeEcho: (text) => text.includes("weather") });
    const lead = 20 * FRAME;
    // barely louder than the echo it has learned (a thousandth, against a voice at a tenth): an echo that the canceller let through
    const { out } = drive(judge, [echoOnly(lead), { ms: 6 * FRAME, prob: 0.5, rms: 0.0055, ref: 0.1 }, room(10 * FRAME)], [{ at: lead + 12 * FRAME, text: "the weather in Lisbon" }]);
    assert.equal((first(out, "resume")?.cmd as { reason: string } | undefined)?.reason, "echo");
    assert.equal(first(out, "interrupt"), undefined);
  });

  it("does not take a person for its echo because they say words it said: 'no, call Marta, not Ana'", () => {
    const judge = speaking({ looksLikeEcho: () => true });
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(24 * FRAME), room(5 * FRAME)], [{ at: lead + 14 * FRAME, text: "no call Marta not Ana" }]);
    assert.equal(first(out, "resume"), undefined);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "speech");
  });

  it("takes words of any other kind as the person taking the floor once there are enough of them and the sound is long enough to hold them", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(24 * FRAME)], [{ at: lead + 8 * FRAME, text: "I think that is wrong" }]);
    const interrupt = first(out, "interrupt") as Stamped;
    assert.equal((interrupt.cmd as { reason: string }).reason, "speech");
    assert.ok(interrupt.at >= lead + 17 * FRAME, "not before five words have had room to be said");
  });

  it("does not take the first word of a reading for what it will turn out to be: 'I' becomes 'I see'", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(9 * FRAME), room(12 * FRAME)], [
      { at: lead + 6 * FRAME, text: "I" },
      { at: lead + 15 * FRAME, text: "I see." },
    ]);
    assert.equal(first(out, "interrupt"), undefined);
    assert.equal((first(out, "resume")?.cmd as { reason: string } | undefined)?.reason, "backchannel");
  });

  it("waits for the recogniser to say it has read out the last words, however long a busy machine takes, and no longer", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const a = drive(judge, [echoOnly(lead), person(5 * FRAME), room(6 * FRAME)]);
    const settle = first(a.out, "settle") as Stamped;
    assert.ok(settle, "the sound ended: the recogniser is asked for the last words");
    judge.expectAck(true);
    const seq = (settle.cmd as { seq: number }).seq;
    // three seconds of nothing from a recogniser that is busy: the pause is not given up on a guess
    const b = drive(judge, [room(90 * FRAME)], [], a.end);
    assert.equal(first(b.out, "resume"), undefined);
    assert.equal(judge.paused, true);
    // an answer to an older question is not the answer
    assert.deepEqual(judge.settled(b.end, seq + 7), []);
    // and when it has read out what there was, and there were no words, the pause ends at once
    const c = judge.settled(b.end, seq);
    assert.equal((c.find((x) => x.type === "resume") as { reason: string } | undefined)?.reason, "no-words");
  });

  it("decides on the words that were read out when the recogniser says it is done", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const a = drive(judge, [echoOnly(lead), person(10 * FRAME), room(6 * FRAME)]);
    const settle = first(a.out, "settle") as Stamped;
    judge.expectAck(true);
    // the words arrive as a partial and then the acknowledgement; two words wait for the last reading
    assert.deepEqual(judge.transcript(a.end, "Meet Tuesday.", false), [], "two words are not enough before the last reading");
    const done = judge.settled(a.end, (settle.cmd as { seq: number }).seq);
    assert.equal((done.find((x) => x.type === "interrupt") as { reason: string } | undefined)?.reason, "speech");
  });

  it("does not take 'Okay' for a sound of listening when it turns out to be the start of 'Okay, stop'", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(14 * FRAME), room(14 * FRAME)], [
      { at: lead + 5 * FRAME, text: "Okay" },
      { at: lead + 22 * FRAME, text: "Okay, stop." },
    ]);
    assert.equal(first(out, "resume"), undefined);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "stop-word");
  });

  it("does not pause for sound much quieter than the person has been speaking in this call", () => {
    const judge = speaking();
    judge.setForeground(0.05);
    const quietTalk = drive(judge, [echoOnly(10 * FRAME), { ms: 12 * FRAME, prob: 0.8, rms: 0.006, ref: 0.1 }]);
    assert.equal(first(quietTalk.out, "pause"), undefined, "a television in the next room");
    const person2 = drive(judge, [{ ms: 6 * FRAME, prob: 0.8, rms: 0.04, ref: 0.1 }], [], quietTalk.end);
    assert.ok(first(person2.out, "pause"), "and the person themselves");
  });

  it("goes on when a loud syllable of a voice far away started the pause and all the rest of it is much quieter than the person", () => {
    const judge = speaking();
    judge.setForeground(0.05);
    const lead = 10 * FRAME;
    const { out } = drive(
      judge,
      [echoOnly(lead), person(3 * FRAME, 0.6, 0.012), { ms: 20 * FRAME, prob: 0.8, rms: 0.0042, ref: 0.1 }, room(8 * FRAME)],
      [{ at: lead + 24 * FRAME, text: "Did you remember to call the plumber about the kitchen sink this morning" }],
    );
    assert.ok(first(out, "pause"), "the loud syllable paused the voice");
    const resume = first(out, "resume") as Stamped;
    assert.equal((resume.cmd as { reason: string }).reason, "distant");
    assert.ok(resume.at < lead + 14 * FRAME, "it goes on as soon as the rest of the sound shows what it is");
    assert.equal(first(out, "interrupt"), undefined, "its words are not taken as the person's");
  });

  it("still takes the floor for a person who is quieter than usual but well within reach of their own level", () => {
    const judge = speaking();
    judge.setForeground(0.05);
    const lead = 10 * FRAME;
    const { out } = drive(
      judge,
      [echoOnly(lead), person(10 * FRAME, 0.6, 0.012), room(8 * FRAME)],
      [{ at: lead + 14 * FRAME, text: "Stop" }],
    );
    assert.equal(first(out, "resume"), undefined);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "stop-word");
  });

  it("does not take the floor for one word that is not a stop, which is how a recogniser writes a cough or a throat cleared", () => {
    for (const written of ["Fine.", "Tuesday", "Marta"]) {
      const judge = speaking();
      const lead = 20 * FRAME;
      const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(14 * FRAME)], [{ at: lead + 16 * FRAME, text: written, final: true }]);
      assert.equal(first(out, "interrupt"), undefined, written);
      assert.equal((first(out, "resume")?.cmd as { reason: string } | undefined)?.reason, "no-words", written);
    }
    // two words are the person speaking
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(12 * FRAME), room(14 * FRAME)], [{ at: lead + 18 * FRAME, text: "Call Marta", final: true }]);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "speech");
  });

  it("takes thanks for what it is, an acknowledgement, and goes on", () => {
    for (const written of ["Thank you.", "Thanks", "Obrigado."]) {
      const judge = speaking();
      const lead = 20 * FRAME;
      const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(14 * FRAME)], [{ at: lead + 16 * FRAME, text: written, final: true }]);
      assert.equal(first(out, "interrupt"), undefined, written);
      assert.ok(first(out, "resume"), written);
    }
  });

  it("goes on after a cough that the recogniser writes down as a word, and after a word it makes up out of noise", () => {
    for (const written of ["Ahem.", "Hmm", "the"]) {
      const judge = speaking();
      const lead = 20 * FRAME;
      const { out } = drive(judge, [echoOnly(lead), person(8 * FRAME), room(14 * FRAME)], [{ at: lead + 14 * FRAME, text: written }]);
      assert.equal(first(out, "interrupt"), undefined, written);
      assert.ok(first(out, "resume"), written);
    }
  });

  it("does not believe more words than the sound has room for, whatever the recogniser writes", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(55 * FRAME)], [{ at: lead + 14 * FRAME, text: "I'm not sure about that at all" }]);
    assert.equal(first(out, "interrupt"), undefined, "seven words in a third of a second");
    assert.equal((first(out, "resume")?.cmd as { reason: string } | undefined)?.reason, "no-words");
  });

  it("keeps what was read when the quiet after a word is read as nothing", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(10 * FRAME), room(16 * FRAME)], [
      { at: lead + 12 * FRAME, text: "Meet Tuesday." },
      { at: lead + 17 * FRAME, text: "" },
    ]);
    assert.equal((first(out, "interrupt")?.cmd as { reason: string } | undefined)?.reason, "speech");
  });

  it("lets a cough, which has no words in it, end its own pause, after the recogniser has had its say", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(5 * FRAME), room(50 * FRAME)]);
    assert.ok(first(out, "settle"), "the recogniser is asked for its last reading");
    const resume = first(out, "resume") as Stamped;
    assert.equal((resume.cmd as { reason: string }).reason, "no-words");
    assert.equal(first(out, "interrupt"), undefined);
    const settle = first(out, "settle") as Stamped;
    assert.ok(resume.at - settle.at >= DEFAULT_INTERRUPT_CONFIG.finalWaitMs);
  });

  it("never cuts the voice off by sound alone, however long the sound lasts, and ends the pause by itself", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const { out } = drive(judge, [echoOnly(lead), person(150 * FRAME), room(20 * FRAME)]);
    assert.equal(first(out, "interrupt"), undefined);
    const renewals = out.filter((s) => s.cmd.type === "pause" && (s.cmd as { renewal: boolean }).renewal);
    assert.ok(renewals.length >= 3, "the pause is renewed while the sound goes on");
    const resume = first(out, "resume") as Stamped;
    assert.equal((resume.cmd as { reason: string }).reason, "timeout");
    assert.ok(resume.at - (first(out, "pause") as Stamped).at <= DEFAULT_INTERRUPT_CONFIG.pauseMaxMs + FRAME);
  });

  it("does not pause for what its own voice explains, nor for a room that is quiet", () => {
    const judge = speaking();
    // the microphone follows the voice at a twelfth of its loudness for a long time: that is the echo, however sure the detector is
    const { out } = drive(judge, Array.from({ length: 40 }, () => ({ ms: 5 * FRAME, prob: 0.9, rms: 0.008, ref: 0.1 })));
    assert.equal(out.length, 0);
    const judge2 = speaking();
    const quiet = drive(judge2, [echoOnly(10 * FRAME), { ms: 10 * FRAME, prob: 0.9, rms: 0.0009, ref: 0.1 }]);
    assert.equal(quiet.out.length, 0);
  });

  it("learns how loud its own echo is, so that the same echo does not pause the voice a second time", () => {
    const echoWords = { looksLikeEcho: () => true };
    const judge = speaking(echoWords);
    const steps: Step[] = [];
    for (let i = 0; i < 6; i++) steps.push({ ms: 6 * FRAME, prob: 0.9, rms: 0.012, ref: 0.1 }, { ms: 12 * FRAME, prob: 0.9, rms: 0.012, ref: 0.1 });
    const { out } = drive(judge, steps, [{ at: 5 * FRAME, text: "the weather in lisbon" }, { at: 80 * FRAME, text: "the weather in lisbon" }]);
    const pauses = out.filter((s) => s.cmd.type === "pause" && !(s.cmd as { renewal: boolean }).renewal);
    assert.ok(pauses.length <= 1, `echo that was recognised as echo is paused for once, not again and again (${pauses.length})`);
  });

  it("needs more evidence for a while after a pause that came to nothing", () => {
    const judge = speaking();
    const lead = 20 * FRAME;
    const a = drive(judge, [echoOnly(lead), person(5 * FRAME), room(50 * FRAME)]);
    assert.ok(first(a.out, "resume"));
    const b = drive(judge, [person(2 * FRAME)], [], a.end);
    assert.equal(first(b.out, "pause"), undefined, "two frames are not enough right after");
    const c = drive(judge, [person(3 * FRAME)], [], b.end);
    assert.ok(first(c.out, "pause"), "four are");
  });

  it("listens only while the assistant is speaking", () => {
    const judge = new InterruptJudge(NOT_ECHO);
    const { out } = drive(judge, [echoOnly(10 * FRAME), person(10 * FRAME)]);
    assert.equal(out.length, 0);
    judge.setSpeaking(true);
    const more = drive(judge, [person(4 * FRAME)], [], 1000);
    assert.ok(first(more.out, "pause"));
    judge.setSpeaking(false);
    assert.equal(judge.paused, false, "the voice stopped for other reasons: nothing is left paused");
  });

  it("without a measure of its own voice, asks for a sure detector and still pauses", () => {
    const judge = speaking();
    const weak = drive(judge, [{ ms: 8 * FRAME, prob: 0.5, rms: 0.05, ref: null }]);
    assert.equal(first(weak.out, "pause"), undefined);
    const sure = drive(judge, [{ ms: 8 * FRAME, prob: 0.86, rms: 0.05, ref: null }], [], weak.end);
    assert.ok(first(sure.out, "pause"));
  });
});

describe("a stop that asks for nothing to answer", () => {
  it("is a stop word and no more, in English and Portuguese", () => {
    for (const said of ["Stop.", "Stop it.", "Wait.", "Hold on a second.", "Okay, stop.", "That's enough.", "Pare.", "Já chega.", "Pare de falar", "Espera aí", "Chega"]) {
      assert.equal(isPureStop(said), true, said);
    }
  });

  it("is not a correction, a question or an order that happens to begin with one", () => {
    for (const said of ["Actually, call Marta.", "Wait, not Monday, Friday.", "Stop the music in the kitchen", "No, I meant Tuesday", "Espera, não a Ana, o Bruno", "Na verdade, quarta", "Hold on, what time is it", "Pare o servidor", "No", "Yeah"]) {
      assert.equal(isPureStop(said), false, said);
    }
  });
});

describe("the turn-taker with a judge", () => {
  const frames = (taker: TurnTaker, steps: Step[], timed: Timed[] = []): { events: Array<{ at: number; ev: TurnEvent }>; end: number } => {
    const events: Array<{ at: number; ev: TurnEvent }> = [];
    const pending = [...timed];
    let t = 0;
    for (const step of steps) {
      for (let i = 0; i < Math.round(step.ms / FRAME); i++) {
        t += FRAME;
        while (pending.length > 0 && (pending[0] as Timed).at <= t) {
          const x = pending.shift() as Timed;
          for (const ev of taker.transcript(t, x.text)) events.push({ at: t, ev });
        }
        for (const ev of taker.frame(t, step.prob, { rms: step.rms, ref: step.ref })) events.push({ at: t, ev });
      }
    }
    return { events, end: t };
  };

  it("pauses at once, then reports the stop word as a barge-in by keyword that begins the person's turn", () => {
    const judge = new InterruptJudge(NOT_ECHO);
    const taker = new TurnTaker(DEFAULT_TURN_CONFIG, judge);
    taker.setAgent(0, "speaking");
    const lead = 20 * FRAME;
    const { events } = frames(taker, [echoOnly(lead), person(8 * FRAME), room(10 * FRAME)], [{ at: lead + 14 * FRAME, text: "Stop" }]);
    const types = events.map((e) => e.ev.type);
    assert.deepEqual(types.slice(0, 2), ["overlap_start", "pause"]);
    assert.ok(types.includes("barge_in"));
    const barge = events.find((e) => e.ev.type === "barge_in") as { ev: Extract<TurnEvent, { type: "barge_in" }> };
    assert.equal(barge.ev.reason, "keyword");
    assert.ok(types.indexOf("speech_start") > types.indexOf("barge_in"));
    assert.equal(types.includes("duck"), false, "the voice is paused, not ducked");
  });

  it("drops the voice it holds, and does not let it play late, when the assistant stops speaking while the sound goes on", () => {
    const judge = new InterruptJudge(NOT_ECHO);
    const taker = new TurnTaker(DEFAULT_TURN_CONFIG, judge);
    taker.setAgent(0, "speaking");
    const lead = 20 * FRAME;
    const { events, end } = frames(taker, [echoOnly(lead), person(8 * FRAME)]);
    assert.ok(events.some((e) => e.ev.type === "pause"));
    // its reply ends (or is replaced) while the person is still speaking and nothing has decided yet
    const out = taker.setAgent(end, "thinking");
    const resume = out.find((e) => e.type === "resume") as Extract<TurnEvent, { type: "resume" }> | undefined;
    assert.equal(resume?.reason, "agent-stopped");
    assert.ok(out.some((e) => e.type === "overlap_end"));
    // and with nothing held, a change of what the assistant is doing says nothing about a pause
    assert.deepEqual(taker.setAgent(end + FRAME, "idle").filter((e) => e.type === "resume"), []);
  });

  it("is the turn-taker it has always been without a judge: the same sound only ducks the voice", () => {
    const taker = new TurnTaker(DEFAULT_TURN_CONFIG);
    taker.setAgent(0, "speaking");
    const lead = 20 * FRAME;
    const { events } = frames(taker, [echoOnly(lead), person(8 * FRAME, 0.9)]);
    const types = events.map((e) => e.ev.type);
    assert.ok(types.includes("duck"));
    assert.equal(types.includes("pause"), false);
  });
});

describe("how loud the assistant's own voice is", () => {
  it("is read from what was sent and what the page says it has played, between reports in real time", () => {
    const levels = new PlayoutLevels(1000, 100); // 1000 samples a second keeps the arithmetic plain
    // two seconds of voice in 40 ms pieces: loud for the first second, quiet for the second
    for (let i = 0; i < 50; i++) levels.add(1, i * 40, i * 40 + 40, i < 25 ? 0.2 : 0.01, i * 40);
    levels.reported(1, 500, 600);
    assert.equal(levels.levelAt(600), 0.2);
    assert.equal(levels.levelAt(1400), 0.01, "a second after the report it is in the quiet part");
  });

  it("stands still while paused, and is silent a moment after", () => {
    const levels = new PlayoutLevels(1000, 100);
    for (let i = 0; i < 50; i++) levels.add(1, i * 40, i * 40 + 40, 0.2, i * 40);
    levels.reported(1, 500, 600);
    levels.pause(700);
    assert.equal(levels.levelAt(750), 0.2, "its tail is still in the room");
    assert.equal(levels.levelAt(1500), 0, "and then nothing");
    levels.resume(1500);
    assert.equal(levels.levelAt(1600), 0.2);
  });

  it("knows nothing of another reply's pieces", () => {
    const levels = new PlayoutLevels(1000, 100);
    levels.add(1, 0, 40, 0.5, 0);
    levels.add(2, 0, 40, 0.1, 100);
    levels.reported(2, 20, 100);
    assert.equal(levels.levelAt(100), 0.1);
  });

  it("learns the ratio of the microphone to the voice as an upper envelope", () => {
    const echo = new EchoModel(16);
    for (let i = 0; i < 16; i++) echo.learn(0.01 * (1 + (i % 4)), 0.1);
    assert.ok(echo.expected(0.1) >= 0.02 && echo.expected(0.1) <= 0.04);
    echo.learn(0.5, 0.001); // the voice is too faint to measure by
    assert.ok(echo.expected(0.1) <= 0.04);
  });
});
