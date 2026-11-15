import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TURN_CONFIG, TurnTaker, type AgentActivity, type TurnEvent } from "../src/voice/turn.js";

const FRAME = DEFAULT_TURN_CONFIG.frameMs;
const SPEECH = 0.92;
const QUIET = 0.04;

interface Step {
  ms: number;
  prob: number;
}

interface Timed {
  at: number;
  text?: string;
  agent?: AgentActivity;
  semantic?: number | null;
}

interface Stamped {
  at: number;
  ev: TurnEvent;
}

const speak = (ms: number, prob = SPEECH): Step => ({ ms, prob });
const quiet = (ms: number): Step => ({ ms, prob: QUIET });

/** Plays a plan of speech and silence into the controller, applying timed transcripts and agent changes as it goes. */
function drive(taker: TurnTaker, steps: Step[], timed: Timed[] = [], from = 0): { events: Stamped[]; end: number } {
  const events: Stamped[] = [];
  const pending = [...timed].sort((a, b) => a.at - b.at);
  let t = from;
  for (const step of steps) {
    for (let i = 0; i < Math.round(step.ms / FRAME); i++) {
      t += FRAME;
      while (pending.length > 0 && (pending[0] as Timed).at <= t) {
        const x = pending.shift() as Timed;
        if (x.text !== undefined) for (const ev of taker.transcript(t, x.text)) events.push({ at: t, ev });
        if (x.agent !== undefined) for (const ev of taker.setAgent(t, x.agent)) events.push({ at: t, ev });
        if (x.semantic !== undefined) taker.semanticEnd(x.semantic);
      }
      for (const ev of taker.frame(t, step.prob)) events.push({ at: t, ev });
    }
  }
  return { events, end: t };
}

const of = (events: Stamped[], type: TurnEvent["type"]): Stamped[] => events.filter((e) => e.ev.type === type);
const types = (events: Stamped[]): string[] => events.map((e) => e.ev.type);

