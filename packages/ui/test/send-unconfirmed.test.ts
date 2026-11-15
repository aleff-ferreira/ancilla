/**
 * A send that got no answer at all. The prompt may well have reached Muse, so the thread says it is checking, reads
 * the thread a bounded number of times, and settles on sent or not sent. It never sends the prompt a second time.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, type AncillaClient } from "../src/client.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { applyEvent, emptyFold } from "../src/model/fold.js";
import type { ThreadState } from "../src/model/store.js";
import type { TranscriptLoad, ViewEvent } from "../src/types.js";

/** What the check waits before each read of the thread, in order. */
const CHECKS_MS = [1_500, 3_500, 8_000, 15_000];

const NOT_REACHABLE = () => new AncillaError("The local Ancilla server is not reachable. Is it still running?", 0);
const TOO_SLOW = () => new AncillaError("The local Ancilla server took too long to answer.", 0);

function prompt(text: string, itemId = "u1", turnId = "t9"): ViewEvent {
  return { method: "item/completed", params: { item: { itemId, kind: "userMessage", status: "completed", revision: 1, turnId, commandId: turnId, text } } };
}

function transcript(events: ViewEvent[] = []): TranscriptLoad {
  return { session: null, msp: null, events, truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null };
}

class SendClient {
  sent: { sessionId: string; text: string; attachments?: unknown[] }[] = [];
  reads: ({ refresh?: boolean } | undefined)[] = [];
  /** What each send answers, oldest first; one left over repeats. */
  sends: (() => Promise<{ turnId: string | null; disposition: string | null }>)[] = [async () => ({ turnId: "t9", disposition: "started" })];
  transcript: () => Promise<TranscriptLoad> = async () => transcript();
  async sendTurn(sessionId: string, text: string, options?: { attachments?: unknown[] }) {
    this.sent.push({ sessionId, text, attachments: options?.attachments });
    const next = this.sends.length > 1 ? (this.sends.shift() as () => Promise<{ turnId: string | null; disposition: string | null }>) : (this.sends[0] as () => Promise<{ turnId: string | null; disposition: string | null }>);
    return next();
  }
  async loadTranscript(_sessionId: string, options?: { refresh?: boolean }) {
    this.reads.push(options);
    return this.transcript();
  }
  subscribe() {
    return () => {};
  }
}

/** A client that fails loudly for anything the test did not script, so a stray call cannot pass unnoticed. */
function clientOf(fake: SendClient): AncillaClient {
  return new Proxy(fake, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`the client was asked for ${String(property)}, which this test does not script`);
      };
    },
  }) as unknown as AncillaClient;
}

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

function rig() {
  const timers: Timer[] = [];
  const platform: Platform = {
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => "",
    writeHash: () => {},
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const timer: Timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as Timer).cancelled = true;
    },
    focused: () => false,
  };
  const fake = new SendClient();
  const controller = new AncillaController(clientOf(fake), platform);
  const thread: ThreadState = {
    load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(),
    attachments: [], shellRuns: [], researchRuns: [], stalled: false,
  };
  controller.store.set((s) => ({ ...s, threads: { ...s.threads, s1: thread } }));
  /** The pending waits that are the check's own, not a toast's. */
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired && CHECKS_MS.includes(t.ms));
  /** Lets the next wait pass, and the read it triggers finish. */
  const advance = async () => {
    const next = pending()[0];
    assert.ok(next, "a read of the thread was waiting");
    next.fired = true;
    next.fn();
    for (let tick = 0; tick < 40; tick += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  const state = () => controller.store.get();
  const echoes = () => state().threads["s1"]?.fold.echoes ?? [];
  const toasts = () => state().toasts.map((t) => t.title);
  return { controller, fake, timers, pending, advance, state, echoes, toasts };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("a send the server answered with an error", () => {
  it("is not sent: the toast says so, the text goes back, and nothing is checked", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw new AncillaError("The session is busy.", 409, "turnBusy"); }];
    assert.equal(await t.controller.retryTurn("s1", "hello"), false);
    assert.deepEqual(t.toasts(), ["Message not sent"]);
    assert.equal(t.echoes().length, 0);
    assert.equal(t.pending().length, 0);
    assert.equal(t.fake.reads.length, 0);
  });
});

