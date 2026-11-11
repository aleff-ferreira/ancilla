/**
 * The call's mind when it is Muse: that it streams what Muse says and nothing else, goes on in the same thread, sends only
 * what is new, stops a turn that wants to act, and lets go when the person cuts it off. Muse is a double that answers with
 * the notifications a real thread sends.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrainEvent, ChatMessage } from "../src/voice/brain.js";
import { makeBrain } from "../src/voice/brains.js";
import { MuseThreadBrain, type MuseBrainHost } from "../src/voice/muse-brain.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";

type Handler = (method: string, params: Record<string, unknown>) => void;
type Script = (turn: number, emit: (method: string, params: Record<string, unknown>) => void, turnId: string) => void | Promise<void>;

/** What Muse says of a thread its host has not loaded: every command to it is refused, as the real host does. */
const notLoaded = (sessionId: string) => Object.assign(new Error(`session ${sessionId} is not loaded on this host`), { kind: "sessionNotLoaded" });

class FakeMuse implements MuseBrainHost {
  sessions: Array<{ cwd: string; title: string; modelId?: string }> = [];
  /** The threads the host has loaded. A thread made here is; one from an earlier run of the host is not until it is opened. */
  loaded = new Set<string>();
  /** Every thread opened, in order. */
  opens: string[] = [];
  /** Whether an old thread can be opened: false is a thread that is gone, or held by another Muse client. */
  openable = true;
  /** Why opening a thread fails (the host cannot be reached), or null. */
  openFails: Error | null = null;
  /** Every thread put on a model after it was made. */
  switches: Array<{ sessionId: string; modelId: string }> = [];
  /** How many times a switch was asked for, refused or not. */
  switchTries = 0;
  /** Muse's reason for refusing a switch, or null when it takes it. */
  refuseSwitch: string | null = null;
  turns: Array<{ sessionId: string; text: string; displayText: string }> = [];
  interrupts: Array<{ sessionId: string; turnId: string }> = [];
  watching = 0;
  waiting = false;
  private handler: Handler | null = null;
  private count = 0;

  constructor(private readonly script: Script) {}

  async startSession(input: { cwd: string; account: string | null; title: string; modelId?: string | null }): Promise<{ sessionId: string }> {
    this.sessions.push({ cwd: input.cwd, title: input.title, ...(input.modelId ? { modelId: input.modelId } : {}) });
    const sessionId = `s${this.sessions.length}`;
    this.loaded.add(sessionId);
    return { sessionId };
  }
  async openSession(sessionId: string): Promise<boolean> {
    this.opens.push(sessionId);
    if (this.openFails) throw this.openFails;
    if (!this.openable) return false;
    this.loaded.add(sessionId);
    return true;
  }
  async setModel(sessionId: string, modelId: string): Promise<void> {
    if (!this.loaded.has(sessionId)) throw notLoaded(sessionId);
    this.switchTries++;
    if (this.refuseSwitch !== null) throw new Error(this.refuseSwitch);
    this.switches.push({ sessionId, modelId });
  }
  async startTurn(input: { sessionId: string; text: string; displayText: string; commandId: string }): Promise<{ turnId: string }> {
    if (!this.loaded.has(input.sessionId)) throw notLoaded(input.sessionId);
    this.turns.push({ sessionId: input.sessionId, text: input.text, displayText: input.displayText });
    const n = ++this.count;
    const turnId = `t${n}`;
    // Muse answers after it has taken the prompt, the way a thread does.
    setTimeout(() => void this.script(n, (method, params) => this.handler?.(method, { sessionId: input.sessionId, ...params }), turnId), 5);
    return { turnId };
  }
  async interruptTurn(sessionId: string, turnId: string): Promise<void> {
    this.interrupts.push({ sessionId, turnId });
  }
  needsUser(): boolean {
    return this.waiting;
  }
  watch(_sessionId: string, handler: Handler): () => void {
    this.watching++;
    this.handler = handler;
    return () => {
      this.watching--;
      this.handler = null;
    };
  }
  log(): void {}
}