describe("a turn that ends", () => {
  it("starts on the third frame of speech with the audio from before it, and ends on a pause after a finished sentence", () => {
    const taker = new TurnTaker();
    const lead = 40 * FRAME; // a whole number of frames of quiet first, more than the pre-roll
    const { events } = drive(taker, [quiet(lead), speak(1500), quiet(900)], [{ at: 1500, text: "What time is it?" }]);
    const start = of(events, "speech_start")[0] as Stamped;
    assert.ok(start, "a start");
    assert.equal(start.at, lead + 3 * FRAME);
    assert.equal((start.ev as { audioFrom: number }).audioFrom, lead - DEFAULT_TURN_CONFIG.preRollMs);
    const candidate = of(events, "end_candidate");
    assert.equal(candidate.length, 1);
    const end = of(events, "turn_end");
    assert.equal(end.length, 1);
    const e = (end[0] as Stamped).ev as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.reason, "complete");
    assert.equal(e.text, "What time is it?");
    assert.ok(e.silenceMs >= DEFAULT_TURN_CONFIG.silenceCompleteMs && e.silenceMs <= DEFAULT_TURN_CONFIG.silenceCompleteMs + FRAME);
    assert.ok((candidate[0] as Stamped).at < (end[0] as Stamped).at);
  });

  it("waits through a pause after a sentence that trails off, and keeps the turn when the person goes on", () => {
    const taker = new TurnTaker();
    const { events } = drive(
      taker,
      [speak(1200), quiet(1000), speak(1300), quiet(900)],
      [{ at: 1000, text: "I want to book a flight and" }, { at: 3600, text: "I want to book a flight and a hotel in Lisbon." }],
    );
    assert.equal(of(events, "end_candidate").length, 1, "only the real end looked like one");
    assert.equal(of(events, "speech_resume").length, 1);
    const ends = of(events, "turn_end");
    assert.equal(ends.length, 1, "one turn, not two");
    assert.equal(((ends[0] as Stamped).ev as { text: string }).text, "I want to book a flight and a hotel in Lisbon.");
  });

  it("gives up waiting on a thought that never comes back, after the long pause", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [speak(1000), quiet(2000)], [{ at: 800, text: "so what I was going to say is that" }]);
    const e = ((of(events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.reason, "incomplete");
    assert.ok(e.silenceMs >= DEFAULT_TURN_CONFIG.silenceIncompleteMs);
  });

  it("answers a one-word command fast", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [speak(500), quiet(700)], [{ at: 500, text: "stop" }]);
    const e = ((of(events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.reason, "command");
    assert.ok(e.silenceMs <= DEFAULT_TURN_CONFIG.silenceCommandMs + FRAME);
  });

  it("is in no hurry about words that do not say whether they are over, but is not slow either", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [speak(1000), quiet(1200)], [{ at: 900, text: "open the calendar" }]);
    const e = ((of(events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.reason, "unknown");
    assert.ok(e.silenceMs >= DEFAULT_TURN_CONFIG.silenceUnknownMs && e.silenceMs < DEFAULT_TURN_CONFIG.silenceIncompleteMs);
  });

  it("takes the word of a model that listened to the audio", () => {
    const fast = new TurnTaker();
    const a = drive(fast, [speak(1000), quiet(900)], [{ at: 900, text: "reserve a table" }, { at: 1100, semantic: 0.95 }]);
    const eFast = ((of(a.events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(eFast.reason, "model");
    assert.ok(eFast.silenceMs < DEFAULT_TURN_CONFIG.silenceUnknownMs);

    const slow = new TurnTaker();
    const b = drive(slow, [speak(1000), quiet(2000)], [{ at: 900, text: "What time is it?" }, { at: 1100, semantic: 0.1 }]);
    const eSlow = ((of(b.events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.ok(eSlow.silenceMs >= DEFAULT_TURN_CONFIG.silenceIncompleteMs, "a model that hears more to come holds the turn open");
  });

  it("ignores a click or a cough", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [quiet(300), speak(96), quiet(1500)]);
    assert.equal(of(events, "turn_end").length, 0);
    assert.equal(of(events, "noise").length, 1);
  });

  it("does not start on one or two frames of noise", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [quiet(300), speak(64), quiet(400), speak(64), quiet(400)]);
    assert.deepEqual(types(events), []);
  });

  it("ends a turn that never stops", () => {
    const taker = new TurnTaker();
    const { events } = drive(taker, [speak(DEFAULT_TURN_CONFIG.maxUtteranceMs + 400)], [{ at: 5000, text: "blah" }]);
    const e = ((of(events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.reason, "max-length");
  });

  it("says how long it has been quiet", () => {
    const taker = new TurnTaker();
    const { end } = drive(taker, [speak(800), quiet(2000)], [{ at: 700, text: "Hello there." }]);
    assert.ok(taker.quietForMs(end) >= 1400);
    drive(taker, [speak(300)], [], end);
    assert.equal(taker.quietForMs(end + 300), 0);
  });
});

describe("talking over the assistant", () => {
  it("lowers the voice at once and stops it when the words say stop", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(500), speak(900)], [{ at: 800, text: "wait a second" }]);
    const duck = of(events, "duck");
    assert.equal(duck.length, 1);
    assert.equal((duck[0] as Stamped).ev.type === "duck" && ((duck[0] as Stamped).ev as { on: boolean }).on, true);
    const barge = of(events, "barge_in")[0] as Stamped;
    assert.ok(barge, "an interruption");
    assert.equal((barge.ev as { reason: string }).reason, "keyword");
    assert.ok(barge.at - 500 <= 8 * FRAME + 64, `interrupted within ${barge.at - 500} ms of the first sound`);
    assert.ok((duck[0] as Stamped).at < barge.at, "ducked before it stopped");
    const start = of(events, "speech_start")[0] as Stamped;
    assert.ok(start && start.at === barge.at, "the person's turn begins where the interruption is confirmed");
  });

  it("lets sounds of listening pass and brings the voice back each time", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    // Two short sounds, each heard as "mm-hm" or "yeah" a moment after it starts.
    const { events } = drive(taker, [quiet(416), speak(416), quiet(608), speak(416), quiet(320)], [{ at: 416 + 256, text: "mm-hm" }, { at: 416 + 416 + 608 + 256, text: "yeah" }]);
    assert.equal(of(events, "barge_in").length, 0, "no interruption");
    assert.equal(of(events, "speech_start").length, 0, "and no turn begins");
    assert.equal(of(events, "backchannel").length, 2);
    const ducks = of(events, "duck").map((e) => (e.ev as { on: boolean }).on);
    assert.deepEqual(ducks, [true, false, true, false]);
  });

  it("does take the turn when a longer burst arrives with no words that are a sound of listening", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(416), speak(960)], [{ at: 416 + 256, text: "actually that's wrong" }]);
    assert.equal(of(events, "barge_in").length, 1);
  });

  it("is not moved by echo: a weak signal while the assistant speaks does nothing", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [speak(1500, 0.55)]);
    assert.deepEqual(types(events), []);
  });

  it("is moved by a strong, sustained sound even before any words arrive", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(300), speak(900)]);
    const barge = of(events, "barge_in")[0] as Stamped;
    assert.ok(barge);
    assert.ok(barge.at - 300 >= DEFAULT_TURN_CONFIG.bargeInNoTextMs);
    assert.ok(barge.at - 300 <= DEFAULT_TURN_CONFIG.bargeInNoTextMs + 3 * FRAME);
  });

  it("interrupts on words that are not a sound of listening, once they have lasted", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(300), speak(1500)], [{ at: 700, text: "no that is not what I meant" }]);
    const barge = of(events, "barge_in")[0] as Stamped;
    assert.ok(barge);
    assert.equal((barge.ev as { reason: string }).reason, "speech");
    const e = ((of(events, "turn_end")).length);
    assert.equal(e, 0, "the turn is still going: the person has not stopped");
  });

  it("carries what was heard during the interruption into the turn", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(200), speak(1200), quiet(900)], [{ at: 600, text: "stop" }, { at: 1300, text: "stop, I want the other one." }]);
    const e = ((of(events, "turn_end")[0] as Stamped).ev) as Extract<TurnEvent, { type: "turn_end" }>;
    assert.equal(e.text, "stop, I want the other one.");
  });

  it("does not read the tail of its own voice as the person starting", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(500), speak(300, 0.5), quiet(200)], [{ at: 704, agent: "idle" }]);
    assert.equal(of(events, "speech_start").length, 0);
    assert.equal(of(events, "barge_in").length, 0);
  });

  it("starts the person's turn just after the assistant stops, with the audio from before the grace", () => {
    const taker = new TurnTaker();
    taker.setAgent(0, "speaking");
    const { events } = drive(taker, [quiet(1000), speak(900, 0.9), quiet(1100)], [{ at: 1000, agent: "idle" }, { at: 1800, text: "okay thanks." }]);
    const start = of(events, "speech_start")[0] as Stamped;
    assert.ok(start);
    assert.ok(start.at >= 1000 + DEFAULT_TURN_CONFIG.postAgentGraceMs);
    assert.ok((start.ev as { audioFrom: number }).audioFrom <= 1000, "the first sounds are not lost to the grace");
    assert.equal(of(events, "turn_end").length, 1);
  });
});
