/**
 * The page's half of a voice call: the wire format (checked against the bytes the server writes), what the screen shows
 * as a function of what the server said, how much of the reply has been heard, the microphone worklet run as shipped
 * under a stand-in for the audio thread, and a whole call with a socket, a microphone and speakers that are doubles.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { emptyLine, initialCall, phaseLabel, reduceServer, withTyped, type CallView } from "../src/model/voice/callState.js";
import { CAPTURE_FRAME_SAMPLES, CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "../src/model/voice/capture.js";
import { PlaybackLedger, type Player } from "../src/model/voice/player.js";
import { AUDIO_IN, AUDIO_OUT, decodeAudioOut, encodeMicFrame, parseServerMessage, type ServerMessage } from "../src/model/voice/protocol.js";
import { micName } from "../src/model/voice/browser.js";
import { CallSession, type CallIO, type MicHandle, type MicState, type SocketLike } from "../src/model/voice/session.js";

// ---------------------------------------------------------------------------------------------------------------------

/** The bytes the server's `encodeAudioOut` writes, spelled out here so that the two halves are held to the same format. */
function serverAudioBytes(utterance: number, chunk: number, firstSample: number, pcm: number[]): ArrayBuffer {
  const out = Buffer.alloc(13 + pcm.length * 2);
  out[0] = 0x02;
  out.writeUInt32LE(utterance, 1);
  out.writeUInt32LE(chunk, 5);
  out.writeUInt32LE(firstSample, 9);
  pcm.forEach((v, i) => out.writeInt16LE(v, 13 + i * 2));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

describe("the wire format", () => {
  it("writes a microphone frame the way the server reads it", () => {
    const bytes = Buffer.from(encodeMicFrame(Int16Array.from([0, 1, -1, 32767, -32768])));
    assert.equal(bytes[0], AUDIO_IN);
    assert.equal(bytes.length, 1 + 10);
    assert.deepEqual([bytes.readInt16LE(1), bytes.readInt16LE(3), bytes.readInt16LE(5), bytes.readInt16LE(7), bytes.readInt16LE(9)], [0, 1, -1, 32767, -32768]);
  });

  it("reads what the server sends as speech, and rejects what is not", () => {
    const chunk = decodeAudioOut(serverAudioBytes(7, 3, 4800, [10, -10, 20]));
    assert.deepEqual(chunk && { u: chunk.utterance, c: chunk.chunk, f: chunk.firstSample, p: Array.from(chunk.pcm) }, { u: 7, c: 3, f: 4800, p: [10, -10, 20] });
    assert.equal(AUDIO_OUT, 2);
    assert.equal(decodeAudioOut(new ArrayBuffer(5)), null, "too short");
    const odd = new Uint8Array(14);
    odd[0] = 2;
    assert.equal(decodeAudioOut(odd.buffer), null, "a half sample");
    const wrong = new Uint8Array(15);
    wrong[0] = 9;
    assert.equal(decodeAudioOut(wrong.buffer), null, "not audio of this protocol");
  });

  it("shrugs off text that is not a message", () => {
    assert.equal(parseServerMessage("}{"), null);
    assert.equal(parseServerMessage("[]"), null);
    assert.equal(parseServerMessage('{"no":"type"}'), null);
    assert.deepEqual(parseServerMessage('{"type":"duck","on":true}'), { type: "duck", on: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const at = 1_000;
function play(view: CallView, ...messages: ServerMessage[]): CallView {
  return messages.reduce((v, m) => reduceServer(v, m, at), view);
}

describe("what the screen shows", () => {
  it("follows a turn from the first word to the reply", () => {
    let view = play(initialCall(), { type: "ready", session: "s", sampleRate: 44100, engine: "e", voice: "en:F1", lang: null, resumed: false }, { type: "state", state: "listening" });
    assert.equal(view.status, "ready");
    view = play(view, { type: "level", speaking: true }, { type: "partial", turn: 1, text: "what time" });
    assert.equal(view.partial, "what time");
    assert.equal(phaseLabel(view), "Hearing you");
    view = play(view, { type: "partial", turn: 1, text: "what time is it" }, { type: "user", turn: 1, text: "What time is it?", source: "voice" });
    assert.equal(view.partial, "", "the live words give way to the line");
    assert.deepEqual(view.lines.map((l) => [l.role, l.text]), [["user", "What time is it?"]]);
    view = play(view, { type: "state", state: "thinking" });
    assert.equal(phaseLabel(view), "Thinking");
    view = play(view, { type: "assistant", turn: 1, text: "It is", done: false }, { type: "assistant", turn: 1, text: "It is noon.", done: true }, { type: "state", state: "speaking" });
    assert.deepEqual(view.lines.map((l) => [l.role, l.text, l.done]), [["user", "What time is it?", true], ["assistant", "It is noon.", true]], "one line for the reply, grown in place");
    assert.equal(phaseLabel(view), "Speaking");
  });

  it("shows only what was heard of a reply that was cut off, and lowers the voice before it stops", () => {
    let view = play(initialCall(), { type: "ready", session: "s", sampleRate: 16000, engine: "e", voice: "v", lang: null, resumed: false }, { type: "user", turn: 1, text: "tell me", source: "voice" }, { type: "assistant", turn: 1, text: "First, open the settings page. Then pick the voice.", done: true }, { type: "state", state: "speaking" });
    view = play(view, { type: "duck", on: true });
    assert.equal(view.ducked, true);
    assert.equal(phaseLabel(view), "Listening…", "while it is ducked the face is listening");
    view = play(view, { type: "interrupted", utterance: 1, heard: "First, open the settings page." });
    const reply = view.lines.find((l) => l.role === "assistant");
    assert.equal(reply?.interrupted, true);
    assert.equal(reply?.heard, "First, open the settings page.");
    assert.equal(view.ducked, false);
  });

  it("merges a turn that was carried on, keeps tasks newest first, and notes an error that does not end the call", () => {
    let view = play(initialCall(), { type: "user", turn: 1, text: "remind me", source: "voice" }, { type: "user", turn: 1, text: "remind me to call Marcos", source: "voice" });
    assert.equal(view.lines.length, 1);
    assert.equal(view.lines[0]?.text, "remind me to call Marcos");
    view = play(view, { type: "task", id: "t1", title: "Changelog", status: "running", note: null }, { type: "task", id: "t2", title: "Tests", status: "running", note: null }, { type: "task", id: "t1", title: "Changelog", status: "completed", note: "done" });
    assert.deepEqual(view.tasks.map((t) => [t.id, t.status]), [["t1", "completed"], ["t2", "running"]]);
    view = play(view, { type: "error", code: "internal", message: "Something went wrong in the call; it goes on." });
    assert.notEqual(view.status, "failed");
    assert.match(view.notice?.text ?? "", /goes on/);
    view = play(view, { type: "error", code: "unavailable", message: "The voice is not installed yet." });
    assert.equal(view.status, "failed");
    assert.equal(view.error, "The voice is not installed yet.");
  });

  it("shows a typed line at once, with the next turn number, and ends on the server's word", () => {
    let view = play(initialCall(), { type: "user", turn: 3, text: "hello", source: "voice" });
    view = withTyped(view, "and then?");
    assert.deepEqual(view.lines.map((l) => [l.turn, l.source, l.text]), [[3, "voice", "hello"], [4, "text", "and then?"]]);
    view = play(view, { type: "ended", reason: "the client ended the call" });
    assert.equal(view.status, "ended");
    assert.equal(phaseLabel(view), "Call ended");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("what has been heard of a reply", () => {
  it("lays pieces end to end and counts the samples that have reached the speaker", () => {
    const ledger = new PlaybackLedger(1000);
    const a = ledger.schedule(1, 500, 10, 0.04);
    const b = ledger.schedule(1, 500, 10.1, 0.04);
    assert.equal(a, 10.04);
    assert.equal(b, 10.54, "the second piece starts where the first ends, with no gap");
    assert.equal(ledger.played(1, 10), 0, "nothing before it starts");
    assert.equal(ledger.played(1, 10.29), 250);
    assert.equal(ledger.played(1, 10.54), 500);
    assert.equal(ledger.played(1, 11.04), 1000, "all of it");
    assert.equal(ledger.played(1, 99), 1000, "never more than was sent");
    assert.equal(ledger.played(2, 11), 0, "another reply's samples are not counted");
    assert.ok(ledger.remaining(10.04) > 0.9);
  });

  it("says what was heard when it is cut, and starts afresh", () => {
    const ledger = new PlaybackLedger(1000);
    ledger.schedule(5, 2000, 0, 0);
    const cut = ledger.clear(0.75);
    assert.deepEqual(cut, { utterance: 5, played: 750 });
    assert.equal(ledger.remaining(0.75), 0);
    assert.equal(ledger.schedule(6, 100, 1, 0.04), 1.04, "the next reply is not queued behind the one that was cut");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** Runs the worklet exactly as it ships, in a context that has what the audio thread has: a sample rate and a processor registry. */
function loadWorklet(sampleRate: number) {
  const posted: Array<{ pcm: ArrayBuffer; rms: number; peak: number }> = [];
  type Node = { process(inputs: Float32Array[][]): boolean };
  const registered: { ctor: (new () => Node) | null } = { ctor: null };
  const sandbox = {
    sampleRate,
    Math,
    Float32Array,
    Int16Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (message: { pcm: ArrayBuffer; rms: number; peak: number }) => void posted.push(message) };
    },
    registerProcessor: (name: string, ctor: unknown) => {
      assert.equal(name, CAPTURE_PROCESSOR);
      registered.ctor = ctor as new () => Node;
    },
  };
  runInNewContext(CAPTURE_WORKLET_SOURCE, sandbox);
  assert.ok(registered.ctor, "the worklet registered itself");
  return { node: new (registered.ctor as new () => Node)(), posted };
}

/** The frequency of a stretch of samples, by counting where it crosses zero upwards. */
function frequencyOf(samples: Int16Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] as number) < 0 && (samples[i] as number) >= 0) crossings++;
  return (crossings * rate) / samples.length;
}

describe("the microphone worklet", () => {
  for (const rate of [48000, 44100]) {
    it(`turns ${rate} Hz into 16 kHz frames of 512 samples, keeping the pitch and the loudness`, () => {
      const { node, posted } = loadWorklet(rate);
      const seconds = 1;
      const total = rate * seconds;
      const input = new Float32Array(total);
      for (let i = 0; i < total; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
      // The browser hands the worklet 128 samples at a time.
      for (let i = 0; i + 128 <= total; i += 128) node.process([[input.subarray(i, i + 128)]]);
      assert.ok(posted.length >= 28 && posted.length <= 31, `about a second of frames, got ${posted.length}`);
      for (const frame of posted) assert.equal(new Int16Array(frame.pcm).length, CAPTURE_FRAME_SAMPLES);
      const middle = new Int16Array(posted[10]?.pcm as ArrayBuffer);
      const pitch = frequencyOf(middle, 16000);
      assert.ok(Math.abs(pitch - 440) < 25, `the pitch is kept: ${pitch.toFixed(0)} Hz`);
      const rms = posted[10]?.rms ?? 0;
      assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.03, `the level is kept: ${rms.toFixed(3)}`);
    });
  }

  it("does not let a tone above 8 kHz fold back into the speech range", () => {
    const { node, posted } = loadWorklet(48000);
    const total = 48000;
    const input = new Float32Array(total);
    // 14 kHz is inaudible to a speech recogniser, and would alias to 2 kHz at 16 kHz if it were not filtered out first.
    for (let i = 0; i < total; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 14000 * i) / 48000);
    for (let i = 0; i + 128 <= total; i += 128) node.process([[input.subarray(i, i + 128)]]);
    const rms = posted[12]?.rms ?? 1;
    assert.ok(rms < 0.02, `the alias is filtered out: ${rms.toFixed(4)}`);
  });

  it("is quiet when there is nothing to hear and survives a missing input", () => {
    const { node, posted } = loadWorklet(48000);
    assert.equal(node.process([]), true);
    assert.equal(node.process([[]]), true);
    for (let i = 0; i < 400; i++) node.process([[new Float32Array(128)]]);
    assert.ok(posted.length > 5);
    assert.ok(posted.every((p) => p.rms === 0));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | ArrayBuffer> = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  hear(bytes: ArrayBuffer): void {
    this.onmessage?.({ data: bytes });
  }
  texts(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  frames(): number {
    return this.sent.filter((s) => typeof s !== "string").length;
  }
}

class FakePlayer implements Player {
  queued: Array<{ utterance: number; samples: number }> = [];
  playedNow = 0;
  stopped = 0;
  ducked = false;
  closed = false;
  utterance = 0;
  enqueue(utterance: number, pcm: Int16Array): void {
    this.utterance = utterance;
    this.queued.push({ utterance, samples: pcm.length });
  }
  played(): number {
    return this.playedNow;
  }
  current(): number {
    return this.utterance;
  }
  stop(): { utterance: number; played: number } {
    this.stopped++;
    const out = { utterance: this.utterance, played: this.playedNow };
    this.queued = [];
    return out;
  }
  duck(on: boolean): void {
    this.ducked = on;
  }
  level(): number {
    return 0.4;
  }
  close(): void {
    this.closed = true;
  }
}

/** A microphone the browser reports on: a name, whether the system holds it muted, and word of when that changes. */
function reporting(options: { muted?: boolean; label?: string } = {}) {
  let listener: ((state: MicState) => void) | null = null;
  let muted = options.muted === true;
  return {
    label: options.label ?? "Desk microphone",
    muted: () => muted,
    watch(next: (state: MicState) => void) {
      listener = next;
    },
    become(state: MicState) {
      muted = state === "muted";
      listener?.(state);
    },
  };
}

function rig(options: { micFails?: Error; url?: string | null; mic?: Partial<MicHandle> } = {}) {
  const socket = new FakeSocket();
  const player = new FakePlayer();
  let feed: ((pcm: Int16Array, rms: number) => void) | null = null;
  const mic: MicHandle & { stopped: boolean } = { echoCancelled: true, stopped: false, stop() { this.stopped = true; }, ...options.mic };
  let disposed = 0;
  const io: CallIO = {
    socketUrl: () => (options.url === undefined ? "ws://127.0.0.1:1/api/voice/ws" : options.url),
    openSocket: () => socket,
    startMic: async (onFrame) => {
      if (options.micFails) throw options.micFails;
      feed = onFrame;
      return mic;
    },
    createPlayer: () => player,
    dispose: () => void disposed++,
  };
  const session = new CallSession(io, { mode: "hands-free", lang: null, project: "/work/atlas" });
  return { socket, player, mic, session, feed: (pcm: Int16Array, rms = 0.1) => feed?.(pcm, rms), disposed: () => disposed };
}

const READY: ServerMessage = { type: "ready", session: "call-1", sampleRate: 16000, engine: "fake", voice: "en:F1", lang: null, resumed: false };
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("a call, from the page", () => {
  it("says hello, sends the microphone once the server is ready, and plays the reply", async () => {
    const r = rig();
    await r.session.start();
    assert.equal(r.socket.binaryType, "arraybuffer");
    r.socket.open();
    const hello = r.socket.texts()[0] as Record<string, unknown>;
    assert.equal(hello.type, "hello");
    assert.equal(hello.v, 1);
    assert.equal(hello.project, "/work/atlas");
    assert.equal(hello.echoCancelled, true);
    r.feed(new Int16Array(512));
    assert.equal(r.socket.frames(), 0, "no audio goes out before the server has said it is ready");
    r.socket.say(READY);
    r.feed(new Int16Array(512));
    assert.equal(r.socket.frames(), 1);
    assert.equal(Buffer.from(r.socket.sent[r.socket.sent.length - 1] as ArrayBuffer)[0], AUDIO_IN);
    r.socket.hear(serverAudioBytes(1, 0, 0, [1, 2, 3, 4]));
    assert.deepEqual(r.player.queued, [{ utterance: 1, samples: 4 }]);
    r.player.playedNow = 3;
    await tick(260);
    const report = r.socket.texts().filter((m) => m.type === "playback").pop();
    assert.deepEqual(report, { type: "playback", utterance: 1, samples: 3 }, "the page says how much it has played");
    r.session.end();
    assert.equal(r.session.view.status, "ended");
    assert.equal(r.mic.stopped, true);
    assert.equal(r.player.closed, true);
    assert.equal(r.disposed() > 0, true, "the audio machinery is let go");
    assert.deepEqual(r.socket.texts().pop(), { type: "end" });
    assert.equal(r.socket.closed?.code, 1000);
  });

  it("mutes by not sending, cuts the voice when the person types or interrupts, and ducks when told", async () => {
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    r.session.setMuted(true);
    r.feed(new Int16Array(512));
    assert.equal(r.socket.frames(), 0, "a muted microphone sends nothing");
    assert.deepEqual(r.socket.texts().pop(), { type: "mute", on: true });
    r.session.setMuted(false);
    r.socket.hear(serverAudioBytes(2, 0, 0, new Array(100).fill(1)));
    r.player.playedNow = 40;
    r.socket.say({ type: "duck", on: true });
    assert.equal(r.player.ducked, true);
    r.session.sendText("  stop, wait  ");
    const texts = r.socket.texts();
    assert.deepEqual(texts.slice(-2), [{ type: "interrupt", utterance: 2, samples: 40 }, { type: "text", text: "stop, wait" }], "typing over the voice cuts it off, saying how much was heard");
    assert.equal(r.session.view.lines.pop()?.text, "stop, wait");
    r.socket.hear(serverAudioBytes(3, 0, 0, [1, 2]));
    r.socket.say({ type: "interrupted", utterance: 3, heard: "" });
    assert.equal(r.player.queued.length, 0, "when the server cuts the voice, the speakers are emptied");
    r.session.end();
  });

  it("goes on by text when the microphone is blocked, and says why", async () => {
    const r = rig({ micFails: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
    await r.session.start();
    assert.match(r.session.view.micProblem ?? "", /blocked/);
    r.socket.open();
    r.socket.say(READY);
    r.session.sendText("hello there");
    assert.deepEqual(r.socket.texts().pop(), { type: "text", text: "hello there" });
    r.session.end();
  });

  it("says so when the system holds the microphone muted, and lets go of the words when it is unmuted", async () => {
    const watched = reporting({ muted: true });
    const r = rig({ mic: watched });
    await r.session.start();
    assert.match(r.session.view.micProblem ?? "", /muted/, "a microphone that was muted before the call began is said at once");
    r.socket.open();
    r.socket.say(READY);
    assert.equal(phaseLabel(r.session.view), "Can't hear the microphone", "the face does not say it is listening");
    watched.become("live");
    assert.equal(r.session.view.micProblem, null, "unmuting needs nothing more");
    assert.equal(phaseLabel(r.session.view), "Listening");
    watched.become("muted");
    assert.match(r.session.view.micProblem ?? "", /muted/, "and muting it again is noticed");
    watched.become("ended");
    assert.match(r.session.view.micProblem ?? "", /stopped/, "a microphone that is lost says so, and to start the call again");
    r.session.end();
  });

  it("notices a microphone that gives nothing but silence, names it, and clears the words when sound comes", async () => {
    const r = rig({ mic: reporting({ label: "Microphone Array on SoundWire Device" }) });
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    const silence = new Int16Array(512);
    for (let i = 0; i < 189; i++) r.feed(silence, 0);
    assert.equal(r.session.view.micProblem, null, "a few seconds of quiet is only quiet");
    r.feed(silence, 0);
    assert.match(r.session.view.micProblem ?? "", /no sound at all from the microphone \(Microphone Array on SoundWire Device\)/);
    assert.equal(r.socket.frames() > 0, true, "the audio still goes to the server: the silence is the person's to fix, not ours to hold back");
    const speech = new Int16Array(512);
    speech[100] = 900;
    r.feed(speech, 0.05);
    assert.equal(r.session.view.micProblem, null, "the first real sound takes the words away");
    for (let i = 0; i < 100; i++) r.feed(silence, 0);
    assert.equal(r.session.view.micProblem, null, "and the count starts again from nothing");
    r.session.end();
  });

  it("does not call it a problem when the person muted the microphone themselves", async () => {
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    r.session.setMuted(true);
    for (let i = 0; i < 400; i++) r.feed(new Int16Array(512), 0);
    assert.equal(r.session.view.micProblem, null);
    assert.equal(phaseLabel(r.session.view), "Muted");
    r.session.end();
  });

  it("keeps saying why the microphone could not be opened, whatever else it learns", async () => {
    const r = rig({ micFails: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    assert.match(r.session.view.micProblem ?? "", /blocked/);
    assert.equal(phaseLabel(r.session.view), "Can't hear the microphone");
    r.socket.say({ type: "state", state: "thinking" });
    assert.equal(phaseLabel(r.session.view), "Thinking", "what the assistant is doing still shows while it works");
    r.session.end();
  });

  it("invites the person to speak, or to type when the microphone cannot be heard", () => {
    const ready = { ...initialCall(), status: "ready" as const };
    assert.equal(emptyLine(initialCall()), "…");
    assert.equal(emptyLine(ready), "Say something, or type below.");
    assert.equal(emptyLine({ ...ready, resumed: true }), "Back where you left off. Say something.");
    assert.match(emptyLine({ ...ready, micProblem: "The microphone is muted." }), /^Type below, or fix the microphone/);
    assert.match(emptyLine({ ...ready, resumed: true, micProblem: "The microphone is muted." }), /^Back where you left off\. Type below/);
  });

  it("names a microphone the way a person would", () => {
    assert.equal(micName("Default - Microphone Array on SoundWire Device (5- SoundWire Audio)"), "Microphone Array on SoundWire Device (5- SoundWire Audio)");
    assert.equal(micName("Communications - Headset (HUAWEI FreeBuds 6i Hands-Free)"), "Headset (HUAWEI FreeBuds 6i Hands-Free)");
    assert.equal(micName("USB Audio Device"), "USB Audio Device");
    assert.equal(micName(""), "");
  });

  it("holds push to talk to the button, and refuses to talk when it is off", async () => {
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    r.session.talk(true);
    assert.equal(r.socket.texts().filter((m) => m.type === "ptt").length, 0, "hands-free has no talk button");
    r.session.setMode("push-to-talk");
    r.session.talk(true);
    r.session.talk(false);
    assert.deepEqual(r.socket.texts().filter((m) => m.type === "ptt"), [{ type: "ptt", down: true }, { type: "ptt", down: false }]);
    r.session.end();
  });

  it("shows a pending launch authorization on the call view and sends the user's decision", async () => {
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    r.socket.say({
      type: "approval",
      request: {
        id: "auth_1",
        kind: "launch",
        title: "Launch in amazonia_river",
        detail: "npm run dev",
        allowLabel: "Launch",
        denyLabel: "Deny",
      },
    });
    assert.equal(r.session.view.approval?.id, "auth_1");
    assert.equal(r.session.view.approval?.allowLabel, "Launch");
    r.session.decide("auth_1", true);
    assert.equal(r.session.view.approval, null, "cleared optimistically on click");
    assert.deepEqual(
      r.socket.texts().filter((m) => m.type === "decide"),
      [{ type: "decide", id: "auth_1", allow: true }],
    );
    r.session.end();
  });

  it("tries again when the connection drops, and gives up with a reason when it does not come back", async () => {
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say(READY);
    r.socket.readyState = 3;
    r.socket.onclose?.({ code: 1006, reason: "" });
    assert.equal(r.session.view.status, "connecting");
    assert.match(r.session.view.notice?.text ?? "", /Reconnecting/);
    r.session.end();
  });

  it("fails plainly where there is no voice, and when the server says it is not installed", async () => {
    const none = rig({ url: null });
    await none.session.start();
    assert.equal(none.session.view.status, "failed");
    assert.match(none.session.view.error ?? "", /no voice/);
    const r = rig();
    await r.session.start();
    r.socket.open();
    r.socket.say({ type: "error", code: "unavailable", message: "The voice is not installed yet: speech recogniser missing." });
    r.socket.onclose?.({ code: 1011, reason: "unavailable" });
    assert.equal(r.session.view.status, "failed");
    assert.match(r.session.view.error ?? "", /not installed/);
    assert.equal(r.mic.stopped, true, "the microphone is let go when the call could not start");
  });
});
