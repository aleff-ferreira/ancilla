import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnTrace, percentile, summarize } from "../src/voice/metrics.js";
import { AUDIO_IN, MAX_AUDIO_FRAME_BYTES, decodeAudioOut, encodeAudioOut, parseAudioFrame, parseClientMessage } from "../src/voice/protocol.js";
import { SpokenLedger, wordsHeard } from "../src/voice/spoken.js";

describe("what the person heard", () => {
  const ledger = (): SpokenLedger => {
    const l = new SpokenLedger();
    l.add("Sure, I can do that.", 24_000);
    l.add("The meeting is on Thursday at three in the afternoon.", 48_000);
    l.add("Anything else?", 12_000);
    return l;
  };

  it("counts whole sentences as heard once their audio has played", () => {
    const l = ledger();
    assert.deepEqual(l.heard(0), { text: "", complete: false, segments: 0 });
    assert.deepEqual(l.heard(24_000), { text: "Sure, I can do that.", complete: false, segments: 1 });
    assert.equal(l.heard(84_000).complete, true);
    assert.equal(l.heard(10 ** 9).text, "Sure, I can do that. The meeting is on Thursday at three in the afternoon. Anything else?");
  });

  it("cuts inside a sentence at a word, and never says more than was likely heard", () => {
    const l = ledger();
    const half = l.heard(24_000 + 24_000).text; // half way through the second sentence
    assert.ok(half.startsWith("Sure, I can do that. The meeting is on"), half);
    assert.ok(!half.includes("afternoon"), half);
    const early = l.heard(24_000 + 1_000).text;
    assert.equal(early, "Sure, I can do that.");
  });

  it("treats a longer word as longer and a comma as a small pause", () => {
    assert.equal(wordsHeard("a b c d", 0.5), "a b");
    assert.equal(wordsHeard("I think, therefore I am", 0.2), "I");
    assert.equal(wordsHeard("one two three", 0), "");
    assert.equal(wordsHeard("one two three", 1), "one two three");
  });

  it("is not fooled by an empty ledger or an empty sentence", () => {
    const l = new SpokenLedger();
    l.add("", 100);
    l.add("hello", 0);
    assert.deepEqual(l.heard(5000), { text: "", complete: true, segments: 0 });
  });
});

describe("the wire", () => {
  it("parses the messages a client may send and nothing else", () => {
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hello", v: 1, mode: "hands-free", lang: "pt-BR", echoCancelled: true })), {
      type: "hello", v: 1, mode: "hands-free", lang: "pt-BR", echoCancelled: true, resume: null, thread: null, project: null,
    });
    assert.deepEqual(parseClientMessage('{"type":"playback","utterance":3,"samples":4800}'), { type: "playback", utterance: 3, samples: 4800 });
    assert.deepEqual(parseClientMessage('{"type":"interrupt","utterance":3,"samples":1}'), { type: "interrupt", utterance: 3, samples: 1 });
    assert.deepEqual(parseClientMessage('{"type":"text","text":"hello"}'), { type: "text", text: "hello" });
    assert.deepEqual(parseClientMessage('{"type":"mute","on":true}'), { type: "mute", on: true });
    assert.deepEqual(parseClientMessage('{"type":"ptt","down":false}'), { type: "ptt", down: false });
    assert.deepEqual(parseClientMessage('{"type":"end"}'), { type: "end" });
    assert.deepEqual(parseClientMessage('{"type":"ping","t":12}'), { type: "ping", t: 12 });
  });

  it("refuses what is not a message, or is the wrong shape, without throwing", () => {
    for (const bad of [
      "", "not json", "[]", "null", "42", '{"type":"nope"}', '{"type":1}', '{"type":"hello"}', '{"type":"hello","v":"1"}', '{"type":"playback","utterance":-1,"samples":1}',
      '{"type":"playback","utterance":1.5,"samples":1}', '{"type":"playback","utterance":1}', '{"type":"text","text":""}', '{"type":"text","text":"   "}', '{"type":"text","text":5}',
      '{"type":"mute","on":"yes"}', '{"type":"ping","t":-5}', JSON.stringify({ type: "text", text: "x".repeat(10_000) }),
    ]) assert.equal(parseClientMessage(bad), null, bad.slice(0, 40));
  });

  it("falls back to hands-free for an unknown mode and keeps the rest", () => {
    const m = parseClientMessage('{"type":"hello","v":1,"mode":"weird"}');
    assert.equal(m?.type === "hello" && m.mode, "hands-free");
  });

  it("reads microphone frames and refuses odd ones", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    const frame = Buffer.alloc(1 + pcm.length * 2);
    frame[0] = AUDIO_IN;
    pcm.forEach((v, i) => frame.writeInt16LE(v, 1 + i * 2));
    assert.deepEqual([...(parseAudioFrame(frame) as Int16Array)], [...pcm]);
    assert.equal(parseAudioFrame(Buffer.from([AUDIO_IN, 1, 2, 3])), null, "an odd number of bytes");
    assert.equal(parseAudioFrame(Buffer.from([0x09, 1, 2])), null, "not audio");
    assert.equal(parseAudioFrame(Buffer.alloc(MAX_AUDIO_FRAME_BYTES + 2)), null, "too long");
    assert.equal(parseAudioFrame(Buffer.from([AUDIO_IN])), null, "empty");
  });

  it("round-trips speech frames", () => {
    const pcm = new Int16Array([5, -5, 300, -300]);
    const out = decodeAudioOut(encodeAudioOut(7, 2, 96_000, pcm));
    assert.ok(out);
    assert.equal(out.utterance, 7);
    assert.equal(out.chunk, 2);
    assert.equal(out.firstSample, 96_000);
    assert.deepEqual([...out.pcm], [...pcm]);
    assert.equal(decodeAudioOut(Buffer.from([0x02, 0, 0])), null);
  });
});

describe("the clock of a turn", () => {
  it("measures each stage from the moment the person stopped", () => {
    const trace = new TurnTrace(4);
    trace.speechEnd = 1000;
    trace.turnEnd = 1480;
    trace.asrFinal = 1620;
    trace.firstToken = 1900;
    trace.firstAudio = 2150;
    assert.deepEqual(trace.snapshot(), { turn: 4, endpointMs: 480, asrMs: 620, firstTokenMs: 900, firstAudioMs: 1150, totalMs: 1150, bargeIn: false });
    assert.equal(new TurnTrace(5).snapshot().firstAudioMs, null);
  });

  it("takes percentiles by nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(v, 50), 50);
    assert.equal(percentile(v, 95), 95);
    assert.equal(percentile([], 50), null);
    assert.deepEqual(summarize([3, 1, 2]), { n: 3, p50: 2, p95: 3, max: 3 });
  });
});