const user = (content: string): ChatMessage => ({ role: "user", content });
const system: ChatMessage = { role: "system", content: "You are Vesper, a personal assistant." };

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const text = (events: BrainEvent[]): string => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const message = (id: string, turnId: string) => ({ itemId: id, kind: "agentMessage", turnId, status: "inProgress", revision: 1 });

describe("Muse as the call's mind", () => {
  it("streams the words of Muse's reply and ends when the turn does, telling the thread the rules of a call first", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("turn/started", { turnId });
      emit("item/started", { item: message("m1", turnId) });
      emit("item/delta", { itemId: "m1", delta: "It is " });
      emit("item/delta", { itemId: "m1", delta: "noon." });
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "It is noon." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const sessions: string[] = [];
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice with Vesper", onSession: (id) => sessions.push(id) });
    const events = await collect(brain.stream({ messages: [system, user("What time is it?")], tools: [], signal: new AbortController().signal }));
    assert.equal(text(events), "It is noon.", "what was streamed is not said again when the message completes");
    assert.deepEqual(events[events.length - 1], { type: "done", reason: "stop" });
    assert.deepEqual(muse.sessions, [{ cwd: "/work/atlas", title: "Voice with Vesper" }]);
    assert.deepEqual(sessions, ["s1"], "the conversation is told which thread it has");
    const sent = muse.turns[0]?.text ?? "";
    assert.match(sent, /live voice call/);
    assert.doesNotMatch(sent, /Do not use any tools/);
    assert.match(sent, /workspace tools/);
    assert.match(sent, /You are Vesper/);
    assert.match(sent, /What time is it\?$/);
    assert.equal(muse.turns[0]?.displayText, "Voice: What time is it?", "the thread shows what was said, not the rules");
    assert.equal(muse.watching, 0, "it stops listening when the turn is over");
  });

  it("goes on in the same thread, sends only what is new, and does not repeat the rules", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Sure." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice" });
    const first = [system, user("hello")];
    await collect(brain.stream({ messages: first, tools: [], signal: new AbortController().signal }));
    const second = [system, user("hello"), { role: "assistant", content: "Sure." } as ChatMessage, user("and now?")];
    await collect(brain.stream({ messages: second, tools: [], signal: new AbortController().signal }));
    assert.equal(muse.sessions.length, 1, "one thread for the conversation");
    assert.equal(muse.turns[1]?.sessionId, "s1");
    const sent = muse.turns[1]?.text ?? "";
    assert.match(sent, /and now\?/);
    assert.doesNotMatch(sent, /hello/, "Muse already has the first turn");
    assert.doesNotMatch(sent, /You are Vesper/, "and the rules");
    assert.match(sent, /^\(Voice call:/, "a short reminder of the style goes with each turn");
  });

  it("picks up a thread the conversation already had, without starting one or retelling the past", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Yes." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice", sessionId: "s-old" });
    const history: ChatMessage[] = [system, user("earlier question"), { role: "assistant", content: "earlier answer" }, user("a new one")];
    await collect(brain.stream({ messages: history, tools: [], signal: new AbortController().signal }));
    assert.equal(muse.sessions.length, 0);
    assert.equal(muse.turns[0]?.sessionId, "s-old");
    assert.doesNotMatch(muse.turns[0]?.text ?? "", /earlier question/);
  });

  it("tells a new thread what was said before in the conversation, so that a thread that is new to it is not blank", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Yes." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice" });
    const history: ChatMessage[] = [system, user("my sister is called Ana"), { role: "assistant", content: "Noted." }, user("what is her name?")];
    await collect(brain.stream({ messages: history, tools: [], signal: new AbortController().signal }));
    const sent = muse.turns[0]?.text ?? "";
    assert.match(sent, /Earlier in this conversation/);
    assert.match(sent, /User: my sister is called Ana/);
    assert.match(sent, /You: Noted\./);
    assert.match(sent, /what is her name\?$/);
  });

  it("says a message that was not streamed, and ignores what is not a message", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/started", { item: { itemId: "r1", kind: "reasoning", turnId, status: "inProgress" } });
      emit("item/delta", { itemId: "r1", delta: "let me think about the time zone" });
      emit("item/completed", { item: { itemId: "r1", kind: "reasoning", turnId, status: "completed", text: "let me think about the time zone" } });
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Three o'clock." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const events = await collect(brain.stream({ messages: [system, user("time?")], tools: [], signal: new AbortController().signal }));
    assert.equal(text(events), "Three o'clock.", "the thinking is not said");
  });

  it("holds a delta that arrives before its message is known, and says it once it is", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/delta", { itemId: "m1", delta: "Early " });
      emit("item/started", { item: message("m1", turnId) });
      emit("item/delta", { itemId: "m1", delta: "words." });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const events = await collect(brain.stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.equal(text(events), "Early words.");
  });

  it("ignores what an earlier turn of the thread is still saying", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { itemId: "old", kind: "agentMessage", turnId: "t-earlier", status: "completed", text: "An old answer." } });
      emit("turn/completed", { turnId: "t-earlier", terminal: "completed" });
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "The new answer." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const events = await collect(brain.stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.equal(text(events), "The new answer.");
  });

  it("stops a turn that wants to act, since a call cannot approve anything, and says where the request is", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      muse.waiting = true;
      emit("item/started", { item: { itemId: "c1", kind: "commandExecution", turnId, status: "inProgress" } });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const events = await collect(brain.stream({ messages: [system, user("delete the build folder")], tools: [], signal: new AbortController().signal }));
    const last = events[events.length - 1] as Extract<BrainEvent, { type: "error" }>;
    assert.equal(last.type, "error");
    assert.match(last.message, /needs your approval/);
    assert.equal(last.retryable, false);
    assert.deepEqual(muse.interrupts, [{ sessionId: "s1", turnId: "t1" }], "the turn was stopped, not left waiting");

    const asks = new FakeMuse((_n, emit) => emit("approval/requested", { approvalId: "a1" }));
    const second = await collect(new MuseThreadBrain({ host: asks, cwd: "/w", title: "v" }).stream({ messages: [system, user("do it")], tools: [], signal: new AbortController().signal }));
    assert.match((second[second.length - 1] as { message: string }).message, /approval/);
    assert.equal(asks.interrupts.length, 1);
  });

  it("keeps the turn alive and speaks the final answer when onApprovalRequested resolves a live approval", async () => {
    const requested: string[] = [];
    const resolved: string[] = [];
    let emitRef: ((method: string, params: Record<string, unknown>) => void) | null = null;
    let turnRef = "";
    const muse = new FakeMuse((_n, emit, turnId) => {
      emitRef = emit;
      turnRef = turnId;
      muse.waiting = true;
      emit("turn/started", { turnId });
      emit("item/started", { item: { itemId: "c1", kind: "commandExecution", turnId, status: "inProgress" } });
      emit("approval/requested", { approvalId: "ap_live_1", subject: { kind: "command", command: "npm run dev" } });
    });
    (muse as MuseBrainHost).onApprovalRequested = ({ params }) => {
      const id = String(params["approvalId"] ?? "");
      requested.push(id);
      setTimeout(() => {
        muse.waiting = false;
        emitRef?.("approval/resolved", { approvalId: id });
        emitRef?.("item/completed", { item: { ...message("m1", turnRef), status: "completed", text: "Started localhost on port 5173." } });
        emitRef?.("turn/completed", { turnId: turnRef, terminal: "completed" });
      }, 20);
    };
    (muse as MuseBrainHost).onApprovalResolved = (id) => resolved.push(id);

    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/amazonia_river", title: "Voice", idleMs: 80 });
    const events = await collect(brain.stream({ messages: [system, user("Launch localhost")], tools: [], signal: new AbortController().signal }));
    assert.deepEqual(requested, ["ap_live_1"]);
    assert.deepEqual(resolved, ["ap_live_1"]);
    assert.equal(muse.interrupts.length, 0, "turn is paused for approval, not interrupted");
    assert.ok(events.some((e) => e.type === "notice" && /approval/i.test(e.text)));
    assert.equal(text(events), "Started localhost on port 5173.");
    assert.deepEqual(events[events.length - 1], { type: "done", reason: "stop" });
  });

  it("lets go when the person cuts the call off, and says nothing more", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/started", { item: message("m1", turnId) });
      emit("item/delta", { itemId: "m1", delta: "First, " });
      // and then Muse goes on for a long time
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const abort = new AbortController();
    const events: BrainEvent[] = [];
    for await (const event of brain.stream({ messages: [system, user("explain")], tools: [], signal: abort.signal })) {
      events.push(event);
      if (event.type === "text") abort.abort();
    }
    assert.equal(text(events), "First, ");
    assert.equal(events.some((e) => e.type === "error" || e.type === "done"), false);
    assert.equal(muse.interrupts.length, 1, "Muse was told to stop");
    assert.equal(muse.watching, 0);
  });

  it("reports a turn that failed with Muse's own reason, and one that took too long", async () => {
    const failing = new FakeMuse((_n, emit, turnId) => emit("turn/completed", { turnId, terminal: "failed", error: { message: "the model is overloaded" } }));
    const failed = await collect(new MuseThreadBrain({ host: failing, cwd: "/w", title: "v" }).stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.deepEqual(failed[failed.length - 1], { type: "error", message: "the model is overloaded", retryable: true });
    const silent = new FakeMuse(() => undefined);
    const slow = await collect(new MuseThreadBrain({ host: silent, cwd: "/w", title: "v", idleMs: 60 }).stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.match((slow[slow.length - 1] as { message: string }).message, /too long/);
    assert.equal(silent.interrupts.length, 1);
  });

  it("explains a thread that could not be made or a prompt Muse would not take", async () => {
    const noSession = new FakeMuse(() => undefined);
    noSession.startSession = async () => {
      throw new Error("no Muse host for that folder");
    };
    const a = await collect(new MuseThreadBrain({ host: noSession, cwd: "/nowhere", title: "v" }).stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.match((a[0] as { message: string }).message, /Muse could not be reached: no Muse host/);
    const refuses = new FakeMuse(() => undefined);
    refuses.startTurn = async () => {
      throw new Error("the thread is busy");
    };
    const b = await collect(new MuseThreadBrain({ host: refuses, cwd: "/w", title: "v" }).stream({ messages: [system, user("hi")], tools: [], signal: new AbortController().signal }));
    assert.match((b[0] as { message: string }).message, /did not take that: the thread is busy/);
    assert.equal(refuses.watching, 0);
  });

  it("sends the result of a tool as the next turn of the thread", async () => {
    const muse = new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Done." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    await collect(brain.stream({ messages: [system, user("start a task")], tools: [], signal: new AbortController().signal }));
    const messages: ChatMessage[] = [system, user("start a task"), { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "delegate_task", arguments: "{}" }] }, { role: "tool", toolCallId: "c1", name: "delegate_task", content: "Started task t_1." }];
    await collect(brain.stream({ messages, tools: [], signal: new AbortController().signal }));
    const sent = muse.turns[1]?.text ?? "";
    assert.match(sent, /\[Result of delegate_task\] Started task t_1\./);
    assert.doesNotMatch(sent, /start a task/, "only what is new");
    assert.equal(muse.sessions.length, 1, "in the same thread");
  });
});