describe("a send that got no answer", () => {
  for (const [label, failure] of [["times out", TOO_SLOW], ["cannot reach the server", NOT_REACHABLE]] as const) {
    it(`is unconfirmed while it checks, when it ${label}, and the composer is free at once`, async () => {
      const t = rig();
      t.fake.sends = [async () => { throw failure(); }];
      assert.equal(await t.controller.retryTurn("s1", "hello"), true, "the send hands back control straight away");
      assert.equal(t.echoes().length, 1);
      assert.equal(t.echoes()[0]?.disposition, "unconfirmed");
      assert.equal(t.echoes()[0]?.text, "hello");
      assert.ok(!t.toasts().includes("Message not sent"), "it does not claim the prompt was not sent");
      assert.deepEqual(t.pending().map((timer) => timer.ms), [CHECKS_MS[0]], "the first look is scheduled");
      assert.equal(t.fake.reads.length, 0, "and nothing has been read yet");
    });
  }

  it("settles as sent when the prompt shows up in the thread, and sends nothing again", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "hello");
    t.fake.transcript = async () => transcript([prompt("hello")]);
    await t.advance();
    assert.deepEqual(t.fake.reads, [{ refresh: true }], "the check only reads: one refresh read, no resume and no resend");
    assert.equal(t.echoes().length, 0, "the echo gives way to the saved prompt");
    assert.equal(Object.keys(t.state().threads["s1"]?.fold.items ?? {}).length, 1);
    assert.deepEqual(t.toasts(), [], "nothing is reported when it simply turned out fine");
    assert.equal(t.pending().length, 0, "and the check stops");
    assert.equal(t.fake.sent.length, 1, "the prompt was never sent a second time");
  });

  it("keeps checking, bounded, while the prompt is not there yet, and then says it was not sent", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "hello there");
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      assert.deepEqual(t.pending().map((timer) => timer.ms), [CHECKS_MS[round]], `look ${round + 1} is scheduled at its time`);
      assert.equal(t.echoes()[0]?.disposition, "unconfirmed", "still checking");
      await t.advance();
    }
    assert.equal(t.pending().length, 0, "there is no fifth look");
    assert.equal(t.fake.reads.length, CHECKS_MS.length);
    assert.ok(t.fake.reads.every((options) => options?.refresh === true));
    assert.equal(t.echoes().length, 0, "the echo is gone");
    assert.deepEqual(t.toasts(), ["Message not sent"]);
    assert.equal(t.state().draftHandoff?.key, "s1");
    assert.equal(t.state().draftHandoff?.text, "hello there", "the text is back in the composer");
    assert.equal(t.fake.sent.length, 1, "and nothing was resent on the way");
  });

  it("gives the files back with the text", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    const attachments = [{ name: "notes.txt", mediaType: "text/plain", base64: "aGk=" }];
    const previews = [{ name: "notes.txt", mediaType: "text/plain", kind: "file" as const, url: null }];
    await t.controller.retryTurn("s1", "read this", { attachments, previews });
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      await t.advance();
    }
    assert.deepEqual(t.state().draftHandoff?.attachments, attachments);
    assert.deepEqual(t.state().draftHandoff?.previews, previews);
  });

  it("says it could not confirm, rather than not sent, when the thread cannot be read at all", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw NOT_REACHABLE(); }];
    await t.controller.retryTurn("s1", "hello");
    t.fake.transcript = async () => { throw NOT_REACHABLE(); };
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      await t.advance();
    }
    assert.equal(t.pending().length, 0);
    assert.equal(t.echoes().length, 0, "the composer is never left waiting on it");
    assert.ok(!t.toasts().includes("Message not sent"), "it cannot know that, so it does not say it");
    assert.ok(t.toasts().some((title) => /confirm/i.test(title)), t.toasts().join(" | "));
    assert.equal(t.state().draftHandoff?.text, "hello", "the text is still given back");
    assert.equal(t.fake.sent.length, 1);
  });

  it("is settled as sent when the live stream delivers the prompt first", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "hello");
    t.controller.store.set((s) => {
      const thread = s.threads["s1"] as ThreadState;
      return { ...s, threads: { ...s.threads, s1: { ...thread, fold: applyEvent(thread.fold, prompt("hello")) } } };
    });
    assert.equal(t.echoes().length, 0, "the stream took the echo");
    await t.advance();
    assert.equal(t.fake.reads.length, 0, "so there was nothing left to read for");
    assert.deepEqual(t.toasts(), []);
    assert.equal(t.state().draftHandoff, null);
  });

  it("does not count a prompt that was already there, however alike it reads", async () => {
    const t = rig();
    t.controller.store.set((s) => {
      const thread = s.threads["s1"] as ThreadState;
      return { ...s, threads: { ...s.threads, s1: { ...thread, fold: applyEvent(thread.fold, prompt("continue", "old", "t1")) } } };
    });
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "continue");
    t.fake.transcript = async () => transcript([prompt("continue", "old", "t1")]);
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      await t.advance();
    }
    assert.deepEqual(t.toasts(), ["Message not sent"], "an older identical prompt does not stand in for the new one");
  });

  it("holds a repeat of the same send until it is settled, so Enter twice cannot send it twice", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "hello");
    assert.equal(await t.controller.retryTurn("s1", "hello"), true, "the repeat reports sent, as a duplicate Enter does");
    assert.equal(t.fake.sent.length, 1, "and goes nowhere");
    t.fake.transcript = async () => transcript([prompt("hello")]);
    await t.advance();
    t.fake.sends = [async () => ({ turnId: "t10", disposition: "started" })];
    assert.equal(await t.controller.retryTurn("s1", "hello"), true);
    assert.equal(t.fake.sent.length, 2, "once settled, a send of the same words is a new send again");
  });

  it("puts the text back only on request when the composer already holds something else", async () => {
    const draft: Record<string, string> = { "ancilla.draft.s1": "something I started typing" };
    (globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => draft[key] ?? null, setItem: () => {} } };
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "the lost one");
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      await t.advance();
    }
    assert.equal(t.state().draftHandoff, null, "what the person is typing is not overwritten");
    const toast = t.state().toasts.find((entry) => entry.title === "Message not sent");
    assert.ok(toast?.action, "the toast offers to put it back");
    toast.action.run();
    assert.equal(t.state().draftHandoff?.text, "the lost one");
  });

  it("stops looking when the controller is disposed", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "hello");
    assert.equal(t.pending().length, 1, "a look is waiting before the controller goes");
    assert.equal(t.echoes()[0]?.disposition, "unconfirmed");
    t.controller.dispose();
    assert.equal(t.pending().length, 0, "the waiting look was cancelled");
    assert.equal(t.timers.filter((timer) => timer.cancelled).length, 1, "by cancelling the wait, not by it never having existed");
    assert.equal(t.fake.reads.length, 0);
  });

  it("keeps the key held through the retry a host that lost the session makes, so Enter twice still sends once", async () => {
    const t = rig();
    t.fake.sends = [
      async () => { throw new AncillaError("The host does not hold that session.", 409, "sessionNotLoaded"); },
      async () => { throw TOO_SLOW(); },
    ];
    assert.equal(await t.controller.retryTurn("s1", "hello"), true, "the retry's own send is the one with no answer");
    assert.equal(t.fake.sent.length, 2, "the first try, then the retry after the session came back");
    assert.equal(t.echoes()[0]?.disposition, "unconfirmed");
    assert.equal(await t.controller.retryTurn("s1", "hello"), true, "the repeat reports sent");
    assert.equal(t.fake.sent.length, 2, "and goes nowhere while the retry is being checked");
    t.fake.transcript = async () => transcript([prompt("hello")]);
    await t.advance();
    t.fake.sends = [async () => ({ turnId: "t10", disposition: "started" })];
    assert.equal(await t.controller.retryTurn("s1", "hello"), true);
    assert.equal(t.fake.sent.length, 3, "once settled, the same words are a new send again");
  });
});

