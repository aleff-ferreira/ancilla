/**
 * A small model on this computer as the talker of a call: a system text that never changes, seven tools it can choose among, and
 * a router that runs the few requests it does not choose a tool for (measured on 2026-11-17: "Qual é o status das tarefas?" and
 * "Remind me what the Liverpool project is about" never reached their tools with two 4B models). The calls here run on the
 * repo's doubles: a scripted model, a fake host, a virtual clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ToolCall, ToolSpec } from "../src/voice/brain.js";
import type { Persona, TaskMatch, ToolResult } from "../src/voice/host.js";
import { foldText, routeUtterance, type Route } from "../src/voice/pre-router.js";
import { buildSystemPrompt } from "../src/voice/prompt.js";
import { TalkerTurn } from "../src/voice/talker.js";
import { makeRig, type Rig } from "../src/voice/testing.js";
import { selectToolsForTurn, TALKER_TOOL_NAMES } from "../src/voice/tool-router.js";

const PERSONA: Persona = { name: "Vesper", callsUser: "Alex", language: null, tone: "Dry and brief.", voice: null };

describe("the system text of a call", () => {
  it("is the same a minute later, in another language, with another live state: only the context moves", () => {
    const noon = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));
    const later = new Date(noon.getTime() + 60_000);
    const a = buildSystemPrompt(PERSONA, noon, "en");
    const b = buildSystemPrompt(PERSONA, later, "pt", { codeSwitched: true, liveState: { activeModel: "Qwen3.5-4B", project: "atlas", recentSwitch: "Qwen3-4B" } });
    assert.equal(a.system, b.system, "what a server of this computer has read of it stays valid");
    assert.doesNotMatch(a.system, /local time|is speaking|mixed English|Live Call State/);
    assert.match(a.context, /^The local time is /);
    assert.notEqual(a.context, b.context, "the minute moved, and the context says so");
    assert.match(b.context, /The user is speaking Portuguese now\./);
    assert.match(b.context, /The user mixed English and Portuguese in this turn/);
    assert.match(b.context, /Live Call State.*Active Model=Qwen3\.5-4B.*Project=atlas.*Recent UI switch=Qwen3-4B/);
  });

  it("is still the persona's: another persona or another way of sounding is another text", () => {
    const noon = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));
    const base = buildSystemPrompt(PERSONA, noon, "en").system;
    assert.notEqual(buildSystemPrompt({ ...PERSONA, name: "Glad" }, noon, "en").system, base);
    assert.notEqual(buildSystemPrompt({ ...PERSONA, tone: null }, noon, "en").system, base);
    assert.match(base, /^You are Vesper, a personal assistant/);
    assert.match(base, /How you sound: Dry and brief\./);
  });
});

const spec = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object" } });
const names = (tools: readonly ToolSpec[]): string[] => tools.map((t) => t.name);
const MANY = ["delegate_task", "propose_change", "browse", "list_tasks", "task_status", "pause_task", "resume_task", "cancel_task", "recall", "list_threads", "read_thread", "inspect_project", "launch", "launch_status", "inspect_page"].map(spec);

describe("the tools of a talker", () => {
  it("are the seven it can choose among (and the connected accounts, while there are any), in the host's order, on every turn", () => {
    assert.deepEqual([...TALKER_TOOL_NAMES], ["delegate_task", "propose_change", "browse", "use_connector", "list_tasks", "task_status", "cancel_task", "recall"]);
    const talker = names(selectToolsForTurn("What is the plan for the release?", MANY, [], { talker: true }));
    assert.deepEqual(talker, ["delegate_task", "propose_change", "browse", "list_tasks", "task_status", "cancel_task", "recall"]);
    assert.deepEqual(names(selectToolsForTurn("Hello", MANY, [], { talker: true })), talker, "a greeting does not take them away: a changed tool list is a prompt read again");
    assert.deepEqual(names(selectToolsForTurn("Hello", MANY, [], { talker: true })), names(selectToolsForTurn("Hello", MANY, ["recall"], { talker: true })), "nor does what was used lately");
    const withAccounts = names(selectToolsForTurn("Check my repository", [...MANY, spec("use_connector")], [], { talker: true }));
    assert.ok(withAccounts.includes("use_connector"));
    assert.equal(withAccounts.length, 8, "the connected accounts are the eighth");
  });

  it("leave every other model as it was: all the tools, none for a greeting", () => {
    assert.equal(selectToolsForTurn("What is the plan for the release?", MANY, []).length, MANY.length);
    assert.deepEqual(selectToolsForTurn("Hello", MANY, []), []);
    assert.equal(selectToolsForTurn("Hello", MANY, ["recall"]).length, MANY.length);
  });

  it("are not taken from a host that offers none of them", () => {
    assert.deepEqual(names(selectToolsForTurn("Hello", [spec("lookup")], [], { talker: true })), ["lookup"]);
  });
});

const run = (tool: "list_tasks" | "task_status" | "recall", args: Record<string, string>): Route => ({ kind: "run", tool, args });
const ACTIVE = run("list_tasks", { filter: "active" });

describe("the words that run a tool before the model answers", () => {
  const cases: Array<[string, Route]> = [
    // the failures that were measured
    ["Qual é o status das tarefas?", ACTIVE],
    ["Remind me what the Liverpool project is about", run("recall", { query: "Remind me what the Liverpool project is about" })],
    // English
    ["What's the status of my tasks?", ACTIVE],
    ["How are the tasks going?", ACTIVE],
    ["Can you show me my tasks please", ACTIVE],
    ["What have you been working on?", ACTIVE],
    ["How is the auth refactor going?", run("task_status", { id: "auth refactor" })],
    ["Any update on the release notes?", run("task_status", { id: "release notes" })],
    ["Is that done?", run("task_status", { id: "last" })],
    ["Anything finished yet?", run("list_tasks", { filter: "done" })],
    ["What did I say about the invoices database?", run("recall", { query: "What did I say about the invoices database?" })],
    ["Do you remember my sister's name?", run("recall", { query: "Do you remember my sister's name?" })],
    ["What did we decide about the Frankfurt region", run("recall", { query: "What did we decide about the Frankfurt region" })],
    // Portuguese
    ["Como estão as tarefas?", ACTIVE],
    ["Quais tarefas estão rodando?", ACTIVE],
    ["Me mostra as tarefas", ACTIVE],
    ["O que você está fazendo agora?", ACTIVE],
    ["Como está a pesquisa de preços?", run("task_status", { id: "pesquisa de precos" })],
    ["Já terminou?", run("task_status", { id: "last" })],
    ["O que eu disse sobre o projeto Liverpool?", run("recall", { query: "O que eu disse sobre o projeto Liverpool?" })],
    ["Me lembra o que a gente combinou sobre o orçamento", run("recall", { query: "Me lembra o que a gente combinou sobre o orçamento" })],
    ["Você lembra do meu endereço?", run("recall", { query: "Você lembra do meu endereço?" })],
    // Spanish
    ["¿Cuál es el estado de las tareas?", ACTIVE],
    ["¿Qué tareas tengo?", ACTIVE],
    ["¿Cómo va la búsqueda de vuelos?", run("task_status", { id: "busqueda de vuelos" })],
    ["¿Ya terminó?", run("task_status", { id: "last" })],
    ["¿Qué te dije sobre el presupuesto?", run("recall", { query: "¿Qué te dije sobre el presupuesto?" })],
    ["¿Te acuerdas de lo que decidimos?", run("recall", { query: "¿Te acuerdas de lo que decidimos?" })],
    // asking to cancel: recognised, never run by this module
    ["Cancel that task", { kind: "cancel", ref: "last" }],
    ["Please cancel the auth refactor task", { kind: "cancel", ref: "auth refactor" }],
    ["Cancel the proposal please.", { kind: "cancel", ref: "last" }],
    ["Cancela essa tarefa", { kind: "cancel", ref: "last" }],
    ["Cancela a tarefa do login", { kind: "cancel", ref: "login" }],
    ["Cancela la tarea de los vuelos", { kind: "cancel", ref: "vuelos" }],
  ];
  for (const [text, want] of cases) {
    it(`routes ${JSON.stringify(text)}`, () => assert.deepEqual(routeUtterance(text), want));
  }

  const left: string[] = [
    "How's it going?",
    "How are you doing today?",
    "How are things going with you?",
    "Como vai você?",
    "Tudo bem? Como está?",
    "Remind me to call mom.",
    "Remind me to call Marcos tomorrow",
    "Me lembra de ligar para a minha mãe",
    "Recuérdame llamar a mamá",
    "What time is it?",
    "Tell me a joke",
    "Cancel my subscription",
    "Cancel that",
    "Stop talking",
    "I want that task to go faster",
    "Quero que você crie uma tarefa para pesquisar preços",
    "Fix the typo in the readme",
    "",
    "   ",
    "What is the status of this long and complicated question that goes on and on about something else entirely and then also asks for three other things at once",
  ];
  for (const text of left) {
    it(`leaves ${JSON.stringify(text.slice(0, 40))} to the model`, () => assert.deepEqual(routeUtterance(text), { kind: "none" }));
  }

  it("takes a yes or a no as the answer only while a question waits, and only when it is short", () => {
    assert.deepEqual(routeUtterance("Yes", true), { kind: "answer", yes: true });
    assert.deepEqual(routeUtterance("Sim, pode cancelar", true), { kind: "answer", yes: true });
    assert.deepEqual(routeUtterance("Sí, claro", true), { kind: "answer", yes: true });
    assert.deepEqual(routeUtterance("No, leave it", true), { kind: "answer", yes: false });
    assert.deepEqual(routeUtterance("Não, deixa", true), { kind: "answer", yes: false });
    assert.deepEqual(routeUtterance("Mejor no", true), { kind: "answer", yes: false });
    assert.deepEqual(routeUtterance("Yes", false), { kind: "none" }, "nothing was asked");
    assert.deepEqual(routeUtterance("Yes and also tell me everything about the migration plan for next quarter", true), { kind: "none" });
  });

  it("reads what a keyboard writes and what a recogniser writes the same", () => {
    assert.equal(foldText("  Qual é o STATUS, das tarefas?? "), "qual e o status das tarefas");
    assert.equal(foldText("What’s up"), "whats up");
    assert.deepEqual(routeUtterance("qual e o status das tarefas"), ACTIVE);
  });
});

describe("the turns of a call that run a tool first", () => {
  const ctx = { turn: 3, signal: new AbortController().signal };
  function host(options: { match?: TaskMatch; result?: ToolResult; fails?: boolean } = {}) {
    const calls: ToolCall[] = [];
    return {
      calls,
      runTool: async (call: ToolCall): Promise<ToolResult> => {
        calls.push(call);
        if (options.fails) throw new Error("the executive is gone");
        return options.result ?? { ok: true, text: "t1 | running | Weekly report" };
      },
      ...(options.match ? { findTask: () => options.match as TaskMatch } : {}),
    };
  }
  const ONE: TaskMatch = { kind: "one", id: "t1", title: "Weekly report" };
  const NOTHING = { rounds: [], say: null, ran: [], asked: null };
  /** What a call does with a question about cancelling: it is said, and once the person has heard it, it waits for the answer. */
  async function askAndHear(talker: TalkerTurn, h: ReturnType<typeof host>, text: string, lang: "en" | "pt" | "es" = "en") {
    const out = await talker.prepare(text, h, lang, ctx);
    if (out.asked) talker.arm(out.asked);
    return out;
  }

  it("hands the model what the tool said, as the calls the model would have made", async () => {
    const h = host();
    const out = await new TalkerTurn().prepare("Qual é o status das tarefas?", h, "pt", ctx);
    assert.equal(out.say, null);
    assert.equal(out.asked, null);
    assert.deepEqual(h.calls.map((c) => [c.name, c.arguments]), [["list_tasks", '{"filter":"active"}']]);
    assert.deepEqual(out.rounds, [
      { role: "assistant", content: "", toolCalls: [{ id: "route_1", name: "list_tasks", arguments: '{"filter":"active"}' }] },
      { role: "tool", toolCallId: "route_1", name: "list_tasks", content: "t1 | running | Weekly report" },
    ] satisfies ChatMessage[]);
    assert.deepEqual(out.ran, ["list_tasks -> t1 | running | Weekly report"]);
  });

  it("asks before it cancels, in the language of the call, and cancels only on a yes in the very next turn", async () => {
    for (const [lang, ask, done] of [
      ["en", /^Do you want me to cancel Weekly report\? Say yes to confirm\.$/, "Weekly report was cancelled."],
      ["pt", /^Quer que eu cancele Weekly report\? Diga sim para confirmar\.$/, "Weekly report foi cancelada."],
      ["es", /^¿Quieres que cancele Weekly report\? Di sí para confirmar\.$/, "Weekly report fue cancelada."],
    ] as const) {
      const h = host({ match: ONE });
      const talker = new TalkerTurn();
      const asked = await askAndHear(talker, h, "Cancel the weekly report task", lang);
      assert.match(asked.say ?? "", ask);
      assert.deepEqual(asked.asked, { id: "t1", title: "Weekly report" });
      assert.equal(h.calls.length, 0, "a request to cancel changes nothing by itself");
      const answered = await talker.prepare("Yes", h, lang, ctx);
      assert.equal(answered.say, done);
      assert.deepEqual(h.calls.map((c) => [c.name, c.arguments]), [["cancel_task", '{"id":"t1"}']]);
      assert.equal((await talker.prepare("Yes", h, lang, ctx)).say, null, "the question was answered once");
      assert.equal(h.calls.length, 1);
    }
  });

  it("leaves the task alone on a no, and on anything else, and forgets the question after one turn", async () => {
    const h = host({ match: ONE });
    const talker = new TalkerTurn();
    await askAndHear(talker, h, "Cancel that task");
    assert.equal((await talker.prepare("No, leave it", h, "en", ctx)).say, "All right, I will leave it as it is.");
    await askAndHear(talker, h, "Cancel that task");
    assert.deepEqual(await talker.prepare("What time is it?", h, "en", ctx), NOTHING, "anything else is a turn of its own");
    assert.deepEqual(await talker.prepare("Yes", h, "en", ctx), NOTHING, "and the question is gone");
    assert.equal(h.calls.length, 0, "nothing was cancelled");
  });

  it("does not take a yes for the answer to a question that was never heard", async () => {
    const h = host({ match: ONE });
    const talker = new TalkerTurn();
    const out = await talker.prepare("Cancel the weekly report task", h, "en", ctx);
    assert.ok(out.say && out.asked, "the question was made, and the call did not get as far as saying it");
    assert.deepEqual(await talker.prepare("Yes", h, "en", ctx), NOTHING);
    assert.equal(h.calls.length, 0, "a yes to some other question cancels nothing");
  });

  it("does not guess which task when there are several, and does nothing when it cannot tell", async () => {
    const several = host({ match: { kind: "many" } });
    const out = await new TalkerTurn().prepare("Cancel the proposal please", several, "en", ctx);
    assert.equal(out.say, null);
    assert.deepEqual(several.calls.map((c) => c.name), ["list_tasks"], "the model is given the list, and asks which");
    for (const h of [host({ match: { kind: "none" } }), host()]) {
      assert.deepEqual(await new TalkerTurn().prepare("Cancel the proposal please", h, "en", ctx), NOTHING);
      assert.equal(h.calls.length, 0);
    }
  });

  it("goes on without it when the tool cannot be run", async () => {
    assert.deepEqual(await new TalkerTurn().prepare("What's the status of my tasks?", host({ fails: true }), "en", ctx), NOTHING);
  });

  it("tells the model when a cancellation did not go through, instead of saying it did", async () => {
    const h = host({ match: ONE, result: { ok: false, text: "That task already finished." } });
    const talker = new TalkerTurn();
    await askAndHear(talker, h, "Cancel the weekly report task");
    const out = await talker.prepare("Yes", h, "en", ctx);
    assert.equal(out.say, null);
    assert.equal((out.rounds[1] as { content: string }).content, "That task already finished.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole call

const SENTENCES: Record<number, string> = {
  1: "What time is it?",
  2: "And what time is it now?",
  3: "Qual é o status das tarefas?",
  4: "Remind me what the Liverpool project is about",
  5: "Remind me to call mom.",
  6: "Cancel the weekly report task.",
  7: "Yes.",
  8: "No, leave it.",
  9: "Que horas são?",
  10: "Hello there.",
  11: "Yes, go ahead please.",
};

async function turn(rig: Rig, code: number, count: number): Promise<void> {
  await rig.client.speak(code, 1200);
  await rig.client.quiet(100);
  assert.ok(await rig.client.until(() => rig.client.of("speak_end").length >= count && rig.session.snapshot().agent === "idle", 30_000), `speech ended (${rig.client.of("speak_end").length} of ${count})`);
}

const lastUser = (messages: ChatMessage[]): string => (messages.filter((m) => m.role === "user").at(-1) as { content: string }).content;
const said = (rig: Rig): string => rig.tts.said.map((s) => s.text).join(" ");

describe("a call whose model is on this computer", () => {
  it("sends the same system text on every turn, a minute apart, and puts the time in front of the person's words", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Noon, more or less." }) });
    await turn(rig, 1, 1);
    await rig.sched.advance(60_000);
    await turn(rig, 2, 2);
    const [first, second] = rig.brain.requests;
    assert.ok(first && second);
    const system = (r: { messages: ChatMessage[] }): string => (r.messages[0] as { content: string }).content;
    assert.equal(system(first), system(second));
    assert.doesNotMatch(system(first), /local time/);
    const clock = (r: { messages: ChatMessage[] }): string | undefined => /The local time is ([^\n]*)\./.exec(lastUser(r.messages))?.[1];
    assert.ok(clock(first) && clock(second) && clock(first) !== clock(second), "each turn carries its own time");
    assert.ok(lastUser(first.messages).endsWith("What time is it?"), "and then what was said");
  });

  it("puts the language of the moment in front of the words too, so that a switch does not change the system text", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Ok." }) });
    await turn(rig, 1, 1);
    await turn(rig, 9, 2);
    const [english, portuguese] = rig.brain.requests;
    assert.ok(english && portuguese);
    assert.equal((english.messages[0] as { content: string }).content, (portuguese.messages[0] as { content: string }).content);
    assert.doesNotMatch(lastUser(english.messages), /speaking Portuguese/);
    assert.match(lastUser(portuguese.messages), /The user is speaking Portuguese now\./);
  });

  it("offers the seven tools on every turn, a greeting included", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Hi." }) });
    rig.host.toolList = MANY;
    await turn(rig, 10, 1);
    await turn(rig, 1, 2);
    const offered = rig.brain.requests.map((r) => names(r.tools));
    assert.deepEqual(offered[0], ["delegate_task", "propose_change", "browse", "list_tasks", "task_status", "cancel_task", "recall"]);
    assert.deepEqual(offered[1], offered[0]);
  });

  it("runs the status question itself, in Portuguese too, and the model answers from what came back", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Uma tarefa em andamento." }) });
    rig.host.toolList = MANY;
    rig.host.toolResult = { ok: true, text: "t1 | running | Weekly report | 1 of 3 steps" };
    await turn(rig, 3, 1);
    assert.deepEqual(rig.host.toolCalls.map((c) => [c.name, c.arguments]), [["list_tasks", '{"filter":"active"}']]);
    assert.equal(rig.brain.requests.length, 1, "one look of the model, not a round trip to choose the tool");
    const messages = (rig.brain.requests[0] as { messages: ChatMessage[] }).messages;
    assert.deepEqual(messages.slice(-2).map((m) => m.role), ["assistant", "tool"]);
    assert.equal((messages.at(-1) as { content: string }).content, "t1 | running | Weekly report | 1 of 3 steps");
    assert.equal(said(rig), "Uma tarefa em andamento.");
  });

  it("looks in the notes first when asked about the person's own things", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "I do not know." }) });
    rig.host.toolResult = { ok: true, text: "Nothing is remembered about that." };
    await turn(rig, 4, 1);
    assert.deepEqual(rig.host.toolCalls.map((c) => c.name), ["recall"]);
    assert.match(JSON.parse(rig.host.toolCalls[0]?.arguments ?? "{}").query, /Liverpool project is about/);
    const messages = (rig.brain.requests[0] as { messages: ChatMessage[] }).messages;
    assert.equal((messages.at(-1) as { content: string }).content, "Nothing is remembered about that.", "an empty answer reaches the model: it has nothing to invent from");
  });

  it("leaves a reminder to the model: only a question is a recall", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Noted." }) });
    await turn(rig, 5, 1);
    assert.equal(rig.host.toolCalls.length, 0);
    assert.equal((rig.brain.requests[0] as { messages: ChatMessage[] }).messages.at(-1)?.role, "user");
  });

  it("does not route a model that is not on this computer", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Ok." }) });
    Object.defineProperty(rig.brain, "capabilities", { value: { tools: true, speculative: false, local: false } });
    rig.host.toolList = MANY;
    await turn(rig, 3, 1);
    assert.equal(rig.host.toolCalls.length, 0, "it chooses its own tools");
    assert.equal((rig.brain.requests[0] as { tools: ToolSpec[] }).tools.length, MANY.length, "among all of them");
  });

  it("asks before cancelling a task, says so without a model, and cancels on the yes that follows", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "should never be asked" }) });
    Object.assign(rig.host, { findTask: (): TaskMatch => ({ kind: "one", id: "t1", title: "Weekly report" }) });
    rig.host.toolResult = { ok: true, text: "Cancelled: t1 | cancelled | Weekly report" };
    await turn(rig, 6, 1);
    assert.match(said(rig), /^Do you want me to cancel Weekly report\? Say yes to confirm\.$/);
    assert.equal(rig.host.toolCalls.length, 0, "nothing is cancelled by asking");
    assert.equal(rig.brain.requests.length, 0, "and no model was asked");
    await turn(rig, 7, 2);
    assert.deepEqual(rig.host.toolCalls.map((c) => [c.name, c.arguments]), [["cancel_task", '{"id":"t1"}']]);
    assert.match(said(rig), /Weekly report was cancelled\.$/);
    assert.equal(rig.brain.requests.length, 0);
    assert.deepEqual(rig.session.snapshot().history.map((m) => m.role), ["user", "assistant", "user", "assistant"], "both turns are in the conversation");
  });

  it("does not take a yes for the answer to a question the person never heard", async () => {
    // The voice takes six seconds to make its first sound, and the person speaks again, after the time in which it is the same turn
    // carried on, before it has: the question is dropped, and the words that follow are a turn of their own.
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "Noted." }), ttsLatencyMs: 6000 });
    Object.assign(rig.host, { findTask: (): TaskMatch => ({ kind: "one", id: "t1", title: "Weekly report" }) });
    await rig.client.speak(6, 1200);
    await rig.client.quiet(2500);
    await rig.client.speak(11, 1200);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.brain.requests.length >= 1 && rig.session.snapshot().agent === "idle", 60_000), `the yes was a turn of its own, answered by the model (heard: ${JSON.stringify(rig.client.of("user").map((m) => (m.msg as { text?: string }).text))})`);
    assert.equal(rig.host.toolCalls.length, 0, "a yes to some other question cancels nothing");
  });

  it("leaves the task running on a no", async () => {
    const rig = await makeRig({ sentences: SENTENCES, script: () => ({ ttftMs: 30, text: "should never be asked" }) });
    Object.assign(rig.host, { findTask: (): TaskMatch => ({ kind: "one", id: "t1", title: "Weekly report" }) });
    await turn(rig, 6, 1);
    await turn(rig, 8, 2);
    assert.equal(rig.host.toolCalls.length, 0);
    assert.match(said(rig), /All right, I will leave it as it is\.$/);
  });
});