describe("Muse as the call's mind, on the model chosen for the voice", () => {
  const answers = () =>
    new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Sure." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
  const ask = (brain: MuseThreadBrain, ...said: string[]) => collect(brain.stream({ messages: [system, ...said.map(user)], tools: [], signal: new AbortController().signal }));

  it("starts the thread on that model, and does not ask again for one that began on it", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice", model: "muse-spark-1.3" });
    assert.equal(brain.label, "Muse (muse-spark-1.3)", "the call says which model answers");
    await ask(brain, "hello");
    await ask(brain, "and again");
    assert.deepEqual(muse.sessions, [{ cwd: "/work/atlas", title: "Voice", modelId: "muse-spark-1.3" }]);
    assert.deepEqual(muse.switches, [], "a thread made on the model needs no switch");
  });

  it("puts a thread the conversation already had on it, once, before the first turn", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/work/atlas", title: "Voice", sessionId: "s-old", model: "muse-wonder-1.0" });
    await ask(brain, "hello");
    await ask(brain, "and again");
    assert.equal(muse.sessions.length, 0, "no new thread");
    assert.deepEqual(muse.switches, [{ sessionId: "s-old", modelId: "muse-wonder-1.0" }], "one switch for the call");
    assert.equal(muse.turns.length, 2);
  });

  it("leaves a thread on its own model when none was chosen, and goes on where a host cannot switch", async () => {
    const plain = answers();
    const brain = new MuseThreadBrain({ host: plain, cwd: "/w", title: "v", sessionId: "s-old", model: null });
    assert.equal(brain.label, "Muse");
    await ask(brain, "hello");
    assert.deepEqual(plain.switches, []);
    // A host with no way to change a thread's model: the same double, without that one method.
    const inner = answers();
    const cannot: MuseBrainHost = {
      startSession: (input) => inner.startSession(input),
      openSession: (sessionId) => inner.openSession(sessionId),
      startTurn: (input) => inner.startTurn(input),
      interruptTurn: (sessionId, turnId) => inner.interruptTurn(sessionId, turnId),
      needsUser: () => inner.needsUser(),
      watch: (sessionId, handler) => inner.watch(sessionId, handler),
      log: () => undefined,
    };
    const events = await ask(new MuseThreadBrain({ host: cannot, cwd: "/w", title: "v", sessionId: "s-old", model: "muse-wonder-1.0" }), "hello");
    assert.equal(text(events), "Sure.", "a host that cannot switch answers on the model the thread has");
  });

  it("answers on the model the thread has, and says once why, when Muse will not put it on the model chosen", async () => {
    const muse = answers();
    muse.refuseSwitch = "That model is not offered.";
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v", sessionId: "s-old", model: "muse-wonder-1.0" });
    const first = await ask(brain, "hello");
    assert.deepEqual(first[0], { type: "notice", text: "Muse would not put this thread on muse-wonder-1.0: That model is not offered. It answers on the model the thread already has." });
    assert.equal(text(first), "Sure.", "an assistant that cannot change model still answers");
    assert.equal(muse.turns.length, 1);
    const second = await ask(brain, "and again");
    assert.equal(second.some((e) => e.type === "notice"), false, "said once, not at every turn");
    assert.equal(text(second), "Sure.");
    assert.equal(muse.switchTries, 1, "and not asked again for the rest of the call");
  });

  it("is told it cannot be reached when the thread cannot be opened, and tries the same thread again next turn", async () => {
    const muse = answers();
    muse.openFails = new Error("the Muse host is not running");
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v", sessionId: "s-old" });
    const refused = await ask(brain, "hello");
    assert.deepEqual(refused, [{ type: "error", message: "Muse could not be reached: the Muse host is not running", retryable: true }]);
    assert.equal(muse.turns.length, 0);
    muse.openFails = null;
    assert.equal(text(await ask(brain, "hello")), "Sure.");
    assert.deepEqual(muse.opens, ["s-old", "s-old"], "the thread was not given up on");
    assert.equal(muse.sessions.length, 0);
  });

  it("still tells the thread the rules of a call when its first attempt could not reach Muse", async () => {
    const muse = answers();
    const make = muse.startSession.bind(muse);
    let failures = 1;
    muse.startSession = async (input) => {
      if (failures-- > 0) throw new Error("no Muse host for that folder");
      return make(input);
    };
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    const first = await ask(brain, "hello");
    assert.match((first[0] as { message: string }).message, /could not be reached/);
    await ask(brain, "hello");
    assert.match(muse.turns[0]?.text ?? "", /live voice call/, "a refused attempt does not use up the rules");
  });

  it("is made from the settings: the model chosen for Muse goes to the thread", async () => {
    const muse = answers();
    const chosen = makeBrain({ ...DEFAULT_VOICE_SETTINGS, brain: { kind: "muse", model: "muse-spark-1.3" } }, { project: "/work/atlas", name: "Vesper", museSession: null, rememberMuseSession: () => undefined }, { museHost: muse, keyFor: () => null });
    assert.equal(chosen.problem, null);
    assert.equal(chosen.brain.label, "Muse (muse-spark-1.3)");
    await collect(chosen.brain.stream({ messages: [system, user("hello")], tools: [], signal: new AbortController().signal }));
    assert.equal(muse.sessions[0]?.modelId, "muse-spark-1.3");
    const none = answers();
    const unset = makeBrain(DEFAULT_VOICE_SETTINGS, { project: "/work/atlas", name: "Vesper", museSession: null, rememberMuseSession: () => undefined }, { museHost: none, keyFor: () => null });
    await collect(unset.brain.stream({ messages: [system, user("hello")], tools: [], signal: new AbortController().signal }));
    assert.equal("modelId" in (none.sessions[0] ?? {}), false, "Muse default names no model");
  });
});

