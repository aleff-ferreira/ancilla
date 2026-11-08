/**
 * The call's mind when it is Muse: that it streams what Muse says and nothing else, goes on in the same thread, sends only
 * what is new, stops a turn that wants to act, and lets go when the person cuts it off. Muse is a double that answers with
 * the notifications a real thread sends.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrainEvent, ChatMessage } from "../src/voice/brain.js";
import { MuseThreadBrain, type MuseBrainHost } from "../src/voice/muse-brain.js";

type Handler = (method: string, params: Record<string, unknown>) => void;
type Script = (turn: number, emit: (method: string, params: Record<string, unknown>) => void, turnId: string) => void | Promise<void>;

class FakeMuse implements MuseBrainHost {
  sessions: Array<{ cwd: string; title: string }> = [];
  turns: Array<{ sessionId: string; text: string; displayText: string }> = [];
  interrupts: Array<{ sessionId: string; turnId: string }> = [];
  watching = 0;
  waiting = false;
  private handler: Handler | null = null;
  private count = 0;

  constructor(private readonly script: Script) {}

  async startSession(input: { cwd: string; account: string | null; title: string }): Promise<{ sessionId: string }> {
    this.sessions.push({ cwd: input.cwd, title: input.title });
    return { sessionId: `s${this.sessions.length}` };
  }
  async startTurn(input: { sessionId: string; text: string; displayText: string; commandId: string }): Promise<{ turnId: string }> {
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
    assert.match(sent, /Do not use any tools/);
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