describe("a queued or steered send that got no answer", () => {
  /** A thread with a turn running, as it is when a person types the next prompt. */
  function withTurnRunning(t: ReturnType<typeof rig>): void {
    t.controller.store.set((s) => {
      const thread = s.threads["s1"] as ThreadState;
      return { ...s, threads: { ...s.threads, s1: { ...thread, fold: applyEvent(thread.fold, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }) } } };
    });
    assert.equal(t.state().threads["s1"]?.fold.activeTurnId, "live-1");
  }

  for (const [label, options, prepare] of [
    ["queued on request", { queue: true }, () => {}],
    ["sent while a turn runs", {}, withTurnRunning],
  ] as const) {
    it(`is never called not sent from a read of saved history, when it was ${label}`, async () => {
      const t = rig();
      prepare(t);
      t.fake.sends = [async () => { throw TOO_SLOW(); }];
      assert.equal(await t.controller.retryTurn("s1", "do this next", options), true);
      assert.equal(t.echoes()[0]?.disposition, "unconfirmed");
      // Muse holds a queued prompt until its turn starts, so the saved thread cannot show it however often it is read.
      t.fake.transcript = async () => transcript();
      for (let round = 0; round < CHECKS_MS.length; round += 1) {
        await t.advance();
      }
      assert.equal(t.fake.reads.length, CHECKS_MS.length, "it still looks, in case the prompt did start");
      assert.ok(!t.toasts().includes("Message not sent"), "an absence from the saved thread proves nothing for a held prompt");
      assert.deepEqual(t.toasts(), ["Could not confirm the message"]);
      const detail = t.state().toasts[0]?.detail ?? "";
      assert.match(detail, /queue/i, "it says to look at the queue");
      assert.equal(t.echoes().length, 0, "the composer is not left waiting");
      assert.equal(t.state().draftHandoff?.text, "do this next", "the text is given back");
      assert.equal(t.fake.sent.length, 1, "and nothing was resent");
    });
  }

  it("still settles as sent, silently, when the held prompt does show up", async () => {
    const t = rig();
    withTurnRunning(t);
    t.fake.sends = [async () => { throw TOO_SLOW(); }];
    await t.controller.retryTurn("s1", "do this next", { queue: true });
    t.fake.transcript = async () => transcript([prompt("do this next", "u2", "t10")]);
    await t.advance();
    assert.deepEqual(t.toasts(), []);
    assert.equal(t.echoes().length, 0);
    assert.equal(t.state().draftHandoff, null);
  });
});

describe("the toast for a check that could not read the thread", () => {
  it("names what went wrong, so the person is not left with only a guess", async () => {
    const t = rig();
    t.fake.sends = [async () => { throw NOT_REACHABLE(); }];
    await t.controller.retryTurn("s1", "hello");
    t.fake.transcript = async () => { throw new AncillaError("The session store is locked.", 500); };
    for (let round = 0; round < CHECKS_MS.length; round += 1) {
      await t.advance();
    }
    const toast = t.state().toasts.find((entry) => /confirm/i.test(entry.title));
    assert.match(toast?.detail ?? "", /session store is locked/, toast?.detail);
  });
});
