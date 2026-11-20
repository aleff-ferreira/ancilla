/**
 * The page's half of the spoken-interruption pilot: a voice that can be paused, keeps its place and the audio that arrives
 * meanwhile, goes on from the same sample, comes back by itself when nobody says more, and tells the server exactly how
 * much of the reply was heard; and a call that does what the server asks of it. The audio clock is moved by hand.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { PlaybackLedger, WebPlayer, type Player } from "../src/model/voice/player.js";
import type { ServerMessage } from "../src/model/voice/protocol.js";
import { CallSession, type CallIO, type MicHandle, type SocketLike } from "../src/model/voice/session.js";

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  startedAt: number | null;
  offset: number | null;
  stoppedAt: number | "now" | null;
  connect(): void;
  start(when: number, offset?: number): void;
  stop(when?: number): void;
  disconnect(): void;
}

function fakeContext(rate = 1000) {
  const sources: FakeSource[] = [];
  const gains: Array<[string, number, number?]> = [];
  /** The same automation with the time each step is for: when a ramp begins matters as much as what it ramps to. */
  const ramps: Array<{ kind: "value" | "target"; value: number; at: number }> = [];
  const clock = { now: 0, latency: 0 };
  const ctx = {
    get currentTime() {
      return clock.now;
    },
    get outputLatency() {
      return clock.latency;
    },
    baseLatency: 0,
    destination: {},
    createGain: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
      gain: {
        setTargetAtTime: (v: number, t: number, tc: number) => {
          gains.push(["target", v, tc]);
          ramps.push({ kind: "target", value: v, at: t });
        },
        setValueAtTime: (v: number, t: number) => {
          gains.push(["value", v]);
          ramps.push({ kind: "value", value: v, at: t });
        },
        cancelScheduledValues: () => void gains.push(["cancel", 0]),
      },
    }),
    createAnalyser: () => ({ fftSize: 512, connect: () => undefined, disconnect: () => undefined, getByteTimeDomainData: (a: Uint8Array) => a.fill(128) }),
    createBuffer: (_c: number, len: number, r: number) => {
      const ch = new Float32Array(len);
      return { getChannelData: () => ch, length: len, sampleRate: r };
    },
    createBufferSource: (): FakeSource => {
      const node: FakeSource = {
        buffer: null,
        onended: null,
        startedAt: null,
        offset: null,
        stoppedAt: null,
        connect: () => undefined,
        start(when, offset) {
          this.startedAt = when;
          this.offset = offset ?? 0;
        },
        stop(when) {
          this.stoppedAt = when ?? "now";
        },
        disconnect: () => undefined,
      };
      sources.push(node);
      return node;
    },
  } as unknown as AudioContext;
  void rate;
  return { ctx, sources, gains, ramps, clock };
}

const pcm = (n: number): Int16Array => new Int16Array(n);
/** Within one sample: the clock is in seconds and a sample is a thousandth, so the last one can round either way. */
const near = (actual: number | undefined, expected: number): boolean => actual !== undefined && Math.abs(actual - expected) <= 1;