describe("Muse as the call's mind, on a thread the conversation already had", () => {
  const answers = () =>
    new FakeMuse((_n, emit, turnId) => {
      emit("item/completed", { item: { ...message("m1", turnId), status: "completed", text: "Sure." } });
      emit("turn/completed", { turnId, terminal: "completed" });
    });
  const ask = (brain: MuseThreadBrain, ...said: string[]) => collect(brain.stream({ messages: [system, ...said.map(user)], tools: [], signal: new AbortController().signal }));

  it("loads the thread before it uses it, once for the whole call: a host that started again holds none", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v", sessionId: "s-old" });
    assert.equal(muse.loaded.has("s-old"), false, "the host knows nothing of it yet");
    assert.equal(text(await ask(brain, "hello")), "Sure.", "a thread the host does not hold is refused every command, so this answered only because it was loaded");
    await ask(brain, "and again");
    assert.deepEqual(muse.opens, ["s-old"]);
    assert.deepEqual(muse.turns.map((t) => t.sessionId), ["s-old", "s-old"]);
    assert.equal(muse.sessions.length, 0, "no new thread");
  });

  it("starts a new thread, told what was said before, when the old one cannot be used", async () => {
    const muse = answers();
    muse.openable = false;
    const remembered: string[] = [];
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v", sessionId: "s-gone", onSession: (id) => remembered.push(id) });
    const history: ChatMessage[] = [system, user("my sister is called Ana"), { role: "assistant", content: "Noted." }, user("what is her name?")];
    const events = await collect(brain.stream({ messages: history, tools: [], signal: new AbortController().signal }));
    assert.equal(text(events), "Sure.");
    assert.equal(muse.sessions.length, 1, "a new thread");
    assert.deepEqual(remembered, ["s1"], "the conversation is told which thread it has now");
    const sent = muse.turns[0]?.text ?? "";
    assert.equal(muse.turns[0]?.sessionId, "s1");
    assert.match(sent, /Earlier in this conversation/);
    assert.match(sent, /User: my sister is called Ana/);
    assert.match(sent, /live voice call/, "and the rules of a call");
    await ask(brain, "and now?");
    assert.deepEqual(muse.opens, ["s-gone"], "the old thread is not tried again");
    assert.equal(muse.turns[1]?.sessionId, "s1");
  });

  it("loads the thread again and tries once more when Muse says, in the middle of the call, that it is not loaded", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    await ask(brain, "hello");
    muse.loaded.delete("s1"); // the host started again: it holds nothing now
    assert.equal(text(await ask(brain, "are you there?")), "Sure.");
    assert.deepEqual(muse.opens, ["s1"]);
    assert.equal(muse.turns.length, 2);
  });

  it("knows a thread its host does not hold by the host's words too, whatever kind it gives the refusal", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    await ask(brain, "hello");
    muse.loaded.delete("s1");
    const take = muse.startTurn.bind(muse);
    muse.startTurn = async (input) => {
      if (!muse.loaded.has(input.sessionId)) throw new Error(`session ${input.sessionId} is not loaded on this host`); // no kind
      return take(input);
    };
    assert.equal(text(await ask(brain, "are you there?")), "Sure.");
    assert.deepEqual(muse.opens, ["s1"]);
  });

  it("does not try more than once, and says what Muse said", async () => {
    const muse = answers();
    const brain = new MuseThreadBrain({ host: muse, cwd: "/w", title: "v" });
    await ask(brain, "hello");
    muse.startTurn = async (input) => {
      throw notLoaded(input.sessionId);
    };
    const events = await ask(brain, "again");
    assert.deepEqual(events, [{ type: "error", message: "Muse did not take that: session s1 is not loaded on this host", retryable: true }]);
    assert.deepEqual(muse.opens, ["s1"], "one attempt to load it, one to send, no loop");
  });
});
