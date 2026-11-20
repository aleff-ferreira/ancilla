import type { SessionConfig } from "../src/voice/session.js";
import { makeRig, type Reply } from "../src/voice/testing.js";

/**
 * Whole calls on the test doubles, in virtual time, written down as what the call said, played and recorded. The same
 * scenarios run on any build of the voice code (this file imports nothing but the doubles), which is how the pilot's
 * claim, that with it off a call is exactly what version 0.30.0 made of it, is tested: the traces of that version are kept
 * in `fixtures/voice-golden-v0.30.0.json` and this build must write the same ones. To renew them, run this file's compiled
 * `runGolden` against a build of the version to hold to (see `scripts/voice/golden.mjs`).
 */

const SENTENCES: Record<number, string> = {
  1: "What time is it?",
  6: "Stop",
  7: "Yeah",
  8: "Tell me something else",
  9: "No, I meant Tuesday",
};
const LONG =
  "The weather in Lisbon tomorrow will be mostly sunny. A light breeze comes from the north. In the evening it cools down. " +
  "Bring a jacket if you plan to eat outside. On Thursday clouds roll in from the coast. Friday looks bright again.";

type Rig = Awaited<ReturnType<typeof makeRig>>;

export interface GoldenTrace {
  name: string;
  messages: Array<[number, string, unknown]>;
  audio: Array<[number, number, number]>;
  flights: unknown[];
  records: unknown[];
  history: unknown[];
  brainRequests: number;
  asrStreams: number;
  logs: string[];
}

/** What the person said: the message's `content` has the date and the state of the call in front of it (a weekday would match "Tuesday"). */
type Said = { role: string; content: string; rawUserText?: string };
const lastUser = (messages: ReadonlyArray<Said>): string => {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return m?.rawUserText ?? m?.content ?? "";
};

function script(m: ReadonlyArray<Said>): Reply {
  const said = lastUser(m);
  if (said.includes("Stop")) return { ttftMs: 200, text: "Okay." };
  if (said.includes("Tuesday")) return { ttftMs: 200, text: "Done. Tuesday it is." };
  if (said.includes("Yeah")) return { ttftMs: 200, text: "Right." };
  return { ttftMs: 250, text: LONG };
}

function capture(name: string, rig: Rig): GoldenTrace {
  const messages: Array<[number, string, unknown]> = [];
  for (const { at, msg } of rig.client.messages) {
    const { type, ...rest } = msg as { type: string } & Record<string, unknown>;
    // The level of the microphone is a detail of the double; everything else is what the call said.
    if (type !== "level") messages.push([at, type, rest]);
  }
  // The audio, in runs: which reply, how much, from when to when.
  const audio: Array<[number, number, number]> = [];
  let run: [number, number, number] | null = null;
  let lastAt = 0;
  for (const { at, msg } of rig.client.audioIn) {
    if (run && run[1] === msg.utterance) {
      run[2] += msg.samples;
    } else {
      if (run) audio.push(run);
      run = [at, msg.utterance, msg.samples];
    }
    lastAt = at;
  }
  if (run) audio.push(run);
  audio.push([lastAt, -1, 0]);
  return {
    name,
    messages,
    audio,
    flights: rig.flights.map((f) => ({ turn: f.turn, fate: f.fate, rules: f.rules, endReason: f.endReason, text: f.text, fragments: f.fragments })),
    records: rig.host.records.map((r) => ({ ...r })),
    history: rig.session.snapshot().history,
    brainRequests: rig.brain.requests.length,
    asrStreams: rig.asr.streams.length,
    logs: rig.logs,
  };
}

async function playing(rig: Rig): Promise<void> {
  await rig.client.speak(1, 900);
  await rig.client.quiet(100);
  await rig.client.until(() => rig.client.playbackActive, 5000);
}

type Setup = { config?: Partial<SessionConfig>; hello?: { pause?: boolean; echoCancelled?: boolean } };

const SCENARIOS: Array<[string, (rig: Rig) => Promise<void>]> = [
  ["ordinary turn", async (rig) => {
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 20_000);
  }],
  ["a stop word over the reply", async (rig) => {
    await playing(rig);
    await rig.client.quiet(2000);
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0 && rig.client.of("assistant").some((a) => a.msg.done && a.msg.text === "Okay."), 20_000);
  }],
  ["words over the reply that are not a stop", async (rig) => {
    await playing(rig);
    await rig.client.quiet(1500);
    await rig.client.speak(8, 1000);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 1, 20_000);
  }],
  ["a sound of listening over the reply", async (rig) => {
    await playing(rig);
    await rig.client.quiet(1500);
    await rig.client.speak(7, 400);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 40_000);
  }],
  ["the assistant's own echo", async (rig) => {
    await playing(rig);
    rig.client.echoAmp = 0.05;
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 40_000);
  }],
  ["a click while it speaks", async (rig) => {
    await playing(rig);
    await rig.client.quiet(1500);
    await rig.client.speak(40, 100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 40_000);
  }],
  ["speech resumed right after a turn", async (rig) => {
    await rig.client.speak(1, 600);
    await rig.client.quiet(600);
    await rig.client.speak(8, 600);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 30_000);
  }],
  ["a stop word with nothing to stop", async (rig) => {
    await rig.client.speak(6, 500);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 20_000);
  }],
  ["typed text over the reply", async (rig) => {
    await playing(rig);
    await rig.client.quiet(1000);
    rig.client.send({ type: "text", text: "Tuesday, please" });
    await rig.client.until(() => rig.client.of("speak_end").length > 0, 30_000);
  }],
];

export const GOLDEN_SCENARIO_NAMES: string[] = SCENARIOS.map(([name]) => name);

/** Runs every scenario on this build and writes down what happened. */
export async function runGolden(setup: Setup = {}): Promise<GoldenTrace[]> {
  const traces: GoldenTrace[] = [];
  for (const [name, run] of SCENARIOS) {
    const rig = await makeRig({
      sentences: SENTENCES,
      script,
      ...(setup.config ? { config: setup.config } : {}),
      ...(setup.hello ? { hello: setup.hello } : {}),
    });
    await run(rig);
    await rig.client.quiet(500);
    traces.push(capture(name, rig));
    await rig.session.close("scenario over");
  }
  return traces;
}