describe("a voice that can be paused", () => {
  it("keeps the played samples of a ledger across a pause and moves what had not played yet", () => {
    const ledger = new PlaybackLedger(1000);
    ledger.schedule(1, 1000, 0.5, 0.5); // 1.0 to 2.0
    ledger.schedule(1, 1000, 0.5, 0.5); // 2.0 to 3.0
    assert.equal(ledger.played(1, 1.5), 500);
    ledger.shift(1.5, 0.7); // the voice was silent for 0.7 s
    assert.equal(ledger.played(1, 2.2), 500, "nothing was played while it was silent");
    assert.equal(ledger.played(1, 2.7), 1000);
    assert.equal(ledger.played(1, 3.2), 1500, "the second piece starts 0.7 s later than it was due");
    // what arrives next is scheduled after the shifted end
    assert.equal(ledger.schedule(1, 100, 0.0, 0.04), 3.7);
  });

  it("stops at once, says exactly how much was heard, and keeps hearing the same number whatever the clock does", () => {
    const { ctx, sources, gains, clock } = fakeContext();
    const player = new WebPlayer(ctx, 1000);
    player.enqueue(1, pcm(1000)); // 0.04 to 1.04
    player.enqueue(1, pcm(1000)); // 1.04 to 2.04
    clock.now = 0.5;
    const paused = player.pause?.(1500);
    // the fade is 30 ms: the sources stop at 0.53, 490 samples into the first
    assert.equal(paused?.utterance, 1);
    assert.ok(near(paused?.played, 490), `played ${paused?.played}`);
    assert.deepEqual(
      sources.map((s) => s.stoppedAt),
      [0.53, 0.53],
    );
    assert.ok(gains.some(([k, v]) => k === "target" && v === 0), "the voice is faded to nothing");
    clock.now = 5;
    assert.ok(near(player.played(1), 490));
    assert.equal(player.pause?.(1500), null, "a second pause only renews the lease");
    player.close();
  });

  it("goes on from the same sample, with what arrived meanwhile after it", () => {
    const { ctx, sources, clock } = fakeContext();
    const player = new WebPlayer(ctx, 1000);
    player.enqueue(1, pcm(1000));
    player.enqueue(1, pcm(1000));
    clock.now = 0.5;
    player.pause?.(60_000);
    player.enqueue(1, pcm(500)); // arrives while it is silent
    assert.equal(sources.length, 2, "nothing new is started while paused");
    clock.now = 3;
    player.resume?.();
    // two sources were started afresh and one for the held audio
    assert.equal(sources.length, 5);
    const [first, second, held] = sources.slice(2);
    assert.equal(first?.startedAt, 3.04, "at the lead after the clock");
    assert.ok(Math.abs((first?.offset ?? 0) - 0.49) < 1e-9, "490 samples in");
    assert.ok(Math.abs((second?.startedAt ?? 0) - 3.55) < 1e-9, "the second piece 2.51 s later than it was due, as the pause was");
    assert.equal(second?.offset, 0);
    assert.ok(Math.abs((held?.startedAt ?? 0) - 4.55) < 1e-9, "the held audio after the end of what was paused");
    clock.now = 3.34;
    assert.ok(near(player.played(1), 790), `0.3 s after it went on: ${player.played(1)}`);
    player.close();
  });

  it("fades in from the moment it goes on, not from the call that says so, so that it does not start with a click", () => {
    const { ctx, ramps, clock } = fakeContext();
    const player = new WebPlayer(ctx, 1000);
    player.enqueue(1, pcm(1000));
    clock.now = 0.5;
    player.pause?.(60_000);
    clock.now = 3;
    ramps.length = 0;
    player.resume?.();
    // the voice goes on a lead after the call (3.04): a ramp that began at 3 would be over before its first sample
    const fadeIn = ramps.find((r) => r.kind === "target" && r.value === 1);
    assert.ok(fadeIn !== undefined && fadeIn.at >= 3.04 - 1e-9, `the fade-in begins at ${fadeIn?.at}, when the voice does (3.04)`);
    assert.ok(ramps.some((r) => r.kind === "value" && r.value === 0 && r.at >= 3.04 - 1e-9), "and it is silent until then");
    player.close();
  });

  it("comes back by itself when nothing more is said, and a renewal gives it longer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { ctx, sources, clock } = fakeContext();
      const player = new WebPlayer(ctx, 1000);
      player.enqueue(1, pcm(1000));
      clock.now = 0.2;
      player.pause?.(100);
      mock.timers.tick(60);
      player.pause?.(100);
      mock.timers.tick(60);
      assert.equal(sources.length, 1, "still paused: the lease was renewed");
      mock.timers.tick(60);
      assert.equal(sources.length, 2, "the lease ran out and the voice went on by itself");
      player.close();
    } finally {
      mock.timers.reset();
    }
  });

  it("is cut off for good by stop, even while paused, and says what had been heard", () => {
    const { ctx, sources, gains, clock } = fakeContext();
    const player = new WebPlayer(ctx, 1000);
    player.enqueue(1, pcm(1000));
    clock.now = 0.34;
    player.pause?.(60_000);
    clock.now = 4;
    const stopped = player.stop();
    assert.equal(stopped.utterance, 1);
    assert.ok(near(stopped.played, 330), `heard ${stopped.played}`);
    assert.ok(gains.some(([k, v]) => k === "value" && v === 1), "the next reply is heard at full volume");
    player.enqueue(2, pcm(100));
    assert.equal(sources.length, 2, "a new reply is not held back by the old pause");
    assert.equal(player.pause?.(1500)?.utterance, 2);
    player.close();
  });

  it("does not touch a voice that is not paused: stop is what it always was", () => {
    const { ctx, gains, clock } = fakeContext();
    const player = new WebPlayer(ctx, 1000);
    player.enqueue(1, pcm(1000));
    clock.now = 0.34;
    const stopped = player.stop();
    assert.equal(stopped.utterance, 1);
    assert.ok(near(stopped.played, 300), `heard ${stopped.played}`);
    assert.deepEqual(gains.at(-1), ["target", 1, 0.04]);
    player.close();
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
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  texts(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class PausablePlayer implements Player {
  calls: string[] = [];
  playedNow = 0;
  utterance = 1;
  enqueue(): void {}
  played(): number {
    return this.playedNow;
  }
  current(): number {
    return this.utterance;
  }
  stop(): { utterance: number; played: number } {
    this.calls.push("stop");
    return { utterance: this.utterance, played: this.playedNow };
  }
  duck(): void {}
  pause(leaseMs: number): { utterance: number; played: number } | null {
    this.calls.push(`pause ${leaseMs}`);
    return { utterance: this.utterance, played: this.playedNow };
  }
  resume(): void {
    this.calls.push("resume");
  }
  level(): number {
    return 0;
  }
  close(): void {}
}

const READY: ServerMessage = { type: "ready", session: "c", sampleRate: 16000, engine: "fake", voice: "en:F1", lang: null, resumed: false };

function call(pausable: boolean) {
  const socket = new FakeSocket();
  const player = new PausablePlayer();
  const mic: MicHandle = { echoCancelled: true, stop() {} };
  const io: CallIO = {
    socketUrl: () => "ws://127.0.0.1:1/api/voice/ws",
    openSocket: () => socket,
    startMic: async () => mic,
    createPlayer: () => player,
    ...(pausable ? { pausable: true } : {}),
  };
  const session = new CallSession(io, { mode: "hands-free", lang: null, project: null });
  return { socket, player, session };
}

describe("a call that does what the server asks of the voice", () => {
  it("says in its hello that it can pause only when its speakers can", async () => {
    const a = call(true);
    await a.session.start();
    a.socket.open();
    assert.equal(a.socket.texts()[0]?.["pause"], true);
    const b = call(false);
    await b.session.start();
    b.socket.open();
    assert.equal("pause" in (b.socket.texts()[0] as object), false, "the hello of a page without it is the one it always sent");
    a.session.end();
    b.session.end();
  });

  it("pauses the voice, answers with exactly how much was heard, and goes on when told to", async () => {
    const { socket, player, session } = call(true);
    await session.start();
    socket.open();
    socket.say(READY);
    player.playedNow = 4321;
    socket.say({ type: "pause", utterance: 1, leaseMs: 1500 });
    assert.deepEqual(player.calls, ["pause 1500"]);
    assert.deepEqual(socket.texts().filter((m) => m["type"] === "playback").pop(), { type: "playback", utterance: 1, samples: 4321 });
    socket.say({ type: "resume", utterance: 1 });
    assert.deepEqual(player.calls, ["pause 1500", "resume"]);
    session.end();
  });

  it("cuts a paused voice off when the server says it was interrupted", async () => {
    const { socket, player, session } = call(true);
    await session.start();
    socket.open();
    socket.say(READY);
    socket.say({ type: "pause", utterance: 1, leaseMs: 1500 });
    socket.say({ type: "interrupted", utterance: 1, heard: "First," });
    assert.deepEqual(player.calls, ["pause 1500", "stop"]);
    session.end();
  });

  it("throws away what a paused voice holds when the server says the reply it belonged to is over", async () => {
    const { socket, player, session } = call(true);
    await session.start();
    socket.open();
    socket.say(READY);
    player.playedNow = 777;
    socket.say({ type: "pause", utterance: 1, leaseMs: 1500 });
    socket.say({ type: "resume", utterance: 1, drop: true });
    assert.deepEqual(player.calls, ["pause 1500", "stop"], "stopped, not resumed");
    assert.deepEqual(socket.texts().filter((m) => m["type"] === "playback").pop(), { type: "playback", utterance: 1, samples: 777 });
    session.end();
  });

  it("lets go of a paused voice when the connection drops", async () => {
    const { socket, player, session } = call(true);
    await session.start();
    socket.open();
    socket.say(READY);
    socket.say({ type: "pause", utterance: 1, leaseMs: 1500 });
    socket.onclose?.({ code: 1006, reason: "gone" });
    assert.equal(player.calls.at(-1), "stop");
    session.end();
  });
});
